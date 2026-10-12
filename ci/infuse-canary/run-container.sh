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
export GIT_COMMIT=7494b64ee37d2cce1e9fd1873180eb35ea75f9e9
export OPENCLAW_BUILD_TIMESTAMP=2026-10-12T23:12:45.000Z
touch "$npm_config_userconfig" "$npm_config_globalconfig" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM"

failed=0
step() {
  local label="$1"
  shift
  local code=0
  "$@" > "/work/evidence/${label}.log" 2>&1 || code=$?
  cat "/work/evidence/${label}.log"
  printf '%s\t%s\n' "$label" "$code" >> /work/evidence/steps.tsv
  if ((code != 0)); then failed=1; fi
  return "$code"
}

# Frozen pnpm policy owns approved lifecycle execution; do not skip scripts or DTS.
step install pnpm install --frozen-lockfile || exit 1
python3 -I /harness/identity.py /work/source /work/evidence/source-after-install.json
step check pnpm check --base b8952d477f0c932d8ddc6da5c89cab5a169b6ff1 --include-test-types --include-architecture --timed || true
step sdk-export-map pnpm plugin-sdk:check-exports || true
step sdk-subpath-guard node --import ./scripts/tsx.mjs scripts/check-plugin-sdk-subpath-exports.mts || true
step sdk-api-diff pnpm plugin-sdk:api:diff \
  --base b8952d477f0c932d8ddc6da5c89cab5a169b6ff1 \
  --head 7494b64ee37d2cce1e9fd1873180eb35ea75f9e9 \
  --evidence /work/evidence/sdk-api-evidence.json \
  --json /work/evidence/sdk-api-diff.json \
  --summary /work/evidence/sdk-api-summary.md || true

mkdir -p /work/evidence/packages/core
if step full-package node scripts/package-openclaw-for-docker.mjs \
  --bundle-plugin mattermost --bundle-plugin codex --bundle-plugin acpx --bundle-plugin diagnostics-otel \
  --output-dir /work/evidence/packages/core \
  --output-name openclaw-2026.10.2-7494b64ee3.tgz \
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
