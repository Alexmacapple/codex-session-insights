# codex-session-insights

Generate a report analyzing your Codex sessions.

`codex-session-insights` reads your local Codex history, extracts recurring patterns from your sessions, and renders a narrative report as both HTML and JSON.

![codex-session-insights screenshot](https://raw.githubusercontent.com/cosformula/codex-session-insights/main/assets/screenshot-1.png)

## Quick Start

Run it directly:

```bash
npx codex-session-insights
```

The default flow is:

1. Read your local Codex thread index
2. Estimate likely analysis token usage
3. Let you confirm the plan in an interactive terminal
4. Generate `report.html` and `report.json`
5. Try to open the HTML report in your browser

If you only want the estimate first:

```bash
npx codex-session-insights --estimate-only
```

If you already know what you want and do not want the confirmation flow:

```bash
npx codex-session-insights --yes
```

## What You Get

By default the tool writes:

- `~/.codex/usage-data/report.html`
- `~/.codex/usage-data/report.json`

The HTML report includes these sections:

- `At a Glance`
- `What You Work On`
- `How You Use Codex`
- `Impressive Things You Did`
- `Where Things Go Wrong`
- `Open Loops` (sessions that ended without confirmed completion)
- `Features to Try`
- `On the Horizon`
- `One More Thing`

### How the headline numbers are defined

- `Active Time` sums the gaps between consecutive rollout events, skipping any gap longer than 30 minutes. The raw first-to-last span of each thread is shown separately as `Thread span (wall clock)` in the appendix.
- `Median Turn` is the time from a user message to the assistant's final answer for that turn. It includes tool, build, and sub-agent run time, so it describes how long turns take, not how responsive the model is.
- `Tool Errors` counts non-zero command exits plus failed tool calls. Probe misses such as `rg`, `grep`, or `test` exiting 1 with nothing found are excluded and reported separately.
- `Failure Hotspots (by command)` groups failures by the program that actually ran (`git push`, `cmake`, `npm test`), not by the Codex `parsed_cmd` type, which labels most compound commands `unknown`.
- `Failure Causes` is a heuristic classification from exit code and output text (`test_failed`, `build_failed`, `git_error`, `command_not_found`, `interrupted`, and so on). `unclassified` means the cause could not be determined.
- `Session Types` and `Outcomes` only cover threads that received an LLM label. Each panel states its coverage (for example "12 of 124 labeled threads"), and the narrative sections are instructed not to extrapolate beyond it. Re-running the tool extends coverage because labels are cached.

## Typical Usage

Default run:

```bash
npx codex-session-insights
```

Lite local run for prompt and layout testing:

```bash
npx codex-session-insights --preset lite
```

Estimate first, then decide:

```bash
npx codex-session-insights --days 7 --limit 20 --facet-limit 8 --estimate-only
```

Use a custom output directory:

```bash
npx codex-session-insights --out-dir ./insights-output
```

Emit JSON to stdout instead of a terminal summary:

```bash
npx codex-session-insights --stdout-json
```

Include archived threads:

```bash
npx codex-session-insights --include-archived
```

Include sub-agent threads as well as main threads:

```bash
npx codex-session-insights --include-subagents
```

Choose the report language explicitly:

```bash
npx codex-session-insights --lang zh-CN
npx codex-session-insights --lang en
```

Use the OpenAI API instead of your local Codex CLI login:

```bash
npx codex-session-insights --provider openai --api-key $OPENAI_API_KEY
```

## Defaults

Current default analysis plan:

- `days`: `30`
- `limit`: `200`
- `facet-limit`: `50`
- `provider`: `codex-cli`
- `facet-model`: `gpt-5.6-luna`
- `fast-section-model`: `gpt-5.6-luna`
- `insight-model`: `gpt-6-astra`
- `facet-effort`: `low`
- `fast-section-effort`: `low`
- `insight-effort`: `high`

Important behavior defaults:

- `--preset lite` maps to `days=7`, `limit=20`, `facet-limit=8`, `preview=10`
- `limit` means the target number of substantive threads to include in the report, not just the first 50 indexed threads
- `facet-limit` means the max number of uncached per-thread facet analyses to run in a single report
- Report language follows a best-effort system locale check
- Main-thread analysis is the default; sub-agent threads are excluded unless you pass `--include-subagents`
- The CLI shows an estimate before running in interactive terminals
- The CLI tries to open the generated HTML report in your browser after generation

## What It Reads

- `~/.codex/state_*.sqlite` for the thread index
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for rollout events

## Requirements

- Node.js `>=20.17`
- `sqlite3` available on your system `PATH`
- Codex CLI installed if you use the default `codex-cli` provider

Supported platform status:

- macOS: expected to work
- Linux: expected to work if `sqlite3` and `codex` are installed
- Windows: not yet verified

## Privacy

The tool reads local Codex data from your machine.

- With `provider=codex-cli`, analysis is performed through your local Codex CLI session
- With `provider=openai`, prompts are sent through the OpenAI Responses API
- To avoid suggesting rules you already have, the tool reads `AGENTS.md` from `~/.codex` and from your most active project directories (up to 6,000 characters each) and includes those excerpts in the suggestion prompts. Pass `--no-repo-instructions` to skip this
- Generated reports may contain project paths, thread titles, summaries, and other local development context

Review `report.html` and `report.json` before sharing them.

## Limitations

- Rollout event schemas may drift across Codex versions. Version 0.3.0 and later read both the legacy `user_message` / `exec_command_end` events and the `item_completed` events written by Codex CLI 0.15x+
- Model names are those exposed to ChatGPT-backed Codex accounts as of September 2026; if a default model is retired, the tool falls back to the closest available model automatically
- Token estimates are conservative, not billing-accurate
- Failure causes are classified by pattern matching on exit codes and command output; unusual toolchains may land in `unclassified`
- Turn timing and active time are derived from rollout event timestamps, so they cannot separate time spent waiting on a sub-agent from time spent by the main agent
- The tool is designed around Codex local storage layout and is not a generic agent log analyzer
- Windows support is not yet verified

## Advanced Overrides

If you want to override the default model split manually:

```bash
npx codex-session-insights \
  --facet-model gpt-5.6-luna \
  --fast-section-model gpt-5.6-luna \
  --insight-model gpt-6-astra \
  --facet-effort low \
  --fast-section-effort low \
  --insight-effort high
```

To suppress browser opening:

```bash
npx codex-session-insights --no-open
```

To force browser opening:

```bash
npx codex-session-insights --open
```

## For Contributors

Useful local commands:

```bash
npm install
npm test
npm run check
npm run report:lite
npm run generate:test-report
```

`npm run report:lite` runs a smaller local analysis preset for testing prompt and layout changes without paying the full 200/50 default cost.
`npm run generate:test-report` writes a deterministic sample report page to `test-artifacts/sample-report/`.

### Releasing

Publishing is automated by `.github/workflows/release.yml` and uses npm Trusted Publishing, so no npm token is stored in GitHub.

1. Bump `version` in `package.json` and commit.
2. Tag the commit with the same version and push the tag:

```bash
git tag v0.4.0
git push origin main --tags
```

The workflow runs `npm run check` and `npm test`, verifies the tag matches `package.json`, publishes to npm, installs the published package as a smoke test, and creates a GitHub Release with generated notes.

One-time setup on npmjs.com: open the package settings, add a trusted publisher for GitHub Actions with repository `cosformula/codex-session-insights` and workflow `release.yml`.
