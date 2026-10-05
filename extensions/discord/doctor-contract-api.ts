// Discord API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "discord-legacy-state",
    label: "Discord legacy state",
    resolvePlans: async (input) => {
      const { detectDiscordLegacyStateMigrations } =
        await import("./src/monitor/model-picker-preferences-migrations.js");
      return detectDiscordLegacyStateMigrations(input);
    },
  }),
];
