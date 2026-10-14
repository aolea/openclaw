# Manual Infuse custom canary qualification

This build-only bootstrap binds the exact v2026.10.3 custom source in
`binding.json` and `.github/workflows/ci.yml`. It reuses the qualified C4
secretless Docker boundary, source/artifact inspection, resource budgets,
compiler metrics, canonical package composition and failure-evidence upload.

Only manual dispatch on `codex/v2026.10.3-infuse-canary-build` in the existing
public fork `aolea/openclaw` runs this workflow. There are no selectable source
inputs, production credentials, package publication or deployment stages.
Schedules remain disabled. The job has a measured 240-minute deadline.

After a normal frozen install and source identity check, the five effective
tool-inventory suites run first and fail immediately before expensive checks.
All complete source/type/lint/format/policy/architecture, SDK/API, focused E2E,
Core packaging and four matching plugin-package stages remain required.

Runner release values derive from the protected harness binding. Before and
after source identities, command/log/cgroup exit custody, the full compiler
graph metrics and sanitized archive inventories must match that binding.
A completed run and independent artifact authentication are required before
claiming qualification; preparation alone establishes no runtime result.
