import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
  MEMORY_AUTHORIZATION_CAPABILITY_NAMES,
  MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  createMemoryAuthorizationConformanceCases,
  evaluateMemoryAuthorizationConformanceScenario,
  hasCompleteMemoryAuthorizationCapabilities,
  isMemoryAuthorizationCapabilities,
  listMissingMemoryAuthorizationCapabilities,
  referenceMemoryAuthorizationConformanceAdapter,
  runMemoryAuthorizationConformanceSuite,
  type MemoryAccessContext,
  type AuthorizedMemoryMutation,
  type AuthorizedMemoryRuntime,
  type AuthorizedMemorySearchResult,
  type AuthorizedResourceHandle,
  type MemoryAuthorizationConformanceAdapter,
  type MemoryAuthorizationConformanceDecision,
} from "../../plugin-sdk/memory-authorization.js";
import * as memoryAuthorizationSdk from "../../plugin-sdk/memory-authorization.js";

function createSerializableContext(): MemoryAccessContext {
  return {
    version: 1,
    contextId: "context-1",
    contextFingerprint: "sha256:fingerprint",
    requestId: "request-1",
    runId: "run-1",
    agentId: "agent-a",
    sessionKey: "agent:agent-a:main",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    subject: {
      version: 1,
      kind: "user",
      principalId: "principal-owner",
      creationEvidence: { kind: "gateway-profile", revision: "creation-revision-1" },
    },
    actor: {
      kind: "principal",
      actorKind: "human",
      principalId: "principal-owner",
      assurance: "gateway-profile",
      evidenceRevision: "actor-revision-1",
    },
    verifiedPrincipals: [],
    delivery: {
      sinkKind: "private",
      audiences: [{ kind: "user", id: "principal-owner" }],
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "egress-revision-1",
      deliveryRevision: "delivery-revision-1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-facts-revision-1",
  };
}

describe("memory authorization SDK contract", () => {
  it("exports the complete narrow contract and conformance surface", () => {
    expect(Object.keys(memoryAuthorizationSdk)).toEqual(
      expect.arrayContaining([
        "COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES",
        "LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES",
        "MEMORY_AUTHORIZATION_CAPABILITY_NAMES",
        "MEMORY_AUTHORIZATION_CONTRACT_VERSION",
        "MEMORY_OPERATIONS",
        "createMemoryAuthorizationConformanceCases",
        "evaluateMemoryAuthorizationConformanceScenario",
        "hasCompleteMemoryAuthorizationCapabilities",
        "isMemoryAuthorizationCapabilities",
        "listMissingMemoryAuthorizationCapabilities",
        "referenceMemoryAuthorizationConformanceAdapter",
        "runMemoryAuthorizationConformanceSuite",
      ]),
    );
  });

  it("keeps serializable shapes free of in-process brands", () => {
    const context = createSerializableContext();
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- This test exercises JSON transport.
    const roundTrip = JSON.parse(JSON.stringify(context));

    expect(roundTrip).toEqual(context);
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
    expect(MEMORY_AUTHORIZATION_CONTRACT_VERSION).toBe(1);
  });

  it("validates exact backend capability declarations", () => {
    expect(isMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(
      true,
    );
    expect(
      hasCompleteMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toBe(true);
    expect(
      listMissingMemoryAuthorizationCapabilities(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toEqual([]);
    expect(
      listMissingMemoryAuthorizationCapabilities(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES),
    ).toEqual(MEMORY_AUTHORIZATION_CAPABILITY_NAMES);
    expect(isMemoryAuthorizationCapabilities({ version: 1 })).toBe(false);
    expect(
      isMemoryAuthorizationCapabilities({
        ...COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
        version: 2,
      }),
    ).toBe(false);
    expect(Object.isFrozen(COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES)).toBe(true);
  });

  it("makes authorized search results the exact-read continuation input", () => {
    type SearchResult = Awaited<
      ReturnType<AuthorizedMemoryRuntime["searchAuthorized"]>
    >["value"][number];
    type ReadHandle = Parameters<AuthorizedMemoryRuntime["readAuthorized"]>[0]["handle"];

    expectTypeOf<SearchResult>().toEqualTypeOf<AuthorizedMemorySearchResult>();
    expectTypeOf<SearchResult["resourceHandle"]>().toEqualTypeOf<AuthorizedResourceHandle>();
    expectTypeOf<SearchResult["resourceHandle"]>().toEqualTypeOf<ReadHandle>();
  });

  it("keeps placement selection inside the authorized plan", () => {
    type HasRawPlacementOrDestination<T> = T extends unknown
      ? "placementHandle" extends keyof T
        ? true
        : "destinationHandle" extends keyof T
          ? true
          : false
      : never;

    expectTypeOf<HasRawPlacementOrDestination<AuthorizedMemoryMutation>>().toEqualTypeOf<false>();
  });
});

describe("memory authorization conformance suite", () => {
  it("passes the deterministic reference evaluator", async () => {
    await expect(
      runMemoryAuthorizationConformanceSuite(referenceMemoryAuthorizationConformanceAdapter),
    ).resolves.toEqual({ ok: true, failures: [] });
  });

  it("generates every Phase 0 policy invariant", () => {
    const cases = createMemoryAuthorizationConformanceCases();
    expect(cases.map((entry) => entry.id)).toEqual([
      "deny-precedence",
      "permission-implication",
      "permission-complete",
      "principal-revoked-retains-context-ref",
      "principal-expired",
      "principal-expiry-missing",
      "principal-missing",
      "principal-revision-mismatch",
      "principal-duplicate-ref",
      "principal-duplicate-host-fact",
      "membership-required-valid",
      "membership-required-expired",
      "membership-required-expiry-missing",
      "membership-required-revoked",
      "membership-required-removed",
      "membership-required-revision-mismatch",
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
      "membership-required-duplicate-ref",
      "membership-required-duplicate-host-fact",
      "membership-required-principal-not-directly-verified",
      "membership-unrelated-stale-is-harmless",
      "cross-agent-cell",
      "plan-context-revision",
      "plan-run-binding",
      "plan-session-binding",
      "plan-expiry",
      "plan-expiry-missing",
      "plan-host-facts-revision",
      "delivery-audience-intersection",
      "delegation-intersection",
      "lineage-requirements",
      "prefilter-superset",
    ]);
    expect(
      Object.fromEntries(cases.map((entry) => [entry.id, entry.expected["resource-a"]])),
    ).toMatchObject({
      "deny-precedence": { allowed: false, reasonCode: "explicit-deny" },
      "permission-implication": { allowed: false, reasonCode: "default-deny" },
      "permission-complete": { allowed: true, reasonCode: "allowed" },
      "principal-revoked-retains-context-ref": {
        allowed: false,
        reasonCode: "identity-revoked",
      },
      "principal-expired": { allowed: false, reasonCode: "identity-revoked" },
      "principal-expiry-missing": { allowed: false, reasonCode: "identity-revoked" },
      "principal-missing": { allowed: false, reasonCode: "identity-revoked" },
      "principal-revision-mismatch": { allowed: false, reasonCode: "identity-revoked" },
      "principal-duplicate-ref": { allowed: false, reasonCode: "identity-revoked" },
      "principal-duplicate-host-fact": { allowed: false, reasonCode: "identity-revoked" },
      "membership-required-valid": { allowed: true, reasonCode: "allowed" },
      "membership-required-expired": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-expiry-missing": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-revoked": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-removed": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-revision-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-provider-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-host-facts-revision-mismatch": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-duplicate-ref": { allowed: false, reasonCode: "membership-stale" },
      "membership-required-duplicate-host-fact": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-required-principal-not-directly-verified": {
        allowed: false,
        reasonCode: "membership-stale",
      },
      "membership-unrelated-stale-is-harmless": { allowed: true, reasonCode: "allowed" },
      "cross-agent-cell": { allowed: false, reasonCode: "outside-view" },
      "plan-context-revision": { allowed: false, reasonCode: "revision-stale" },
      "plan-run-binding": { allowed: false, reasonCode: "invalid-context" },
      "plan-session-binding": { allowed: false, reasonCode: "session-rebound" },
      "plan-expiry": { allowed: false, reasonCode: "plan-expired" },
      "plan-expiry-missing": { allowed: false, reasonCode: "plan-expired" },
      "plan-host-facts-revision": { allowed: false, reasonCode: "revision-stale" },
      "delivery-audience-intersection": { allowed: false, reasonCode: "outside-view" },
      "delegation-intersection": { allowed: false, reasonCode: "default-deny" },
      "lineage-requirements": { allowed: false, reasonCode: "lineage-deny" },
      "prefilter-superset": { allowed: true, reasonCode: "allowed" },
    });
    expect(cases.at(-1)?.expected["resource-denied"]).toEqual({
      allowed: false,
      reasonCode: "outside-view",
    });
    const revoked = cases.find((entry) => entry.id === "principal-revoked-retains-context-ref");
    expect(revoked?.scenario.context.principalRefs).toEqual([
      {
        principalId: "principal-owner",
        evidenceRevision: "principal-evidence-revision-1",
      },
    ]);
    expect(revoked?.scenario.context).not.toHaveProperty("principalIds");
  });

  it("fails closed for omitted or malformed plan, resource, and policy expiry", () => {
    const scenario = createMemoryAuthorizationConformanceCases().find(
      (entry) => entry.id === "permission-complete",
    )?.scenario;
    expect(scenario).toBeDefined();
    const resource = scenario!.resources[0]!;
    const planWithoutExpiry = { ...scenario!.plan };
    Reflect.deleteProperty(planWithoutExpiry, "expiresAt");

    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: {
          ...scenario!,
          plan: { ...scenario!.plan, expiresAt: "" },
        },
        resource,
      }),
    ).toEqual({ allowed: false, reasonCode: "plan-expired" });
    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: { ...scenario!, plan: planWithoutExpiry },
        resource,
      }),
    ).toEqual({ allowed: false, reasonCode: "plan-expired" });
    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: scenario!,
        resource: { ...resource, expiresAt: "" },
      }),
    ).toEqual({ allowed: false, reasonCode: "revision-stale" });
    expect(
      evaluateMemoryAuthorizationConformanceScenario({
        scenario: {
          ...scenario!,
          policyEntries: scenario!.policyEntries.map((entry) =>
            Object.assign({}, entry, { expiresAt: "" }),
          ),
        },
        resource,
      }),
    ).toEqual({ allowed: false, reasonCode: "default-deny" });
  });

  it("rejects a context-free allow-all adapter", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource }) => ({
        allowed: true,
        reasonCode: "allowed",
        handle: `raw:${resource.resourceId}`,
      }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(expect.objectContaining({ invariant: "decision" }));
  });

  it("rejects an adapter that treats raw context principal refs as policy authority", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) =>
        evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            // This is the unsafe legacy model: context IDs manufacture current principal facts.
            principals: scenario.context.principalRefs.map((ref) => ({
              principalId: ref.principalId,
              status: "active" as const,
              evidenceRevision: ref.evidenceRevision,
              expiresAt: "2026-07-29T12:05:00.000Z",
            })),
          },
        }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "principal-revoked-retains-context-ref",
      "principal-expired",
      "principal-expiry-missing",
      "principal-missing",
      "principal-revision-mismatch",
      "principal-duplicate-host-fact",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("rejects an adapter that bypasses selected-store membership evidence", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) =>
        evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            stores: scenario.stores.map((store) => {
              const directPrincipalStore = { ...store };
              Reflect.deleteProperty(directPrincipalStore, "requiredMembership");
              return directPrincipalStore;
            }),
          },
        }),
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "membership-required-expired",
      "membership-required-expiry-missing",
      "membership-required-revoked",
      "membership-required-removed",
      "membership-required-revision-mismatch",
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
      "membership-required-duplicate-ref",
      "membership-required-duplicate-host-fact",
      "membership-required-principal-not-directly-verified",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("rejects an adapter that rewrites selected membership provider or host facts", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: ({ resource, scenario }) => {
        const requirement = scenario.stores.find(
          (store) => store.requiredMembership,
        )?.requiredMembership;
        const fact = requirement
          ? scenario.memberships.find(
              (membership) =>
                membership.principalId === requirement.principalId &&
                membership.groupId === requirement.groupId,
            )
          : undefined;
        if (!requirement || !fact) {
          return evaluateMemoryAuthorizationConformanceScenario({ resource, scenario });
        }
        return evaluateMemoryAuthorizationConformanceScenario({
          resource,
          scenario: {
            ...scenario,
            stores: scenario.stores.map((store) =>
              store.requiredMembership
                ? {
                    ...store,
                    requiredMembership: {
                      ...store.requiredMembership,
                      provider: fact.provider,
                    },
                  }
                : store,
            ),
            context: {
              ...scenario.context,
              hostFactsRevision: fact.hostFactsRevision,
              membershipRefs: [
                {
                  principalId: fact.principalId,
                  groupId: fact.groupId,
                  provider: fact.provider,
                  evidenceRevision: fact.evidenceRevision,
                  hostFactsRevision: fact.hostFactsRevision,
                },
              ],
            },
            plan: {
              ...scenario.plan,
              hostFactsRevision: fact.hostFactsRevision,
            },
          },
        });
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    for (const caseId of [
      "membership-required-provider-mismatch",
      "membership-required-host-facts-revision-mismatch",
    ]) {
      expect(report.failures).toContainEqual(
        expect.objectContaining({ caseId, invariant: "decision" }),
      );
    }
  });

  it("accepts backend-issued opaque handles without prescribing their encoding", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        return decision.allowed ? { ...decision, handle: "backend-issued-handle" } : decision;
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    await expect(runMemoryAuthorizationConformanceSuite(adapter)).resolves.toEqual({
      ok: true,
      failures: [],
    });
  });

  it("rejects an empty allowed-handle token", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        return decision.allowed ? { ...decision, handle: "" } : decision;
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ invariant: "authorized-handle" }),
    );
  });

  it("rejects denial metadata that reveals counts, scores, paths, or citations", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        if (decision.allowed) {
          return decision;
        }
        return {
          ...decision,
          count: 1,
          score: 0.99,
          path: "private/other-user.md",
          title: "private",
          citation: "private/other-user.md#L1",
          cursor: "next-secret",
          denialDetail: "principal-owner",
          handle: "unauthorized-handle",
        } as unknown as MemoryAuthorizationConformanceDecision;
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    const report = await runMemoryAuthorizationConformanceSuite(adapter);
    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual(
      expect.objectContaining({ invariant: "denial-non-disclosure" }),
    );
  });

  it("rejects non-enumerable, symbolic, or inherited denial metadata", async () => {
    const privateMetadata = Symbol("private-metadata");
    const decorateDenied: Array<
      (
        decision: Extract<MemoryAuthorizationConformanceDecision, { allowed: false }>,
      ) => MemoryAuthorizationConformanceDecision
    > = [
      (decision) => {
        const decorated = { ...decision };
        Object.defineProperty(decorated, "privateMetadata", {
          enumerable: false,
          value: "hidden",
        });
        return decorated;
      },
      (decision) => ({ ...decision, [privateMetadata]: "hidden" }),
      (decision) =>
        Object.assign(
          Object.create({ privateMetadata: "hidden" }),
          decision,
        ) as MemoryAuthorizationConformanceDecision,
    ];

    for (const decorate of decorateDenied) {
      const adapter: MemoryAuthorizationConformanceAdapter = {
        evaluate: (params) => {
          const decision = evaluateMemoryAuthorizationConformanceScenario(params);
          return decision.allowed ? decision : decorate(decision);
        },
        prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
      };

      const report = await runMemoryAuthorizationConformanceSuite(adapter);
      expect(report.failures).toContainEqual(
        expect.objectContaining({ invariant: "denial-non-disclosure" }),
      );
    }
  });

  it("accepts a null-prototype denied decision with no metadata", async () => {
    const adapter: MemoryAuthorizationConformanceAdapter = {
      evaluate: (params) => {
        const decision = evaluateMemoryAuthorizationConformanceScenario(params);
        return decision.allowed
          ? decision
          : (Object.assign(
              Object.create(null),
              decision,
            ) as MemoryAuthorizationConformanceDecision);
      },
      prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
    };

    await expect(runMemoryAuthorizationConformanceSuite(adapter)).resolves.toEqual({
      ok: true,
      failures: [],
    });
  });

  it("rejects prefilter false negatives and duplicate candidates", async () => {
    const falseNegative: MemoryAuthorizationConformanceAdapter = {
      evaluate: evaluateMemoryAuthorizationConformanceScenario,
      prefilter: () => [],
    };
    const duplicate: MemoryAuthorizationConformanceAdapter = {
      evaluate: evaluateMemoryAuthorizationConformanceScenario,
      prefilter: (scenario) => {
        const ids = scenario.resources.map((resource) => resource.resourceId);
        return [...ids, ...(ids[0] ? [ids[0]] : [])];
      },
    };

    const falseNegativeReport = await runMemoryAuthorizationConformanceSuite(falseNegative);
    const duplicateReport = await runMemoryAuthorizationConformanceSuite(duplicate);
    expect(falseNegativeReport.failures).toContainEqual(
      expect.objectContaining({ invariant: "prefilter-superset" }),
    );
    expect(duplicateReport.failures).toContainEqual(
      expect.objectContaining({ invariant: "duplicate-prefilter-candidate" }),
    );
  });
});
