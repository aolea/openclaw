---
summary: "CLI reference for `openclaw system` (system events, heartbeat, presence)"
read_when:
  - You want to enqueue a system event without creating a cron job
  - You need to enable or disable heartbeats
  - You want to inspect system presence entries
title: "System"
---

# `openclaw system`

System-level helpers for the Gateway: enqueue system events, control
heartbeats, and view presence.

All `system` subcommands use Gateway RPC and accept the shared client flags:

| Flag              | Default                              | Description                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--url <url>`     | `gateway.remote.url` when configured | Gateway WebSocket URL.                                                                                                                                                                                                        |
| `--token <token>` | none                                 | Gateway token (if required).                                                                                                                                                                                                  |
| `--timeout <ms>`  | `30000`                              | RPC timeout in milliseconds.                                                                                                                                                                                                  |
| `--expect-final`  | off                                  | Wait for final response (agent).                                                                                                                                                                                              |
| `--json`          | off                                  | Output JSON. `heartbeat last/enable/disable`, `system presence`, and `system wake-status` always print the raw RPC JSON payload regardless of this flag; `system event` uses it to switch between JSON and a plain `ok` line. |

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system event --text "Continue mission" --session-key "agent:main:mattermost:thread:mission-1" --idempotency-key "mission-event-42" --json
openclaw system wake-status --ticket-id "<ticket-id>"
openclaw system event --text "Check for urgent follow-ups" --url ws://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Enqueue a system event on the **main** session by default. The next
heartbeat injects it as a `System:` line in the prompt. Use `--mode now` to
trigger the heartbeat immediately; `next-heartbeat` (default) waits for the
next scheduled tick.

Pass `--session-key` to target a specific session, for example to relay an
async-task completion back to the channel that started it.

<Note>
**Timing exception with `--session-key`:** when `--session-key` is supplied,
`--mode next-heartbeat` collapses to an immediate targeted wake instead of
waiting for the next scheduled tick. Targeted wakes use heartbeat intent
`immediate` so they bypass the runner's not-due gate that would otherwise
defer (and effectively drop) an `event`-intent wake. If you want delayed
delivery, omit `--session-key` so the event lands on the main session and
rides the next regular heartbeat.
</Note>

Flags:

- `--text <text>`: required system event text.
- `--mode <mode>`: `now` or `next-heartbeat` (default).
- `--session-key <sessionKey>`: optional; target a specific agent session
  instead of the agent's main session. Keys that do not belong to the
  resolved agent fall back to the agent's main session.
- `--idempotency-key <key>`: optional; reserve a durable, replay-safe wake
  ticket before enqueueing the event. This mode requires `--session-key` and
  returns the ticket in the JSON result. Repeating an identical request with
  the same key returns the original ticket and does not enqueue another event;
  reusing the key for different request content is rejected.

## `system wake-status`

Read one durable ticket with `--ticket-id <ticketId>`. Status progresses from
`queued` to `started` only when the targeted agent's exact model run begins,
then to `completed`, `failed`, or `skipped`. A nonterminal ticket owned by a
previous Gateway process is reported as `unknown` with reason code
`gateway_restarted`; OpenClaw does not infer a start or automatically enqueue a
replacement after an ambiguous restart.

Ticket responses contain bounded operational metadata: agent and session IDs,
status, timestamps, an optional model run ID, and a stable reason code. They do
not contain event text, model output, or provider error details.

## `system heartbeat last|enable|disable`

- `last`: show the last heartbeat event.
- `enable`: turn heartbeats back on (use this if they were disabled).
- `disable`: pause heartbeats.

## `system presence`

List the current system presence entries the Gateway knows about (nodes,
instances, and similar status lines).

## Notes

- Requires a running Gateway reachable by your current config (local or
  remote).
- System event payloads remain ephemeral and are not persisted across restarts.
  Durable wake tickets persist only bounded lifecycle metadata.

## Related

- [CLI reference](/cli)
