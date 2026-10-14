#!/usr/bin/env bash
set -euo pipefail

mkdir -p /work/evidence /work/home /work/cache /work/tmp
/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/home USER=fixture LOGNAME=fixture LC_ALL=C.UTF-8 \
  python3 -I /harness/probe.py > /work/evidence/isolation-probe.json
cp -a --no-preserve=ownership /input/source /work/source
cd /work/source
python3 -I /harness/identity.py /work/source /work/evidence/source-before.json

# This is the complete explicit candidate environment. No host/Actions variables survive.
export HOME=/work/home USER=fixture LOGNAME=fixture PATH=/usr/local/bin:/usr/bin:/bin
export TMPDIR=/work/tmp XDG_CACHE_HOME=/work/cache XDG_CONFIG_HOME=/work/home/.config
export CI=1 PNPM_HOME=/opt/pnpm npm_execpath=/opt/pnpm/pnpm npm_node_execpath=/usr/local/bin/node
export npm_config_cache=/work/cache/npm npm_config_store_dir=/work/cache/pnpm
export npm_config_userconfig=/work/home/empty.npmrc npm_config_globalconfig=/work/home/empty-global.npmrc
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export GIT_CONFIG_GLOBAL=/work/home/empty.gitconfig GIT_CONFIG_SYSTEM=/work/home/empty-system.gitconfig
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 COREPACK_ENABLE_NETWORK=0
export GOGC=30 GOMEMLIMIT=3GiB GOMAXPROCS=4
export NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=8192
# Read only the protected harness binding; never import candidate code for identity.
release_fields="$(python3 -I - <<'PY'
import datetime
import json
import re

with open('/harness/binding.json') as stream:
    binding = json.load(stream)
assert binding['schemaVersion'] == 1
for key in ('candidateCommit', 'baseCommit'):
    assert isinstance(binding[key], str) and re.fullmatch(r'[0-9a-f]{40}', binding[key])
assert isinstance(binding['version'], str) and re.fullmatch(r'[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}', binding['version'])
timestamp = binding['buildTimestamp']
assert isinstance(timestamp, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z', timestamp)
datetime.datetime.strptime(timestamp, '%Y-%m-%dT%H:%M:%S.%fZ')
for key in ('candidateCommit', 'baseCommit', 'buildTimestamp', 'version'):
    print(binding[key])
PY
)"
mapfile -t release_values <<< "$release_fields"
(( ${#release_values[@]} == 4 ))
export GIT_COMMIT="${release_values[0]}"
stable_base="${release_values[1]}"
export OPENCLAW_BUILD_TIMESTAMP="${release_values[2]}"
candidate_version="${release_values[3]}"
core_output_name="openclaw-${candidate_version}-${GIT_COMMIT:0:10}.tgz"
touch "$npm_config_userconfig" "$npm_config_globalconfig" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM"

failed=0
printf 'step\tcommandExit\tteeExit\tbeforeSnapshot\tafterSnapshot\tresultExit\n' > /work/evidence/steps.tsv
step() {
  local label="$1"
  shift
  local -a statuses
  local command_code tee_code record_code=0 output_code=0 before_code=0 after_code=0 code
  python3 -I /harness/cgroup-snapshot.py "$label" before || before_code=$?
  # Capture both statuses immediately: tee failures must never turn a failed command green.
  if "$@" 2>&1 | tee --output-error=exit "/work/evidence/${label}.log"; then
    statuses=("${PIPESTATUS[@]}")
  else
    statuses=("${PIPESTATUS[@]}")
  fi
  command_code="${statuses[0]}"
  tee_code="${statuses[1]}"
  python3 -I /harness/cgroup-snapshot.py "$label" after || after_code=$?
  code="$command_code"
  if ((code == 0 && tee_code != 0)); then code="$tee_code"; fi
  if ((code == 0 && before_code != 0)); then code="$before_code"; fi
  if ((code == 0 && after_code != 0)); then code="$after_code"; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$label" "$command_code" "$tee_code" "$before_code" "$after_code" "$code" >> /work/evidence/steps.tsv || record_code=$?
  if ((code == 0 && record_code != 0)); then code="$record_code"; fi
  # The host log preserves exit custody even if the evidence disk refuses the TSV write.
  printf '[canary-step] %s command=%s tee=%s before=%s after=%s record=%s result=%s\n' "$label" "$command_code" "$tee_code" "$before_code" "$after_code" "$record_code" "$code" || output_code=$?
  if ((code == 0 && output_code != 0)); then code="$output_code"; fi
  if ((code != 0 || record_code != 0 || output_code != 0)); then failed=1; fi
  return "$code"
}

# Frozen pnpm policy owns approved lifecycle execution; do not skip scripts or DTS.
step install pnpm install --frozen-lockfile || exit 1
python3 -I /harness/identity.py /work/source /work/evidence/source-after-install.json
step effective-tool-inventory node scripts/run-vitest.mjs run --maxWorkers 1 \
  src/agents/tools-effective-inventory.plugin-tools.test.ts \
  src/agents/tools-effective-inventory.runtime-model.test.ts \
  src/agents/tools-effective-inventory.gateway-borrow.test.ts \
  src/agents/tools-effective-inventory.cold-provider.test.ts \
  src/agents/tools-effective-inventory.test.ts || exit 1
# Measure the same compiler invocations; do not run an extra profiling compiler pass.
# Scope telemetry to the candidate check, excluding later SDK baseline worktrees.
step check env OPENCLAW_TSGO_METRICS_DIR=/work/evidence/tsgo-metrics \
  pnpm check --base "$stable_base" --include-test-types --include-architecture --timed || true
step sdk-export-map pnpm plugin-sdk:check-exports || true
step sdk-subpath-guard node --import ./scripts/tsx.mjs scripts/check-plugin-sdk-subpath-exports.mts || true
step sdk-api-diff pnpm plugin-sdk:api:diff \
  --base "$stable_base" \
  --head "$GIT_COMMIT" \
  --evidence /work/evidence/sdk-api-evidence.json \
  --json /work/evidence/sdk-api-diff.json \
  --summary /work/evidence/sdk-api-summary.md || true

# Canonical focused E2E setup owns private QA artifacts; production packaging follows.
step after-tool-call-e2e env OPENCLAW_E2E_WORKERS=1 \
  node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts \
  src/plugins/wired-hooks-after-tool-call.e2e.test.ts || true

mkdir -p /work/evidence/packages/core
if step full-package node scripts/package-openclaw-for-docker.mjs \
  --bundle-plugin mattermost --bundle-plugin codex --bundle-plugin acpx --bundle-plugin diagnostics-otel \
  --output-dir /work/evidence/packages/core \
  --output-name "$core_output_name" \
  --pack-json /work/evidence/packages/core/pack.json; then
  step sdk-built-exports node --import ./scripts/tsx.mjs scripts/check-plugin-sdk-exports.mts || true
  for plugin in mattermost codex acpx diagnostics-otel; do
    export OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="/work/evidence/packages/plugins/${plugin}"
    mkdir -p "$OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR"
    step "plugin-${plugin}" bash scripts/plugin-npm-publish.sh --pack "extensions/${plugin}" || true
  done
  unset OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR
fi

python3 -I /harness/identity.py /work/source /work/evidence/source-after.json || failed=1
cat /sys/fs/cgroup/memory.events > /work/evidence/memory.events.txt
cat /sys/fs/cgroup/memory.peak > /work/evidence/memory.peak.txt
cp /harness/binding.json /work/evidence/candidate-binding.json
exit "$failed"
