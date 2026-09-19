# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Forge Proof (`forge-proof`) is a TypeScript CLI that uses the Claude Agent SDK to orchestrate specialized agents for smart contract security analysis with formal verification via Halmos symbolic execution.

## Build & Run Commands

```bash
npm install                              # Install dependencies
npm run build                            # Compile TypeScript (tsc → dist/)
npm run dev -- analyze ./contract.sol    # Run directly via tsx (development)
npm run dev -- check                     # Verify external tool dependencies
npm run start -- analyze ./contract.sol  # Run from compiled dist/
```

Run `npm test` for focused regression tests (Node 22.12+; uses Node's experimental module mocking). Full pipeline validation uses the `benchmarks/targets/` contracts.

## Required External Tools

- **forge** (Foundry) — Solidity compiler. Install: `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- **halmos** — SMT-based symbolic execution. Install: `uv tool install --python 3.12 halmos` (requires Python >= 3.11; plain `pip install halmos` fails on older system Pythons)
- **cast** (optional) — Foundry calldata decoder, installed with Foundry

Provide a credential for the Claude Agent SDK via any of:
- `ANTHROPIC_API_KEY` — Anthropic API
- `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` — LLM gateway (e.g. OpenRouter; note OpenRouter requires `ANTHROPIC_API_KEY` to be explicitly empty)
- `CLAUDE_CODE_USE_BEDROCK=1` / `CLAUDE_CODE_USE_VERTEX=1`
- a stored `ant auth login` profile

`src/scaffold/dependencies.ts:checkCredentials()` resolves these. Never gate on `ANTHROPIC_API_KEY` alone.

## Architecture

Three-phase agent pipeline coordinated by the orchestrator via `@anthropic-ai/claude-agent-sdk` `query()`:

**Phase 1 — Parallel Analysis:**
- **Explorer Agent** (`src/agents/explorer.ts`): Opus model, read-only tools (Read/Grep/Glob). Deep static analysis of Solidity source — state mapping, access control, external calls, vulnerability hypotheses, property suggestions.
- **On-Chain Agent** (`src/agents/onchain.ts`): Sonnet model, Bash tool. Fetches Etherscan transaction data when `--address` is provided. Identifies usage patterns, anomalies, concrete test values.

**Phase 2 — Formal Verification:**
- **Verifier Agent** (`src/agents/verifier.ts`): Opus model, Bash/Read/Write/Edit tools. Writes `check_`-prefixed Halmos test functions, compiles with `forge build`, runs `halmos`, parses counterexamples, iterates on failures (up to 3 times per property).

**Phase 3 — Report Generation** (inline in `src/orchestrator.ts`): the SDK's final `result` string is written as Markdown + JSON to a timestamped run directory.

**Phase 4 — Spec Audit** (inline in `src/orchestrator.ts`, after the agent finishes): everything up to Phase 3 is the agent's own account of its work. Phase 4 re-derives the results independently and then attacks the spec:
- **Vacuity classification** (on by default, `--no-audit-spec` to skip) — re-runs Halmos with `--json-output`. A property whose paths all reverted never evaluated its assertion; reporting it as "verified" is a false assurance, so it is classified `vacuous` instead.
- **Mutation testing** (`--mutation-test`) — injects bugs into the contract and re-runs the verified properties. A surviving mutant is a bug the spec does not detect. Costs no model tokens; it is forge + halmos only.
  - A mutant is **killed only when a property becomes `violated`**. A property that merely stops being `verified` may have gone `vacuous` because the mutation broke its `setUp` — it detected nothing. Mutants where nothing was violated but properties stopped executing are `inconclusive` and excluded from the score.

### Key Supporting Modules

- `src/orchestrator.ts` — Builds agent definitions, system prompts, manages temp Foundry project lifecycle, streams agent output
- `src/scaffold/foundry-project.ts` — Creates temp Foundry project (`forge init`), installs halmos-cheatcodes, copies targets, configures remappings
- `src/scaffold/dependencies.ts` — Checks forge/halmos/cast availability at startup
- `src/verification/halmos-json.ts` — Runs Halmos with `--json-output` and classifies each result as `verified` / `violated` / `vacuous` / `error`. Structured ingestion, not stdout scraping
- `src/mutation/operators.ts` — Enumerates mutations from the solc AST (require-removal, comparison-boundary, arithmetic-swap, state-write-removal)
- `src/mutation/runner.ts` — Applies mutants, rebuilds, re-runs the suite, scores the spec
- `src/threat-model/providers/` — Pluggable pipeline: precompute / enrichment / synthesis-filter / output providers, registered in `providers/registry.ts`. CLI flags are generated from each provider's `ProviderMeta`.

### Threat Model Pipeline

Separate `threat-model` command generates a structured threat model before formal verification:

- `src/threat-model/types.ts` — ThreatModel, Threat, CodeTrace, StructuralAnalysis, OnChainProfile schemas
- `src/threat-model/ast-analysis.ts` — Structural analysis from solc AST (`forge build --build-info`): call graphs, state var read/write maps, inheritance, function summaries, operation ordering (CEI detection), msg.sender auth checks, require/assert inventory, data dependency with taint tracking. Zero external dependencies.
- `src/threat-model/precompute.ts` — Pre-computation: `forge build --build-info` + `forge inspect` + optional Etherscan v2 transaction data
- `src/threat-model/orchestrator.ts` — Pipeline: precompute → agent explore → Solodit enrich → synthesize
- `src/threat-model/solodit.ts` — Solodit API integration for historical vulnerability matching
- `src/agents/threat-modeler.ts` — Opus agent with 7 systematic xref patterns (CEI timeline, reverse xref, source-to-sink tracing, etc.). Every threat requires a TRACE showing exact code locations traversed.

The threat model operates directly on the user's Foundry project (no temp scaffolding). Output is `threat-model.json`, consumable by `analyze --threat-model`.

## CLI Options

```
forge-proof analyze <path> [--address <addr>] [--chain <id>] [--etherscan-key <key>]
                           [--loop <n>] [--solver-timeout <ms>] [--max-turns <n>]
                           [-o <dir>] [--threat-model <file>]

forge-proof threat-model <foundry-project-path>
                           [--address <addr>] [--chain <id>] [--etherscan-key <key>]
                           [--solodit] [--solodit-key <key>] [-o <dir>]
                           [--max-turns <n>] [--max-budget <usd>] [--allow-npm-install]
                           [--no-ast] [--no-inspect] [--no-blueprint]
                           [--no-anti-slop] [--no-self-contradiction]
                           [--no-dedup] [--no-ranking]

forge-proof check
```

## Key Conventions

- ES module project (Node16 module resolution, ES2022 target)
- Agent definitions use the SDK's own `AgentDefinition` type (re-exported from `src/agents/explorer.ts`) — do not hand-roll a copy
- Every agent sets `omitClaudeMd: true` and both orchestrators set `settingSources: []`: the cwd is the **untrusted audit target**, and the agents run with `permissionMode: "bypassPermissions"`. Never load instructions or settings from the target
- `npm install` inside a target is opt-in via `--allow-npm-install` (it runs with `--ignore-scripts`, so the target's lifecycle scripts are NOT executed)
- Strict TypeScript throughout
- Agent system prompts are hardcoded in each agent file; the orchestrator prompt is built dynamically in `orchestrator.ts`
- Halmos tests must use `check_` prefix, import `SymTest`, use `svm.createUint256()` for symbolic values, and `vm.assume()` for constraints
- Generated tests live in `.forge-proof/test/`, which is outside Foundry's default source paths. `HALMOS_ENV` (`src/scaffold/foundry-project.ts`) exports `FOUNDRY_TEST=.forge-proof/test` so forge and halmos see them, and `FOUNDRY_DYNAMIC_TEST_LINKING=false` because Foundry >= 1.3 otherwise rewrites `new Contract()` into a `vm.deployCode(string)` cheatcode that Halmos cannot execute (setUp() then fails on every test)
- Halmos selects tests by contract/function name: `--match-contract`, `--match-test`, `--function`. There is **no** `--match-path`, and `forge build --extra-output-files none` is not valid
- The scaffold does **not** pin `solc_version` — pinning makes any newer-pragma contract un-analyzable

### Halmos / Foundry gotchas (all verified empirically, do not "simplify" these)

- **`forge build --ast` vs `--build-info` populate different files.** Halmos reads an `ast` field from each artifact JSON (`out/<File>.sol/<Contract>.json`) and needs `--ast`; without it it skips every contract with `KeyError: 'ast'`, reports "No tests", and writes no JSON — which looks like a mutant killing every property rather than a broken build. Mutation *enumeration* instead needs `output.sources[*].ast` in `out/build-info/*.json`, which comes from `--build-info`. Adding `--ast` to a `--build-info` run yields build-info with **no** AST at all
- **solc `src` offsets are BYTE offsets.** A single em-dash in a comment desynchronises JS string indices from them, so all mutation source handling uses `Buffer`, never `string`
- **solc statement ranges exclude the trailing semicolon.** Replacing a statement without extending over it leaves a stray `;`, which Solidity rejects. Replacement text is `{}` (an empty block), never `true;` — that is not valid Solidity
- **Halmos JSON counterexamples exceed `Number.MAX_SAFE_INTEGER`.** `JSON.parse` silently corrupts uint256 values into floats, so numeric `value` fields are quoted before parsing
- **Halmos exit codes:** `0` no counterexample, `1` counterexample, `2` CLI error, `4` every path reverted (vacuous). Exit `4` and a clean pass are indistinguishable without reading the JSON
- **Operators can appear inside comments.** `if (x > /* > */ 1)` — searching the span between two operands naively lands the edit in the comment, producing a semantically identical "mutant" that always survives and is then reported as a spec gap. Comments and string literals are masked before the operator search
- **`state-write-removal` covers plain `=` assignments only when the target is a STATE variable**, resolved through a cross-file declaration map (inherited state lives in a different file). Mutating local writes says nothing about the spec
- **A suite with no `check_` functions is a legitimate outcome, not an error.** `runHalmos` returns an empty result when halmos reports "No tests with ..." rather than throwing
- **`forge build --force` does not remove stale artifacts.** Halmos reads artifacts, not sources, so a renamed or rewritten test contract leaves a phantom suite that still runs. Observed: a 4-property spec reporting an 8-property baseline. The spec audit and the mutation baseline both `forge clean` first
- `analyze` asserts that verification left artifacts behind: if `.forge-proof/test/` contains no `.sol` files after the run, it throws instead of writing a report. Orchestrator models routed through a gateway sometimes end their turn believing the synchronous Task tool is asynchronous, and a security tool must not report success for a run that verified nothing
- Output defaults to `forge-proof-output/` directory
