import {
  hasCurrentConformanceEvidenceExpiry,
  isConformanceEvidenceExpired,
  requiredConformanceMembershipFailure,
  resolveActiveConformancePrincipalIds,
} from "./authorization-conformance-evidence.js";
import type {
  AudienceRef,
  MemoryAuthorizationReasonCode,
  MemoryOperation,
} from "./authorization.js";

export type MemoryAuthorizationConformancePrincipal =
  | Readonly<{
      principalId: string;
      status: "active";
      evidenceRevision: string;
      expiresAt: string;
    }>
  | Readonly<{
      principalId: string;
      status: "revoked";
      evidenceRevision: string;
      expiresAt?: string;
    }>;

/** Context claims bind a policy principal to one declared host-evidence revision. */
export type MemoryAuthorizationConformancePrincipalRef = Readonly<{
  principalId: string;
  evidenceRevision: string;
}>;

export type MemoryAuthorizationConformanceMembership =
  | Readonly<{
      principalId: string;
      groupId: string;
      provider: string;
      status: "active";
      evidenceRevision: string;
      hostFactsRevision: string;
      expiresAt: string;
    }>
  | Readonly<{
      principalId: string;
      groupId: string;
      provider: string;
      status: "revoked";
      evidenceRevision: string;
      hostFactsRevision: string;
      expiresAt?: string;
    }>;

/** Context claims bind a membership to one declared host-evidence revision. */
export type MemoryAuthorizationConformanceMembershipRef = Readonly<{
  principalId: string;
  groupId: string;
  provider: string;
  evidenceRevision: string;
  hostFactsRevision: string;
}>;

export type MemoryAuthorizationConformanceMembershipRequirement = Readonly<{
  principalId: string;
  groupId: string;
  /** The selected mount admits membership evidence from this provider only. */
  provider: string;
}>;

export type MemoryAuthorizationConformanceStore = Readonly<{
  storeId: string;
  agentId: string;
  placementCapabilities: readonly MemoryOperation[];
  /** A mount-specific group check; stores without one remain direct-principal stores. */
  requiredMembership?: MemoryAuthorizationConformanceMembershipRequirement;
}>;

export type MemoryAuthorizationConformanceResource = Readonly<{
  resourceId: string;
  agentId: string;
  storeId: string;
  revision: string;
  audiences: readonly AudienceRef[];
  expiresAt?: string;
  requiredLineagePolicySetIds?: readonly string[];
}>;

export type MemoryAuthorizationConformancePolicyEntry = Readonly<{
  effect: "allow" | "deny";
  principalId: string;
  resourceId: string;
  operation: MemoryOperation;
  expiresAt?: string;
}>;

export type MemoryAuthorizationConformancePlanBinding = Readonly<{
  contextFingerprint: string;
  runId: string;
  agentId: string;
  sessionId: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  deliveryRevision: string;
  policyRevision: string;
  hostFactsRevision: string;
  operation: MemoryOperation;
  expiresAt: string;
}>;

export type MemoryAuthorizationConformanceScenario = Readonly<{
  id: string;
  now: string;
  principals: readonly MemoryAuthorizationConformancePrincipal[];
  memberships: readonly MemoryAuthorizationConformanceMembership[];
  stores: readonly MemoryAuthorizationConformanceStore[];
  resources: readonly MemoryAuthorizationConformanceResource[];
  policyEntries: readonly MemoryAuthorizationConformancePolicyEntry[];
  viewStoreIds: readonly string[];
  context: Readonly<{
    contextFingerprint: string;
    runId: string;
    agentId: string;
    sessionId: string;
    sessionIdentityRevision: string;
    subjectRevision: string;
    deliveryRevision: string;
    policyRevision: string;
    hostFactsRevision: string;
    operation: MemoryOperation;
    principalRefs: readonly MemoryAuthorizationConformancePrincipalRef[];
    membershipRefs: readonly MemoryAuthorizationConformanceMembershipRef[];
    deliveryAudiences: readonly AudienceRef[];
    lineagePolicySetIds: readonly string[];
    delegation?: Readonly<{
      allowedOperations: readonly MemoryOperation[];
      maximumAudiences: readonly AudienceRef[];
    }>;
  }>;
  plan: MemoryAuthorizationConformancePlanBinding;
}>;

export type MemoryAuthorizationConformanceDecision =
  | Readonly<{
      allowed: true;
      reasonCode: "allowed";
      handle: string;
    }>
  | Readonly<{
      allowed: false;
      reasonCode: MemoryAuthorizationReasonCode;
    }>;

export type MemoryAuthorizationConformanceAdapter = Readonly<{
  evaluate(params: {
    scenario: MemoryAuthorizationConformanceScenario;
    resource: MemoryAuthorizationConformanceResource;
  }): MemoryAuthorizationConformanceDecision | Promise<MemoryAuthorizationConformanceDecision>;
  prefilter(
    scenario: MemoryAuthorizationConformanceScenario,
  ): readonly string[] | Promise<readonly string[]>;
}>;

export type MemoryAuthorizationConformanceCase = Readonly<{
  id: string;
  scenario: MemoryAuthorizationConformanceScenario;
  expected: Readonly<Record<string, MemoryAuthorizationConformanceDecision>>;
}>;

export type MemoryAuthorizationConformanceReport = Readonly<{
  ok: boolean;
  failures: readonly Readonly<{
    caseId: string;
    invariant:
      | "decision"
      | "authorized-handle"
      | "denial-non-disclosure"
      | "prefilter-superset"
      | "duplicate-prefilter-candidate";
  }>[];
}>;

const OPERATION_REQUIREMENTS: Readonly<Record<MemoryOperation, readonly MemoryOperation[]>> = {
  retrieve: ["retrieve"],
  read: ["retrieve", "read"],
  append: ["append"],
  replace: ["append", "replace"],
  derive: ["retrieve", "read", "derive"],
  deposit: ["deposit"],
  project: ["project"],
  publish: ["publish"],
  import: ["import"],
  export: ["export"],
  delete: ["delete"],
  sync: ["sync"],
  status: ["status"],
  "policy-admin": ["policy-admin"],
};

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function policyEntryMatches(params: {
  entry: MemoryAuthorizationConformancePolicyEntry;
  resource: MemoryAuthorizationConformanceResource;
  operation: MemoryOperation;
  activePrincipalIds: ReadonlySet<string>;
  now: string;
}): boolean {
  const { activePrincipalIds, entry, now, resource, operation } = params;
  return (
    entry.operation === operation &&
    (entry.resourceId === "*" || entry.resourceId === resource.resourceId) &&
    (entry.principalId === "*" || activePrincipalIds.has(entry.principalId)) &&
    !isConformanceEvidenceExpired(entry.expiresAt, now)
  );
}

function planBindingFailure(
  scenario: MemoryAuthorizationConformanceScenario,
): MemoryAuthorizationReasonCode | null {
  const { context, plan } = scenario;
  if (!hasCurrentConformanceEvidenceExpiry(plan.expiresAt, scenario.now)) {
    return "plan-expired";
  }
  if (plan.contextFingerprint !== context.contextFingerprint) {
    return "invalid-context";
  }
  if (plan.runId !== context.runId) {
    return "invalid-context";
  }
  if (plan.sessionId !== context.sessionId) {
    return "session-rebound";
  }
  if (plan.agentId !== context.agentId || plan.operation !== context.operation) {
    return "outside-view";
  }
  if (
    plan.sessionIdentityRevision !== context.sessionIdentityRevision ||
    plan.subjectRevision !== context.subjectRevision ||
    plan.policyRevision !== context.policyRevision
  ) {
    return "revision-stale";
  }
  if (plan.deliveryRevision !== context.deliveryRevision) {
    return "delivery-rebound";
  }
  if (plan.hostFactsRevision !== context.hostFactsRevision) {
    return "revision-stale";
  }
  return null;
}

/** Pure reference evaluator used to compare backend policy implementations. */
export function evaluateMemoryAuthorizationConformanceScenario(params: {
  scenario: MemoryAuthorizationConformanceScenario;
  resource: MemoryAuthorizationConformanceResource;
}): MemoryAuthorizationConformanceDecision {
  const { resource, scenario } = params;
  const bindingFailure = planBindingFailure(scenario);
  if (bindingFailure) {
    return { allowed: false, reasonCode: bindingFailure };
  }

  const activePrincipalIds = resolveActiveConformancePrincipalIds(scenario);
  if (!activePrincipalIds) {
    return { allowed: false, reasonCode: "identity-revoked" };
  }

  const store = scenario.stores.find((entry) => entry.storeId === resource.storeId);
  if (
    !store ||
    store.agentId !== scenario.context.agentId ||
    resource.agentId !== scenario.context.agentId ||
    !scenario.viewStoreIds.includes(resource.storeId)
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }
  const membershipFailure = requiredConformanceMembershipFailure({
    scenario,
    store,
    activePrincipalIds,
  });
  if (membershipFailure) {
    return { allowed: false, reasonCode: membershipFailure };
  }
  if (isConformanceEvidenceExpired(resource.expiresAt, scenario.now)) {
    return { allowed: false, reasonCode: "revision-stale" };
  }

  const resourceAudiences = new Set(resource.audiences.map(audienceKey));
  if (
    scenario.context.deliveryAudiences.some(
      (audience) => !resourceAudiences.has(audienceKey(audience)),
    )
  ) {
    return { allowed: false, reasonCode: "outside-view" };
  }

  const delegation = scenario.context.delegation;
  if (delegation) {
    const maximumAudiences = new Set(delegation.maximumAudiences.map(audienceKey));
    if (
      !delegation.allowedOperations.includes(scenario.context.operation) ||
      scenario.context.deliveryAudiences.some(
        (audience) => !maximumAudiences.has(audienceKey(audience)),
      )
    ) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }

  const inheritedPolicies = new Set(scenario.context.lineagePolicySetIds);
  if (
    resource.requiredLineagePolicySetIds?.some((policySetId) => !inheritedPolicies.has(policySetId))
  ) {
    return { allowed: false, reasonCode: "lineage-deny" };
  }

  const requiredOperations = OPERATION_REQUIREMENTS[scenario.context.operation];
  for (const operation of requiredOperations) {
    if (
      scenario.policyEntries.some(
        (entry) =>
          entry.effect === "deny" &&
          policyEntryMatches({
            entry,
            resource,
            operation,
            activePrincipalIds,
            now: scenario.now,
          }),
      )
    ) {
      return { allowed: false, reasonCode: "explicit-deny" };
    }
  }
  for (const operation of requiredOperations) {
    const placed = store.placementCapabilities.includes(operation);
    const explicitlyAllowed = scenario.policyEntries.some(
      (entry) =>
        entry.effect === "allow" &&
        policyEntryMatches({
          entry,
          resource,
          operation,
          activePrincipalIds,
          now: scenario.now,
        }),
    );
    if (!placed && !explicitlyAllowed) {
      return { allowed: false, reasonCode: "default-deny" };
    }
  }

  return {
    allowed: true,
    reasonCode: "allowed",
    handle: "reference-issued-handle",
  };
}

function baseScenario(
  id: string,
  overrides: Partial<MemoryAuthorizationConformanceScenario> = {},
): MemoryAuthorizationConformanceScenario {
  const now = "2026-07-29T12:00:00.000Z";
  const userAudience = { kind: "user", id: "principal-owner" } as const;
  const context = {
    contextFingerprint: "context-revision-1",
    runId: "run-1",
    agentId: "agent-a",
    sessionId: "session-1",
    sessionIdentityRevision: "session-revision-1",
    subjectRevision: "subject-revision-1",
    deliveryRevision: "delivery-revision-1",
    policyRevision: "policy-revision-1",
    hostFactsRevision: "host-facts-revision-1",
    operation: "read" as const,
    principalRefs: [
      {
        principalId: "principal-owner",
        evidenceRevision: "principal-evidence-revision-1",
      },
    ],
    membershipRefs: [],
    deliveryAudiences: [userAudience],
    lineagePolicySetIds: ["lineage-1"],
  };
  const scenario: MemoryAuthorizationConformanceScenario = {
    id,
    now,
    principals: [
      {
        principalId: "principal-owner",
        status: "active",
        evidenceRevision: "principal-evidence-revision-1",
        expiresAt: "2026-07-29T12:05:00.000Z",
      },
    ],
    memberships: [],
    stores: [
      {
        storeId: "store-a",
        agentId: "agent-a",
        placementCapabilities: [],
      },
    ],
    resources: [
      {
        resourceId: "resource-a",
        agentId: "agent-a",
        storeId: "store-a",
        revision: "resource-revision-1",
        audiences: [userAudience],
      },
    ],
    policyEntries: [
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "retrieve",
      },
      {
        effect: "allow",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
    viewStoreIds: ["store-a"],
    context,
    plan: {
      contextFingerprint: context.contextFingerprint,
      runId: context.runId,
      agentId: context.agentId,
      sessionId: context.sessionId,
      sessionIdentityRevision: context.sessionIdentityRevision,
      subjectRevision: context.subjectRevision,
      deliveryRevision: context.deliveryRevision,
      policyRevision: context.policyRevision,
      hostFactsRevision: context.hostFactsRevision,
      operation: context.operation,
      expiresAt: "2026-07-29T12:05:00.000Z",
    },
    ...overrides,
  };
  return scenario;
}

function expectedFor(
  scenario: MemoryAuthorizationConformanceScenario,
): Readonly<Record<string, MemoryAuthorizationConformanceDecision>> {
  return Object.fromEntries(
    scenario.resources.map((resource) => [
      resource.resourceId,
      evaluateMemoryAuthorizationConformanceScenario({ scenario, resource }),
    ]),
  );
}

/** Produces malformed runtime input so conformance cases prove missing expirations fail closed. */
function withoutConformanceExpiry<T extends object>(value: T): T {
  const copy = { ...value };
  Reflect.deleteProperty(copy, "expiresAt");
  return copy;
}

/** Deterministic generated cases spanning every Phase 0 policy invariant. */
export function createMemoryAuthorizationConformanceCases(): MemoryAuthorizationConformanceCase[] {
  const cases: MemoryAuthorizationConformanceScenario[] = [];

  const denyPrecedence = baseScenario("deny-precedence");
  cases.push({
    ...denyPrecedence,
    policyEntries: [
      ...denyPrecedence.policyEntries,
      {
        effect: "deny",
        principalId: "principal-owner",
        resourceId: "resource-a",
        operation: "read",
      },
    ],
  });

  const permissionImplication = baseScenario("permission-implication");
  cases.push({
    ...permissionImplication,
    policyEntries: permissionImplication.policyEntries.filter(
      (entry) => entry.operation !== "retrieve",
    ),
  });

  cases.push(baseScenario("permission-complete"));

  const revokedPrincipal = baseScenario("principal-revoked-retains-context-ref");
  cases.push({
    ...revokedPrincipal,
    principals: revokedPrincipal.principals.map((principal) => ({
      ...principal,
      status: "revoked",
    })),
  });

  const expiredPrincipal = baseScenario("principal-expired");
  cases.push({
    ...expiredPrincipal,
    principals: expiredPrincipal.principals.map((principal) => ({
      ...principal,
      expiresAt: "2026-07-29T12:00:00.000Z",
    })),
  });

  const principalMissingExpiry = baseScenario("principal-expiry-missing");
  cases.push({
    ...principalMissingExpiry,
    principals: principalMissingExpiry.principals.map(withoutConformanceExpiry),
  });

  const missingPrincipal = baseScenario("principal-missing");
  cases.push({ ...missingPrincipal, principals: [] });

  const principalRevision = baseScenario("principal-revision-mismatch");
  cases.push({
    ...principalRevision,
    context: {
      ...principalRevision.context,
      principalRefs: principalRevision.context.principalRefs.map((ref) => ({
        ...ref,
        evidenceRevision: "principal-evidence-revision-2",
      })),
    },
  });

  const duplicatePrincipalRef = baseScenario("principal-duplicate-ref");
  cases.push({
    ...duplicatePrincipalRef,
    context: {
      ...duplicatePrincipalRef.context,
      principalRefs: [
        ...duplicatePrincipalRef.context.principalRefs,
        ...duplicatePrincipalRef.context.principalRefs,
      ],
    },
  });

  const duplicatePrincipalFact = baseScenario("principal-duplicate-host-fact");
  cases.push({
    ...duplicatePrincipalFact,
    principals: [...duplicatePrincipalFact.principals, ...duplicatePrincipalFact.principals],
  });

  const membershipRequirement = {
    principalId: "principal-owner",
    groupId: "group-shared",
    provider: "provider-primary",
  } as const;
  const requiredMembership = baseScenario("membership-required-valid");
  const validMembership = {
    principalId: membershipRequirement.principalId,
    groupId: membershipRequirement.groupId,
    provider: membershipRequirement.provider,
    status: "active" as const,
    evidenceRevision: "membership-evidence-revision-1",
    hostFactsRevision: requiredMembership.context.hostFactsRevision,
    expiresAt: "2026-07-29T12:05:00.000Z",
  };
  const requiredMembershipScenario = {
    ...requiredMembership,
    stores: requiredMembership.stores.map((store) => ({
      ...store,
      requiredMembership: membershipRequirement,
    })),
    memberships: [validMembership],
    context: {
      ...requiredMembership.context,
      membershipRefs: [
        {
          principalId: validMembership.principalId,
          groupId: validMembership.groupId,
          provider: validMembership.provider,
          evidenceRevision: validMembership.evidenceRevision,
          hostFactsRevision: validMembership.hostFactsRevision,
        },
      ],
    },
  } satisfies MemoryAuthorizationConformanceScenario;
  cases.push(requiredMembershipScenario);

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-expired",
    memberships: [
      {
        ...validMembership,
        expiresAt: "2026-07-29T12:00:00.000Z",
      },
    ],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-expiry-missing",
    memberships: [withoutConformanceExpiry(validMembership)],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-revoked",
    memberships: [{ ...validMembership, status: "revoked" }],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-removed",
    memberships: [],
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-revision-mismatch",
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: requiredMembershipScenario.context.membershipRefs.map((ref) => ({
        ...ref,
        evidenceRevision: "membership-evidence-revision-2",
      })),
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-provider-mismatch",
    memberships: [
      {
        ...validMembership,
        provider: "provider-secondary",
      },
    ],
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: requiredMembershipScenario.context.membershipRefs.map((ref) => ({
        ...ref,
        provider: "provider-secondary",
      })),
    },
  });

  const refreshedHostFactsRevision = "host-facts-revision-2";
  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-host-facts-revision-mismatch",
    context: {
      ...requiredMembershipScenario.context,
      hostFactsRevision: refreshedHostFactsRevision,
    },
    plan: {
      ...requiredMembershipScenario.plan,
      hostFactsRevision: refreshedHostFactsRevision,
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-duplicate-ref",
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: [
        ...requiredMembershipScenario.context.membershipRefs,
        ...requiredMembershipScenario.context.membershipRefs,
      ],
    },
  });

  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-duplicate-host-fact",
    memberships: [validMembership, validMembership],
  });

  const membershipForUnverifiedPrincipal = {
    principalId: "principal-not-directly-verified",
    groupId: membershipRequirement.groupId,
    provider: validMembership.provider,
    status: "active" as const,
    evidenceRevision: "membership-evidence-revision-1",
    hostFactsRevision: validMembership.hostFactsRevision,
    expiresAt: "2026-07-29T12:05:00.000Z",
  };
  cases.push({
    ...requiredMembershipScenario,
    id: "membership-required-principal-not-directly-verified",
    stores: requiredMembershipScenario.stores.map((store) => ({
      ...store,
      requiredMembership: {
        principalId: membershipForUnverifiedPrincipal.principalId,
        groupId: membershipForUnverifiedPrincipal.groupId,
        provider: membershipForUnverifiedPrincipal.provider,
      },
    })),
    memberships: [membershipForUnverifiedPrincipal],
    context: {
      ...requiredMembershipScenario.context,
      membershipRefs: [
        {
          principalId: membershipForUnverifiedPrincipal.principalId,
          groupId: membershipForUnverifiedPrincipal.groupId,
          provider: membershipForUnverifiedPrincipal.provider,
          evidenceRevision: membershipForUnverifiedPrincipal.evidenceRevision,
          hostFactsRevision: membershipForUnverifiedPrincipal.hostFactsRevision,
        },
      ],
    },
  });

  const unrelatedStaleMembership = baseScenario("membership-unrelated-stale-is-harmless");
  cases.push({
    ...unrelatedStaleMembership,
    memberships: [
      {
        principalId: "principal-owner",
        groupId: "group-unrelated",
        provider: "provider-primary",
        status: "active",
        evidenceRevision: "membership-evidence-revision-1",
        hostFactsRevision: unrelatedStaleMembership.context.hostFactsRevision,
        expiresAt: "2026-07-29T12:00:00.000Z",
      },
    ],
    context: {
      ...unrelatedStaleMembership.context,
      membershipRefs: [
        {
          principalId: "principal-owner",
          groupId: "group-unrelated",
          provider: "provider-primary",
          evidenceRevision: "membership-evidence-revision-1",
          hostFactsRevision: unrelatedStaleMembership.context.hostFactsRevision,
        },
      ],
    },
  });

  const crossAgent = baseScenario("cross-agent-cell");
  cases.push({
    ...crossAgent,
    resources: crossAgent.resources.map((resource) =>
      Object.assign({}, resource, { agentId: "agent-b" }),
    ),
  });

  const staleContext = baseScenario("plan-context-revision");
  cases.push({
    ...staleContext,
    context: { ...staleContext.context, subjectRevision: "subject-revision-2" },
  });

  const staleRun = baseScenario("plan-run-binding");
  cases.push({
    ...staleRun,
    context: { ...staleRun.context, runId: "run-2" },
  });

  const staleSession = baseScenario("plan-session-binding");
  cases.push({
    ...staleSession,
    context: { ...staleSession.context, sessionId: "session-2" },
  });

  const expiredPlan = baseScenario("plan-expiry");
  cases.push({
    ...expiredPlan,
    plan: { ...expiredPlan.plan, expiresAt: "2026-07-29T11:59:59.000Z" },
  });

  const missingPlanExpiry = baseScenario("plan-expiry-missing");
  cases.push({
    ...missingPlanExpiry,
    plan: withoutConformanceExpiry(missingPlanExpiry.plan),
  });

  const staleHostFacts = baseScenario("plan-host-facts-revision");
  cases.push({
    ...staleHostFacts,
    plan: { ...staleHostFacts.plan, hostFactsRevision: "host-facts-revision-2" },
  });

  const audienceIntersection = baseScenario("delivery-audience-intersection");
  cases.push({
    ...audienceIntersection,
    context: {
      ...audienceIntersection.context,
      deliveryAudiences: [{ kind: "conversation", id: "conversation-b" }],
    },
  });

  const delegationIntersection = baseScenario("delegation-intersection");
  cases.push({
    ...delegationIntersection,
    context: {
      ...delegationIntersection.context,
      delegation: {
        allowedOperations: ["retrieve"],
        maximumAudiences: delegationIntersection.context.deliveryAudiences,
      },
    },
  });

  const lineage = baseScenario("lineage-requirements");
  cases.push({
    ...lineage,
    resources: lineage.resources.map((resource) =>
      Object.assign({}, resource, {
        requiredLineagePolicySetIds: ["lineage-1", "lineage-2"],
      }),
    ),
  });

  const prefilter = baseScenario("prefilter-superset");
  cases.push({
    ...prefilter,
    resources: [
      ...prefilter.resources,
      {
        resourceId: "resource-denied",
        agentId: "agent-b",
        storeId: "store-a",
        revision: "resource-revision-2",
        audiences: prefilter.context.deliveryAudiences,
      },
    ],
  });

  return cases.map((scenario) => ({
    id: scenario.id,
    scenario,
    expected: expectedFor(scenario),
  }));
}

function decisionsMatch(
  actual: MemoryAuthorizationConformanceDecision,
  expected: MemoryAuthorizationConformanceDecision,
): boolean {
  if (actual.allowed !== expected.allowed || actual.reasonCode !== expected.reasonCode) {
    return false;
  }
  return true;
}

function hasOpaqueAuthorizedHandle(decision: MemoryAuthorizationConformanceDecision): boolean {
  return decision.allowed && typeof decision.handle === "string" && decision.handle.length > 0;
}

function isSafeDeniedDecision(decision: MemoryAuthorizationConformanceDecision): boolean {
  const prototype = Object.getPrototypeOf(decision);
  const ownKeys = Reflect.ownKeys(decision);
  return (
    (prototype === Object.prototype || prototype === null) &&
    ownKeys.length === 2 &&
    ownKeys.includes("allowed") &&
    ownKeys.includes("reasonCode") &&
    !decision.allowed
  );
}

/** Runs the reusable suite without taking a dependency on a specific test framework. */
export async function runMemoryAuthorizationConformanceSuite(
  adapter: MemoryAuthorizationConformanceAdapter,
): Promise<MemoryAuthorizationConformanceReport> {
  const failures: Array<MemoryAuthorizationConformanceReport["failures"][number]> = [];
  for (const testCase of createMemoryAuthorizationConformanceCases()) {
    const prefilter = [...(await adapter.prefilter(testCase.scenario))];
    if (new Set(prefilter).size !== prefilter.length) {
      failures.push({
        caseId: testCase.id,
        invariant: "duplicate-prefilter-candidate",
      });
    }
    for (const resource of testCase.scenario.resources) {
      const decision = await adapter.evaluate({ scenario: testCase.scenario, resource });
      const expected = testCase.expected[resource.resourceId];
      if (!expected || !decisionsMatch(decision, expected)) {
        failures.push({ caseId: testCase.id, invariant: "decision" });
      }
      if (decision.allowed && !hasOpaqueAuthorizedHandle(decision)) {
        failures.push({ caseId: testCase.id, invariant: "authorized-handle" });
      }
      if (!decision.allowed && !isSafeDeniedDecision(decision)) {
        failures.push({ caseId: testCase.id, invariant: "denial-non-disclosure" });
      }
      if (expected?.allowed && !prefilter.includes(resource.resourceId)) {
        failures.push({ caseId: testCase.id, invariant: "prefilter-superset" });
      }
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
}

export const referenceMemoryAuthorizationConformanceAdapter: MemoryAuthorizationConformanceAdapter =
  Object.freeze({
    evaluate: evaluateMemoryAuthorizationConformanceScenario,
    prefilter: (scenario) => scenario.resources.map((resource) => resource.resourceId),
  });
