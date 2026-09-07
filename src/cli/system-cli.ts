// System CLI commands that call Gateway RPC methods for events, heartbeats, and presence.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "./failure-output.js";
import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "./gateway-rpc.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { isSystemMachineOutput } from "./system-output-mode.js";

type SystemEventOpts = GatewayRpcOpts & {
  text?: string;
  mode?: string;
  sessionKey?: string;
  idempotencyKey?: string;
  json?: boolean;
};
type SystemGatewayOpts = GatewayRpcOpts & { json?: boolean };
type WakeStatusOpts = SystemGatewayOpts & { ticketId?: string; idempotencyKey?: string };

const normalizeWakeMode = (raw: unknown) => {
  const mode = normalizeOptionalString(raw) ?? "";
  if (!mode) {
    return "next-heartbeat" as const;
  }
  if (mode === "now" || mode === "next-heartbeat") {
    return mode;
  }
  throw new Error("--mode must be now or next-heartbeat");
};

async function runSystemGatewayCommand(
  opts: SystemGatewayOpts,
  action: () => Promise<unknown>,
  successText?: string,
): Promise<void> {
  const machineOutput = opts.json || successText === undefined;
  try {
    const result = await action();
    if (machineOutput) {
      defaultRuntime.writeJson(result);
    } else {
      defaultRuntime.log(successText);
    }
  } catch (err) {
    rethrowExpectedCliError(err);
    const message = formatErrorMessage(err);
    if (machineOutput) {
      defaultRuntime.writeJson(formatCliJsonFailure(message));
    } else {
      defaultRuntime.error(danger(message));
    }
    defaultRuntime.exit(1);
  }
}

/** Register Gateway-backed system event, heartbeat, and presence commands. */
export function registerSystemCli(program: Command) {
  const system = program
    .command("system")
    .description("System tools (events, heartbeat, presence)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/system", "docs.openclaw.ai/cli/system")}\n`,
    );
  setCommandJsonMode(system, "output", ({ argv }) => isSystemMachineOutput(argv));

  addGatewayClientOptions(
    system
      .command("event")
      .description("Enqueue a system event and optionally trigger a heartbeat")
      .requiredOption("--text <text>", "System event text")
      .option("--mode <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat")
      .option(
        "--session-key <sessionKey>",
        "Target a specific session for the event (defaults to the agent's main session)",
      )
      .option(
        "--idempotency-key <key>",
        "Reserve a durable replay-safe wake ticket (requires --session-key)",
      )
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemEventOpts) => {
    await runSystemGatewayCommand(
      opts,
      async () => {
        const text = normalizeOptionalString(opts.text) ?? "";
        if (!text) {
          throw new Error(
            `--text is required. Example: ${formatCliCommand('openclaw system event --text "deploy finished"')}.`,
          );
        }
        const mode = normalizeWakeMode(opts.mode);
        const sessionKey = normalizeOptionalString(opts.sessionKey);
        const idempotencyKey = normalizeOptionalString(opts.idempotencyKey);
        if (
          opts.idempotencyKey !== undefined &&
          (!idempotencyKey || /[\r\n]/u.test(idempotencyKey))
        ) {
          throw new Error("--idempotency-key must not be blank or contain newlines");
        }
        const result = await callGatewayFromCli(
          "wake",
          opts,
          {
            mode,
            text,
            ...(sessionKey ? { sessionKey } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
          { expectFinal: false },
        );
        if (typeof result === "object" && result !== null && "ok" in result && !result.ok) {
          const reason =
            "reason" in result && typeof result.reason === "string"
              ? result.reason
              : "Gateway did not accept the system event";
          throw new Error(reason);
        }
        return result;
      },
      "ok",
    );
  });

  addGatewayClientOptions(
    system
      .command("wake-status")
      .description("Read one durable wake ticket")
      .option("--ticket-id <ticketId>", "Wake ticket identifier")
      .option("--idempotency-key <key>", "Stable idempotency key used to reserve the wake ticket")
      .option("--json", "Output JSON", false),
  ).action(async (opts: WakeStatusOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      const ticketId = normalizeOptionalString(opts.ticketId);
      const idempotencyKey = normalizeOptionalString(opts.idempotencyKey);
      if (
        Number(Boolean(ticketId)) + Number(Boolean(idempotencyKey)) !== 1 ||
        (ticketId !== undefined && /[\r\n]/u.test(ticketId)) ||
        (idempotencyKey !== undefined && /[\r\n]/u.test(idempotencyKey))
      ) {
        throw new Error("pass exactly one of --ticket-id or --idempotency-key");
      }
      return await callGatewayFromCli(
        "wake.status",
        opts,
        ticketId ? { ticketId } : { idempotencyKey },
        { expectFinal: false },
      );
    });
  });

  const heartbeat = system.command("heartbeat").description("Heartbeat controls");

  addGatewayClientOptions(
    heartbeat
      .command("last")
      .description("Show the last heartbeat event")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli("last-heartbeat", opts, undefined, {
        expectFinal: false,
      });
    });
  });

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    addGatewayClientOptions(
      heartbeat
        .command(name)
        .description(`${enabled ? "Enable" : "Disable"} heartbeats`)
        .option("--json", "Output JSON", false),
    ).action(async (opts: SystemGatewayOpts) => {
      await runSystemGatewayCommand(opts, async () => {
        return await callGatewayFromCli(
          "set-heartbeats",
          opts,
          { enabled },
          { expectFinal: false },
        );
      });
    });
  }

  addGatewayClientOptions(
    system
      .command("presence")
      .description("List system presence entries")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SystemGatewayOpts) => {
    await runSystemGatewayCommand(opts, async () => {
      return await callGatewayFromCli("system-presence", opts, undefined, {
        expectFinal: false,
      });
    });
  });
}
