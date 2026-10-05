// Telegram API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "telegram-legacy-state",
    label: "Telegram legacy state",
    resolvePlans: async (input) => {
      const { detectTelegramLegacyStateMigrations } = await import("./src/state-migrations.js");
      return detectTelegramLegacyStateMigrations(input);
    },
  }),
];
