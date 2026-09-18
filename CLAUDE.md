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

There is no test suite. Validation is done by running against `benchmarks/targets/` contracts.

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

### Key Supporting Modules

- `src/orchestrator.ts` — Builds agent definitions, system prompts, manages temp Foundry project lifecycle, streams agent output
- `src/scaffold/foundry-project.ts` — Creates temp Foundry project (`forge init`), installs halmos-cheatcodes, copies targets, configures remappings
- `src/scaffold/dependencies.ts` — Checks forge/halmos/cast availability at startup
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
- `npm install` inside a target is opt-in via `--allow-npm-install` (it executes the target's lifecycle scripts)
- Strict TypeScript throughout
- Agent system prompts are hardcoded in each agent file; the orchestrator prompt is built dynamically in `orchestrator.ts`
- Halmos tests must use `check_` prefix, import `SymTest`, use `svm.createUint256()` for symbolic values, and `vm.assume()` for constraints
- Generated tests live in `.forge-proof/test/`, which is outside Foundry's default source paths. `HALMOS_ENV` (`src/scaffold/foundry-project.ts`) exports `FOUNDRY_TEST=.forge-proof/test` so forge and halmos see them, and `FOUNDRY_DYNAMIC_TEST_LINKING=false` because Foundry >= 1.3 otherwise rewrites `new Contract()` into a `vm.deployCode(string)` cheatcode that Halmos cannot execute (setUp() then fails on every test)
- Halmos selects tests by contract/function name: `--match-contract`, `--match-test`, `--function`. There is **no** `--match-path`, and `forge build --extra-output-files none` is not valid
- The scaffold does **not** pin `solc_version` — pinning makes any newer-pragma contract un-analyzable
- Output defaults to `forge-proof-output/` directory
