import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimResult,
  PluginHookRegistration,
} from "./hook-types.js";

type TargetedClaimRunHandler = (
  run: () => Promise<PluginHookInboundClaimResult | void>,
) => Promise<PluginHookInboundClaimResult | void>;

/** Captures and revalidates the exact required owner across durable admission I/O. */
export function resolveTargetedClaimOwner(params: {
  registry: GlobalHookRunnerRegistry;
  pluginId: string;
  context: PluginHookInboundClaimContext;
  hooks: PluginHookRegistration<"inbound_claim">[];
}): { runHandler?: TargetedClaimRunHandler } | null {
  const { registry, pluginId, context, hooks } = params;
  const pluginOwner = registry.plugins.find(
    (plugin) =>
      plugin.id === pluginId &&
      plugin.status === "loaded" &&
      (context.pluginBinding?.requiredOwner !== true ||
        (plugin.rootDir ?? plugin.source) === context.pluginBinding.pluginRoot),
  );
  if (!pluginOwner) {
    return null;
  }
  if (context.pluginBinding?.requiredOwner !== true) {
    return {};
  }
  return {
    runHandler: async (run) => {
      const currentOwner = registry.plugins.find(
        (plugin) =>
          plugin.id === pluginId &&
          plugin.status === "loaded" &&
          (plugin.rootDir ?? plugin.source) === context.pluginBinding?.pluginRoot,
      );
      const currentHooks = new Set(
        registry.typedHooks.filter(
          (hook) => hook.hookName === "inbound_claim" && hook.pluginId === pluginId,
        ),
      );
      if (currentOwner !== pluginOwner || hooks.some((hook) => !currentHooks.has(hook))) {
        throw new Error("Required conversation plugin owner changed during admission");
      }
      return await run();
    },
  };
}
