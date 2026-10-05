// Whatsapp API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/doctor-contract.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "whatsapp-legacy-state",
    label: "WhatsApp legacy state",
    resolvePlans: async (input) => {
      const { detectWhatsAppLegacyStateMigrations } = await import("./src/state-migrations.js");
      return detectWhatsAppLegacyStateMigrations(input);
    },
  }),
];
