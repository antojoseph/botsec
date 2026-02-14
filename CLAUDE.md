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
- **halmos** — SMT-based symbolic execution. Install: `pip install halmos` or `uv tool install --python 3.12 halmos`
- **cast** (optional) — Foundry calldata decoder, installed with Foundry

Set `ANTHROPIC_API_KEY` env var for Claude Agent SDK.

## Architecture

Three-phase agent pipeline coordinated by the orchestrator via `@anthropic-ai/claude-agent-sdk` `query()`:

**Phase 1 — Parallel Analysis:**
- **Explorer Agent** (`src/agents/explorer.ts`): Opus model, read-only tools (Read/Grep/Glob). Deep static analysis of Solidity source — state mapping, access control, external calls, vulnerability hypotheses, property suggestions.
- **On-Chain Agent** (`src/agents/onchain.ts`): Sonnet model, Bash tool. Fetches Etherscan transaction data when `--address` is provided. Identifies usage patterns, anomalies, concrete test values.

**Phase 2 — Formal Verification:**
- **Verifier Agent** (`src/agents/verifier.ts`): Opus model, Bash/Read/Write/Edit tools. Writes `check_`-prefixed Halmos test functions, compiles with `forge build`, runs `halmos`, parses counterexamples, iterates on failures (up to 3 times per property).

**Phase 3 — Report Generation** (`src/report/generator.ts`): Markdown + JSON reports with verified properties, violations with counterexamples, and severity assessments.

### Key Supporting Modules

- `src/orchestrator.ts` — Builds agent definitions, system prompts, manages temp Foundry project lifecycle, streams agent output
- `src/scaffold/foundry-project.ts` — Creates temp Foundry project (`forge init`), installs halmos-cheatcodes, copies targets, configures remappings
- `src/scaffold/dependencies.ts` — Checks forge/halmos/cast availability at startup
- `src/parsers/halmos-output.ts` — Parses Halmos results: test status (PASS/FAIL/ERROR/TIMEOUT), counterexample hex→decimal, path counts, solver times
- `src/parsers/etherscan.ts` — Etherscan API types, function selector extraction, transaction summarization

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
                           [--solodit-key <key>] [-o <dir>] [--max-turns <n>]

forge-proof check
```

## Key Conventions

- ES module project (Node16 module resolution, ES2022 target)
- Strict TypeScript throughout
- Agent system prompts are hardcoded in each agent file; the orchestrator prompt is built dynamically in `orchestrator.ts`
- Halmos tests must use `check_` prefix, import `SymTest`, use `svm.createUint256()` for symbolic values, and `vm.assume()` for constraints
- Output defaults to `forge-proof-output/` directory
