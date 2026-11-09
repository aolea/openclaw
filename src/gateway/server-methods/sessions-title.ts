import {
  ErrorCodes,
  errorShape,
  validateSessionsTitlePrepareParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { prepareDashboardSessionTitle } from "../dashboard-session-title.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  prepareSessionCreateDefaultAccount,
  prepareSessionCreateModelSelection,
} from "../session-create-model-selection.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { resolveRegisteredCatalogCreateTarget } from "./session-catalog.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { prepareSessionModelAccountAccess } from "./users-model-account-access.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const sessionTitleHandlers: GatewayRequestHandlers = {
  "sessions.title.prepare": defineValidatedGatewayHandler(
    "sessions.title.prepare",
    validateSessionsTitlePrepareParams,
    async (options) => {
      const { params, respond, context, client, signal, hasCurrentClientAuthority } = options;
      const requestAuthority = readGatewayRequestMutationAuthority(options);
      const request = { ...params };
      const getCurrentConfig = context.getRuntimeConfig;
      const cfg = getCurrentConfig();
      const agent = resolveAgentIdOrRespondError({
        rawAgentId: request.agentId,
        respond,
        cfg,
      });
      if (!agent) {
        return;
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg,
        client,
        agentId: agent.agentId,
      });
      if (creationError) {
        respond(false, undefined, creationError);
        return;
      }
      if (request.model && request.catalogId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "sessions.title.prepare catalogId cannot include model",
          ),
        );
        return;
      }
      if (request.incognito || !request.message.trim() || request.message.trim().startsWith("/")) {
        respond(true, { title: null });
        return;
      }
      const catalog = request.catalogId
        ? resolveRegisteredCatalogCreateTarget(request.catalogId, agent.agentId, cfg)
        : undefined;
      if (catalog && !catalog.ok) {
        respond(true, { title: null });
        return;
      }
      let capturedOperator: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      try {
        const { personalModelSelection, personalAccountDefaults } =
          await prepareSessionModelAccountAccess(options, request.model);
        const assertCallerCurrent = () => {
          personalModelSelection?.assertCurrent();
          personalAccountDefaults?.assertCurrent();
          requestAuthority.assertCurrent();
          const currentCreationError = authorizeGatewaySessionCreation({
            cfg: getCurrentConfig(),
            client,
            agentId: agent.agentId,
          });
          if (currentCreationError) {
            throw new SessionMutationAuthorizationChangedError(currentCreationError);
          }
        };
        capturedOperator = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority,
          invocationAuthority: { assertCurrent: assertCallerCurrent, signal },
        });
        assertCallerCurrent();
        const selection = prepareSessionCreateModelSelection({
          cfg,
          agentId: agent.agentId,
          input: catalog?.target ?? request.model,
          operatorAuthority: capturedOperator?.authority,
        });
        if (!selection.ok) {
          respond(false, undefined, selection.error);
          return;
        }
        const entry = selection.selection;
        if (!entry) {
          respond(true, { title: null });
          return;
        }
        // Drafts must use the same prospective account as sessions.create;
        // otherwise a person's default is invisible until after speculation spends.
        let validateDefaultAccount: typeof selection.validate;
        if (!entry.authProfileOverride && personalAccountDefaults) {
          const account = await prepareSessionCreateDefaultAccount({
            cfg,
            agentId: agent.agentId,
            entry: { sessionId: "title-draft", updatedAt: 0, ...entry },
            defaults: personalAccountDefaults,
            operatorAuthority: capturedOperator?.authority,
            resetToDefault: request.model === undefined && !catalog?.target,
            assertCurrent: assertCallerCurrent,
          });
          if (!account.ok) {
            respond(false, undefined, account.error);
            return;
          }
          validateDefaultAccount = account.validate;
          entry.authProfileOverride = account.profileId;
        }
        const assertCurrent = () => {
          assertCallerCurrent();
          const error = selection.validate?.() ?? validateDefaultAccount?.();
          if (error) {
            throw new SessionMutationAuthorizationChangedError(error);
          }
          capturedOperator?.authority.assertCurrent();
        };
        const title = await prepareDashboardSessionTitle({
          cfg,
          agentId: agent.agentId,
          entry,
          userMessage: request.message,
          abortSignal: signal,
          assertCurrent,
          operatorAuthority: capturedOperator?.authority,
        });
        assertCurrent();
        respond(true, { title });
      } catch (error) {
        const failure =
          error instanceof ModelAccountConnectAuthorityError
            ? errorShape(ErrorCodes.FORBIDDEN, error.message)
            : error instanceof SessionMutationAuthorizationChangedError
              ? error.error
              : undefined;
        if (!failure) {
          throw error;
        }
        respond(false, undefined, failure);
      } finally {
        capturedOperator?.release();
      }
    },
  ),
};
