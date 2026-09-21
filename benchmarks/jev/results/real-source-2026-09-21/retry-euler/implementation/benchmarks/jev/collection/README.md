# Real-source collection

This collection uses the production threat-model generator and filters with optional evidence capture. It does not integrate Jev into production or replace independent labeling. The original pilot and its labels remain unchanged.

## Generate raw findings

```sh
npm run build
node benchmarks/jev/collection/prepare.mjs
# Use the printed preparation.json path. OPENROUTER_API_KEY must be in the environment.
node benchmarks/jev/collection/collect.mjs --preparation /path/to/preparation.json --out benchmarks/jev/runs/collection
```

Preparation checks retained compiler-input hashes, copies only Solidity source and a generated Foundry configuration into neutral temporary project directories, and preserves conflicting compilation versions in separate `context/` units. The primary units supply AST/blueprint analysis; the agent can read the additional source context. This is scoped source analysis, not a claim of whole-protocol coverage. Exploit scripts, postmortems, labels and provenance manifests stay outside model access. Sources retain their original names/comments, so public-incident memorization remains possible.

The collector uses Sonnet 4.6 through OpenRouter with the existing Haiku classification call. It records one consecutive attempt per project. Default overall generation budget is $15, including classification; each SDK run has a $4 guard and 60-turn limit. `--budget` can lower the overall budget, and `--only project-01` can select a prepared project. It never overwrites an earlier collection. Partial/failed attempts stay in the evidence and are excluded from completed-run datasets; any infrastructure retry must be separately recorded, not silently substituted.

The local gateway reserves a conservative upper-bound request cost before forwarding a call. It settles using the API's returned `usage.cost`, with a generation-record lookup fallback. Unknown bills retain their full reservation. It allows only the two selected models and up to 8,192 output tokens per call. The gateway preserves usage, billing, timing and response IDs, without saving credentials or arbitrary server errors. SDK-reported cost is also retained but is not treated as the complete bill: the separate classifier is included in the gateway ledger.

The generator's new options can also be used directly:

```sh
node dist/index.js threat-model /path/to/prepared-project --capture-raw --source-only --max-budget 4
```

`--capture-raw` saves:

- The original parsed agent output and completion/parse status, distinguishing failures from valid empty results.
- Normalized raw findings before enrichment and synthesis, plus the exact pre-synthesis input.
- Every filter's complete input/output and duration, preserving removed findings and in-place mutations.
- Source/configuration hashes, exact prompts/schema, enabled provider IDs and observed model names.

`--source-only` limits both the orchestrator and threat-modeler to Read/Grep/Glob in the prepared workspace, plus synchronous delegation and structured output. A pre-tool hook rejects other tools, outside paths and traversal; symlink-containing workspaces are rejected. External enrichment is disabled. This is a model tool boundary; it is not an OS sandbox for running arbitrary project build scripts. The provided preparer supplies a generated build configuration and does not copy upstream scripts.

## Blind review and shadow comparison

```sh
node benchmarks/jev/collection/review.mjs --collection benchmarks/jev/runs/collection --out benchmarks/jev/runs/review
node benchmarks/jev/collection/compare.mjs --cases benchmarks/jev/runs/review/cases.json --out benchmarks/jev/runs/shadow
# Offline baseline only: add --offline and use a separate output directory.
```

Every raw finding and every unordered within-project pair from completed runs is retained. No synthetic positives are introduced and no cases are selected by model decisions. The Jev replay uses the original pilot's frozen questions and actual production baselines, with one repeat and a $1 budget. It reports actions, abstentions, disagreements, errors, latency and cost. Accuracy stays null until labels exist. Pair comparisons do not establish whole-report grouping quality.

Give each reviewer only `blind-packet.json` and their own blank reviewer file. Keep model decisions, baseline outputs and filter stages separate. Two different human security reviewers must supply labels and rationales; then:

```sh
node benchmarks/jev/collection/adjudicate.mjs --cases /path/to/cases.json --a /path/to/reviewer-a.json --b /path/to/reviewer-b.json --out /path/to/adjudication.json
```

Matching votes are preserved as agreements. Disputes retain both votes and a null final label for third-review adjudication. Blank labels, duplicate cases, mismatched dataset hashes and identical reviewer identities are rejected. Reviewer identity is an attestation supplied by the reviewers, not independently authenticated by the tool.

The [expansion plan](expansion-plan.json) lists 14 prospective projects grouped into 12 conservative implementation families, including ordinary production projects. It preassigns development/held-out roles, keeping related implementations together. The nine additional incident/ordinary entries and two additional ordinary entries still need source matching and scoped inputs; they are not completed benchmark data. All three already-studied incidents are development. Do not open held-out model predictions before freezing the rubric, prompts and decision thresholds.
