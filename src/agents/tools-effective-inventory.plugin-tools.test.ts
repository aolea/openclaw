import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareGatewayPluginLoad } from "../gateway/server-plugin-bootstrap.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import { createPluginRegistryOwner, disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveEffectiveToolInventory,
} from "./tools-effective-inventory.js";

// Core shell/channel/media factories do not own this regression. Keep real
// plugin construction, prepared generations, provider projection, and grouping.
vi.mock("./agent-tools.js", async () => {
  const { resolveOpenClawPluginToolsForOptions } = await import("./openclaw-plugin-tools.js");
  return {
    createOpenClawCodingToolsInternal: (options?: OpenClawCodingToolsOptions) =>
      resolveOpenClawPluginToolsForOptions({
        options: { ...options, agentSessionKey: options?.sessionKey },
        resolvedConfig: options?.config,
      }),
  };
});

const provider = "dynamic-inventory-provider";
const providerPluginId = "dynamic-inventory-model";
const toolPluginId = "standalone-inventory-tool";
const modelId = "dynamic-only-model";
const toolName = "standalone_inventory_tool";

describe("dynamic-model effective plugin inventory", () => {
  it("keeps the Gateway's standalone V2 factory through projection and retires only the lease", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-inventory-plugin-tools-", layout: "split" },
      async (state) => {
        const providerRoot = state.path("provider");
        const toolRoot = state.path("tool");
        const emptyBundledRoot = state.path("empty-bundled");
        const agentDir = state.agentDir();
        const workspaceDir = state.workspaceDir;
        for (const dir of [providerRoot, toolRoot, emptyBundledRoot, agentDir, workspaceDir]) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const selected = createColdPluginFixture({
          rootDir: providerRoot,
          pluginId: providerPluginId,
          providerId: provider,
          manifest: {
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            modelCatalog: {
              discovery: { [provider]: "runtime" },
              providers: {
                [provider]: {
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:1/v1",
                  models: [{ id: modelId, name: "Dynamic inventory model", input: ["text"] }],
                },
              },
            },
          },
        });
        fs.writeFileSync(
          selected.runtimeSource,
          `module.exports = {
  id: ${JSON.stringify(providerPluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Dynamic inventory provider", auth: [],
      async prepareDynamicModel(ctx) {
        if (ctx.modelId !== ${JSON.stringify(modelId)}) return;
        return {
          id: ctx.modelId, name: "Dynamic inventory model", provider: ctx.provider,
          api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
          reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      },
      normalizeToolSchemas(ctx) { return ctx.tools; },
    });
  },
};\n`,
        );
        const standalone = createColdPluginFixture({
          rootDir: toolRoot,
          pluginId: toolPluginId,
          manifest: {
            activation: { onStartup: true },
            providers: [],
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            contracts: { tools: [toolName] },
          },
        });
        fs.writeFileSync(
          standalone.runtimeSource,
          `module.exports = {
  id: ${JSON.stringify(toolPluginId)},
  register(api) {
    api.registerTool({
      contextVersion: 2,
      create(ctx) {
        return {
          name: ${JSON.stringify(toolName)}, label: "Standalone inventory tool",
          description: "A nonoptional tool owned by the admitting Gateway.",
          parameters: { type: "object", properties: {} },
          async execute() {
            ctx.assertInvocationCurrent();
            throw new Error("Inventory must not execute tools");
          },
        };
      },
    }, { names: [${JSON.stringify(toolName)}] });
  },
};\n`,
        );
        const config: OpenClawConfig = {
          agents: { defaults: { model: `${provider}/${modelId}`, workspace: workspaceDir } },
          tools: { profile: "full" },
          plugins: {
            allow: [providerPluginId, toolPluginId],
            load: { paths: [providerRoot, toolRoot] },
            entries: {
              [providerPluginId]: { enabled: true },
              [toolPluginId]: { enabled: true },
            },
            slots: { memory: "none" },
          },
        };
        await withEnvAsync(
          {
            OPENCLAW_BUNDLED_PLUGINS_DIR: emptyBundledRoot,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
          async () => {
            await resetPreparedModelRuntimeSnapshotsForTest();
            clearPluginMetadataLifecycleCaches();
            try {
              // Gateway bootstrap publishes complete boot metadata before attaching runtime.
              const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
              setGatewayPluginMetadataSnapshot(metadata, {
                config,
                env: process.env,
                workspaceDir,
              });
              // The Gateway adapter binds complete metadata after the generic loader returns.
              const loaded = prepareGatewayPluginLoad({
                cfg: config,
                activationSourceConfig: config,
                pluginMetadataSnapshot: metadata,
                workspaceDir,
                pluginIds: [providerPluginId, toolPluginId],
                baseMethods: [],
                loadIntent: "startup",
                log: { info() {}, warn() {}, error() {}, debug() {} },
                logDiagnostics: false,
              });
              const gateway = loaded.pluginRegistry;
              let owner: ReturnType<typeof createPluginRegistryOwner> | undefined;
              try {
                activatePluginRegistry(gateway, null, "gateway-bindable", workspaceDir);
                owner = createPluginRegistryOwner(gateway, workspaceDir);
                expect(getPluginRuntimeLoadContext(gateway)?.metadataSnapshot).toBe(metadata);
                const gatewayCurrent = capturePluginLifecycleAuthority(gateway);
                const gatewayFactory = expectDefined(
                  gateway.tools.find((entry) => entry.pluginId === toolPluginId)?.factory,
                  "Gateway standalone factory",
                );
                await withPluginRuntimeRegistryScope(gateway, async () => {
                  const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
                    cfg: config,
                    agentId: "main",
                    agentDir,
                    workspaceDir,
                    modelProvider: provider,
                    modelId,
                  });
                  try {
                    const projected = acquired.run((context) => {
                      const registry = expectDefined(
                        getPluginRuntimeGenerationRegistry(),
                        "dynamic inventory generation",
                      );
                      return {
                        inventory: resolveEffectiveToolInventory({
                          cfg: config,
                          agentId: "main",
                          agentDir,
                          workspaceDir,
                          sessionKey: "agent:main:inventory-fixture",
                          sessionId: "inventory-fixture",
                          modelProvider: provider,
                          modelId,
                          modelApi: context.modelApi,
                          runtimeModel: context.runtimeModel,
                        }),
                        context,
                        factory: registry.tools.find((entry) => entry.pluginId === toolPluginId)
                          ?.factory,
                        metadata: getPluginRuntimeLoadContext(registry)?.metadataSnapshot,
                        current: capturePluginLifecycleAuthority(registry, undefined, {
                          scopedRuntime: true,
                        }),
                      };
                    });
                    expect(projected.inventory.groups.flatMap((group) => group.tools)).toEqual([
                      expect.objectContaining({
                        id: toolName,
                        source: "plugin",
                        pluginId: toolPluginId,
                      }),
                    ]);
                    expect(projected.context.runtimeModel).toMatchObject({ id: modelId, provider });
                    expect(projected.inventory.profile).toBe("full");
                    expect(projected.inventory.notices).toBeUndefined();
                    expect(projected.metadata?.plugins.map((plugin) => plugin.id)).toContain(
                      toolPluginId,
                    );
                    expect(projected.factory).toBe(gatewayFactory);
                    expect(projected.current?.()).toBe(true);
                    await acquired[Symbol.asyncDispose]();
                    expect(projected.current?.()).toBe(false);
                    expect(gatewayCurrent?.()).toBe(true);
                    expect(() => acquired.run(() => undefined)).toThrow("has been released");
                  } finally {
                    await acquired[Symbol.asyncDispose]();
                  }
                });
              } finally {
                loaded.retireGatewayRuntimeBindings();
                if (owner) {
                  const cleanup = await owner.close();
                  expect(cleanup.memoryErrors).toEqual([]);
                  expect(cleanup.pluginFailures).toEqual([]);
                } else {
                  const cleanup = await disposePluginRegistryInstances(gateway);
                  expect(cleanup.failures).toEqual([]);
                }
              }
            } finally {
              await resetPreparedModelRuntimeSnapshotsForTest();
              clearPluginMetadataLifecycleCaches();
              resetPluginLoaderTestStateForTest();
              cleanupPluginLoaderFixturesForTest();
            }
          },
        );
      },
    );
  });
});
