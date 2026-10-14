import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryGatewayOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import {
  makeModel,
  makeOpenClawConfigFixture,
} from "./embedded-agent-runner/model.test-harness.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveConfiguredModelCompat,
} from "./tools-effective-inventory.js";

const runtimeMocks = vi.hoisted(() => {
  const createLease = (owner: string) => {
    const authStorage = { owner };
    const modelRegistry = { owner };
    return {
      authStorage,
      modelRegistry,
      snapshot: {
        createStores: vi.fn(() => ({ authStorage, modelRegistry })),
      },
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
  };
  const requestLease = createLease("request");
  const publishedLease = createLease("published");
  return {
    acquire: vi.fn(async () => requestLease),
    publishedLease,
    requestLease,
    resolveModelAsync: vi.fn(async () => ({
      model: {
        id: "chat-latest",
        name: "chat-latest",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    })),
    staticCatalogModel: vi.fn(),
  };
});

vi.mock("../plugins/runtime/generation-scope.js", () => ({
  withPluginRuntimeGenerationScope: (_generation: unknown, run: () => unknown) => run(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireReadOnlyPreparedModelRuntime: runtimeMocks.acquire,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: runtimeMocks.resolveModelAsync,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: runtimeMocks.staticCatalogModel,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: () => undefined,
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agents/main/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
  resolveDefaultAgentDir: () => "/tmp/agents/main/agent",
  resolveSessionAgentId: () => "main",
}));

describe("acquireEffectiveToolInventoryRuntimeModelContext", () => {
  beforeEach(() => {
    runtimeMocks.acquire.mockReset().mockResolvedValue(runtimeMocks.requestLease);
    runtimeMocks.requestLease.snapshot.createStores.mockClear();
    runtimeMocks.publishedLease.snapshot.createStores.mockClear();
    runtimeMocks.resolveModelAsync.mockClear();
    runtimeMocks.requestLease[Symbol.asyncDispose].mockClear();
    runtimeMocks.publishedLease[Symbol.asyncDispose].mockClear();
    runtimeMocks.staticCatalogModel.mockReset();
  });

  it.each([
    { owner: "request-owned", agentId: "main", lease: runtimeMocks.requestLease },
    { owner: "published", agentId: "research", lease: runtimeMocks.publishedLease },
  ])("prepares dynamic model context with a $owner runtime lease", async ({ lease, agentId }) => {
    runtimeMocks.acquire.mockResolvedValueOnce(lease);
    const cfg = makeOpenClawConfigFixture();
    const agentDir = `/tmp/agents/${agentId}/agent`;
    const workspaceDir = `/tmp/workspace-${agentId}`;

    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg,
      agentId,
      agentDir,
      workspaceDir,
      modelProvider: " OpenAI ",
      modelId: " chat-latest ",
    });
    expect(acquired.run((context) => context)).toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "chat-latest", provider: "openai" },
    });
    expect(runtimeMocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "chat-latest",
      agentDir,
      cfg,
      {
        agentId,
        workspaceDir,
        authStorage: lease.authStorage,
        modelRegistry: lease.modelRegistry,
        preparedModelRuntime: lease.snapshot,
      },
    );
    expect(runtimeMocks.acquire).toHaveBeenCalledWith(
      {
        agentId,
        agentDir,
        config: cfg,
        workspaceDir,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "openai", modelId: "chat-latest", agentId }],
        allowGatewaySubagentBinding: true,
      },
      { catalogMode: "static" },
    );
    expect(lease[Symbol.asyncDispose]).not.toHaveBeenCalled();
    await acquired[Symbol.asyncDispose]();
    await acquired[Symbol.asyncDispose]();
    expect(lease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    expect(() => acquired.run(() => undefined)).toThrow("has been released");
  });

  it.each([
    "live",
    "unbound",
    "closing",
    "retired",
    "unactivated",
    "other-workspace",
    "changed-config",
    "superseded",
  ] as const)(
    "retains the Gateway tool scope only for an eligible current owner (%s)",
    async (state) => {
      const cfg = makeOpenClawConfigFixture();
      const workspaceDir = "/tmp/workspace-main";
      const metadata = createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir,
        manifestRegistry: makeRegistry([]),
      });
      const request = createEmptyPluginRegistry();
      const published = state === "superseded" ? createEmptyPluginRegistry() : request;
      const gatewayOwner = { current: () => (state === "closing" ? undefined : published) };
      if (state !== "unbound") {
        bindPluginRegistryGatewayOwner(request, gatewayOwner);
        if (published !== request) {
          bindPluginRegistryGatewayOwner(published, gatewayOwner);
        }
      }
      for (const registry of new Set([request, published])) {
        if (state !== "unactivated") {
          markPluginRegistryActive(registry);
        }
        setPluginRuntimeLoadContext(registry, {
          rawConfig: cfg,
          config: cfg,
          activationSourceConfig: cfg,
          autoEnabledReasons: {},
          workspaceDir: state === "other-workspace" ? "/tmp/other-workspace" : workspaceDir,
          env: process.env,
          metadataSnapshot: metadata,
          manifestRegistry: metadata.manifestRegistry,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
        });
      }
      if (state === "retired") {
        markPluginRegistryRetired(request);
      }
      const config = state === "changed-config" ? { ...cfg, plugins: { enabled: false } } : cfg;
      try {
        await withPluginRuntimeRegistryScope(request, async () => {
          await using _ = await acquireEffectiveToolInventoryRuntimeModelContext({
            cfg: config,
            agentId: "main",
            agentDir: "/tmp/agents/main/agent",
            workspaceDir,
            modelProvider: "openai",
            modelId: "chat-latest",
          });
        });
        expect(runtimeMocks.acquire).toHaveBeenCalledExactlyOnceWith(
          {
            agentId: "main",
            agentDir: "/tmp/agents/main/agent",
            config,
            workspaceDir,
            loadRuntimePlugins: state !== "live",
            runtimePluginSelections: [
              { provider: "openai", modelId: "chat-latest", agentId: "main" },
            ],
            allowGatewaySubagentBinding: true,
          },
          { catalogMode: "static" },
        );
        expect(runtimeMocks.requestLease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
      } finally {
        markPluginRegistryRetired(request);
        markPluginRegistryRetired(published);
      }
    },
  );

  it.each([
    { modelProvider: "", modelId: "chat-latest" },
    { modelProvider: "openai", modelId: " " },
  ])("skips runtime preparation for invalid model input", async (input) => {
    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg: {},
      ...input,
    });
    expect(acquired.run((context) => context)).toEqual({});
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it.each([
    ["prefixed sibling", "custom", "configured", "configured", "custom/configured"],
    ["case-distinct sibling", "custom", "configured", "configured", "Configured"],
    ["prefixed fallback", "custom", "configured", "custom/configured", undefined],
    ["case-insensitive fallback", "custom", "configured", "Configured", undefined],
    ["static alias", "xai", "grok-4.3-latest", "grok-4.3", undefined],
    ["exact provider key", "custom", "configured", "configured", undefined, "custom", "Custom"],
    ["provider case fallback", "custom", "configured", "configured", undefined, "Custom"],
    [
      "merged trimmed provider keys",
      "custom",
      "configured",
      "configured",
      undefined,
      " custom ",
      "custom",
    ],
  ] as const)(
    "uses configured model context without acquiring a runtime lease (%s)",
    async (
      _case,
      provider,
      modelId,
      rowId,
      siblingId,
      providerKey?: string,
      siblingProviderKey?: string,
    ) => {
      const configuredModel = {
        ...makeModel(rowId),
        name: "Configured",
        contextWindow: 8192,
        maxTokens: 1024,
        compat: { supportsTools: true },
      };
      const cfg = makeOpenClawConfigFixture({
        models: {
          providers: {
            ...(siblingProviderKey
              ? {
                  [siblingProviderKey]: {
                    baseUrl: "https://sibling.example.invalid",
                    api: "openai-completions" as const,
                    models: [
                      {
                        ...configuredModel,
                        name: "Sibling provider",
                        compat: { supportsTools: false },
                      },
                    ],
                  },
                }
              : {}),
            [providerKey ?? provider]: {
              baseUrl: "https://configured.example.invalid",
              api: "anthropic-messages",
              models: [
                ...(siblingId
                  ? [
                      {
                        ...configuredModel,
                        id: siblingId,
                        name: "Sibling",
                        api: "openai-completions" as const,
                        compat: { supportsTools: false },
                      },
                    ]
                  : []),
                configuredModel,
              ],
            },
          },
        },
      });

      const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
        cfg,
        modelProvider: provider,
        modelId,
      });
      expect(acquired.run((context) => context)).toMatchObject({
        modelApi: "anthropic-messages",
        runtimeModel: {
          id: modelId,
          name: "Configured",
          provider,
          compat: { supportsTools: true },
        },
      });
      expect(resolveConfiguredModelCompat({ cfg, modelProvider: provider, modelId })).toEqual({
        supportsTools: true,
      });
      expect(configuredModel.id).toBe(rowId);
      await acquired[Symbol.asyncDispose]();
      expect(runtimeMocks.acquire).not.toHaveBeenCalled();
      expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
      expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
    },
  );

  it("uses bundled model context without acquiring a runtime lease", async () => {
    runtimeMocks.staticCatalogModel.mockReturnValue({
      id: "bundled",
      name: "Bundled",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg: {},
      modelProvider: "openai",
      modelId: "bundled",
    });
    expect(acquired.run((context) => context)).toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "bundled", provider: "openai" },
    });
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it("releases the runtime lease when dynamic model resolution fails", async () => {
    const failure = new Error("dynamic model failed");
    runtimeMocks.resolveModelAsync.mockRejectedValueOnce(failure);

    await expect(
      acquireEffectiveToolInventoryRuntimeModelContext({
        cfg: {},
        modelProvider: "openai",
        modelId: "chat-latest",
      }),
    ).rejects.toBe(failure);
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
});
