# Forge Proof

AI-powered smart contract security analysis with formal verification. Uses Claude Opus with 1M context + Halmos symbolic execution to find real bugs with mathematical proof, not pattern matching.

```
  ___                      ___                 __
 / __\___  _ __ __ _  ___ / _ \_ __ ___   ___ / _|
/ _\/ _ \| '__/ _` |/ _ \ /_)/ '__/ _ \ / _ \ |_
/ / | (_) | | | (_| |  __/ ___/| | | (_) | (_) |  _|
\/   \___/|_|  \__, |\___\/    |_|  \___/ \___/|_|
               |___/
```

## How It Works

Two-stage pipeline: **threat model** identifies what to look for, **analyze** proves it with Halmos.

### Stage 1: `forge-proof threat-model <project>`

Generates a ranked threat model for a Foundry project.

1. **Pre-computation** — Builds the project, walks the solc AST to extract call graphs, state variable maps, inheritance, CEI ordering, auth checks, guards, and data dependencies. Auto-installs npm dependencies if needed. Writes structural data to `.forge-proof/blueprint.json` and `.forge-proof/codemap.json`.
2. **LLM classification** — Haiku classifies the contract type (vault, lending, dex, staking, etc.) to inform invariant inference and investigation questions.
3. **Agentic exploration** — Opus agent reads the blueprint and code map files on-demand (file-based context — no prompt size limits). Traces code paths using 7 systematic cross-referencing patterns. Every threat requires a TRACE with exact file:line locations.
4. **Synthesis** — Anti-slop filter drops traceless threats, self-contradiction filter downgrades threats that exonerate themselves, deduplication merges overlapping findings, threats ranked by severity x confidence.

Output: `threat-model.json` + `blueprint.json`

### Stage 2: `forge-proof analyze <project> --threat-model <file>`

Formally verifies threats using Halmos symbolic execution.

1. **Explorer Agent** (Opus) — Validates known threats from the threat model, identifies additional ones
2. **On-Chain Agent** (Sonnet) — Fetches Etherscan v2 transaction data for concrete test values *(optional)*
3. **Verifier Agent** (Opus) — Writes `check_` Halmos tests, compiles, runs the SMT solver, interprets counterexamples. If Halmos times out (common with assembly math), falls back to Foundry fuzz testing with 1M runs.

Use `--verify-only` to restart just the verification phase without re-running exploration.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **Node.js** (20+) | Yes | [nodejs.org](https://nodejs.org) |
| **Foundry** (forge, cast) | Yes | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| **Halmos** | Yes | `pip install halmos` or `uv tool install --python 3.12 halmos` |
| **Anthropic API Key** | Yes | `export ANTHROPIC_API_KEY=sk-ant-...` |

```bash
forge-proof check   # Verify dependencies
```

## Quick Start

```bash
npm install
npm run build

# 1. Generate threat model
npm run dev -- threat-model ./my-defi-project

# 2. Formally verify the threats
npm run dev -- analyze ./my-defi-project --threat-model ./forge-proof-output/threat-model.json

# 3. If verification is interrupted, restart just that phase
npm run dev -- analyze ./my-defi-project --threat-model ./forge-proof-output/threat-model.json --verify-only
```

### With on-chain data

```bash
npm run dev -- threat-model ./my-defi-project --address 0x1234... --etherscan-key YOUR_KEY
npm run dev -- analyze ./my-defi-project --threat-model ./forge-proof-output/threat-model.json \
  --address 0x1234... --etherscan-key YOUR_KEY
```

## CLI Reference

```
forge-proof threat-model <project-path>
  --address <addr>          On-chain contract address (Etherscan v2 enrichment)
  --chain <id>              Chain ID [default: 1]
  --etherscan-key <key>     Etherscan API key
  --solodit                 Enable Solodit historical vulnerability enrichment
  --solodit-key <key>       Solodit API key
  --cost-control            Truncate code map to reduce token usage
  -o, --output <dir>        Output directory [default: forge-proof-output]
  --max-turns <n>           Max agent turns [default: 200]

forge-proof analyze <path>
  --threat-model <file>     Threat model JSON from Stage 1
  --verify-only             Skip exploration, run verification only (requires --threat-model)
  --address <addr>          On-chain contract address
  --chain <id>              Chain ID [default: 1]
  --etherscan-key <key>     Etherscan API key
  --loop <n>                Halmos loop bound [default: 3]
  --solver-timeout <ms>     SMT solver timeout [default: 10000]
  --max-turns <n>           Max agent turns [default: 500]
  -o, --output <dir>        Output directory [default: forge-proof-output]

forge-proof check           Verify dependencies
```

## Architecture

```
threat-model <project>                    analyze <project> --threat-model <file>
  |                                         |
  +-- Pre-Computation                       +-- Detect Foundry project or scaffold
  |   forge build --build-info              |
  |   solc AST -> structural analysis       +-- Load threat-model.json
  |   Haiku -> contract classification      |   Inject threats into orchestrator prompt
  |   -> blueprint + invariants             |
  |   Write .forge-proof/blueprint.json     +-- Phase 1: Parallel Analysis
  |   Write .forge-proof/codemap.json       |   Explorer (Opus) + On-Chain (Sonnet)
  |                                         |   [skipped with --verify-only]
  +-- Agentic Exploration                   |
  |   Threat Modeler (Opus, 1M context)     +-- Phase 2: Formal Verification
  |   Reads files on-demand via Read/Grep   |   Verifier (Opus)
  |   7 xref patterns, untrusted-actor      |   check_ tests -> halmos
  |   focus, anti-slop trace requirement    |   Timeout -> fuzz fallback (1M runs)
  |                                         |
  +-- Synthesis                             +-- Final Report
  |   Anti-slop filter                      |   Verified properties
  |   Self-contradiction filter             |   Violations + counterexamples
  |   Deduplication (>50% overlap)          |   Fuzz results
  |   Threat ranking                        |   Inconclusive + limitations
  |                                         |
  v                                         v
  threat-model.json ----------------------> Console output
  blueprint.json
```

## Key Design Decisions

**File-based context** — Pre-computed structural data (blueprint + code map) is written to `.forge-proof/` directory files. The threat modeler agent reads them on-demand via Read/Grep tools instead of having them inline in the prompt. This keeps the system prompt at ~5KB regardless of codebase size, enabling analysis of 500+ contract projects.

**Untrusted-actor focus** — The threat modeler is instructed to skip admin/owner misconfiguration scenarios and focus exclusively on what an unprivileged attacker can exploit. This avoids governance-heavy threat models that waste verification budget.

**Anti-slop trace requirement** — Every threat must include a TRACE with exact code locations the agent read. Threats without traces are dropped in synthesis. Self-contradicting threats (description says "properly handled") are automatically downgraded.

**Halmos -> fuzz fallback** — Solmate's `mulDivDown`/`mulDivUp` assembly reliably times out Halmos's SMT solver. When this happens, the verifier converts `check_` functions to `test_fuzz_` and runs them with `forge test --fuzz-runs 1000000`. Fuzz results are reported separately as probabilistic evidence.

## AST Analysis Engine

`src/threat-model/ast-analysis.ts` (~1000 lines) extracts structural data from the solc AST with zero external dependencies.

| Feature | What It Extracts |
|---------|-----------------|
| **Call graph** | Internal + external calls, cross-contract resolution, low-level calls |
| **State variable map** | Per-variable: read-by, written-by, type, visibility |
| **Inheritance** | Direct parent contracts |
| **Function summaries** | Visibility, modifiers, state vars read/written, calls |
| **Operation ordering** | Execution-order per function (CEI violation detection) |
| **Auth checks** | msg.sender conditions via modifiers and inline require/if-revert |
| **Guard inventory** | require/assert/revert with condition summaries |
| **Data dependency** | Transitive variable influence with taint tracking |

## Tested On

| Project | Contracts | Threats Found | Cost | Time |
|---------|-----------|---------------|------|------|
| Project Alpha | 267 | 8 (2M, 6L) | ~$19 | ~7min |
| Project Beta | 557 | 10 | ~$5 | ~10min |
| Project Gamma | 800+ | 9 (1H, 3M, 5L) | ~$5 | ~10min |
| Project Gamma (full analyze) | 800+ | 9/9 confirmed, 2 Halmos proofs | ~$32 | ~39min |

## Source Structure

```
src/
  index.ts                          CLI entry point (3 commands)
  orchestrator.ts                   Analyze pipeline coordinator
  agents/
    explorer.ts                     Deep code analysis (read-only)
    onchain.ts                      Etherscan transaction analysis
    threat-modeler.ts               Threat modeling (file-based context)
    verifier.ts                     Halmos tests + fuzz fallback
  threat-model/
    orchestrator.ts                 Threat model pipeline coordinator
    precompute.ts                   AST + forge inspect + Etherscan v2
    ast-analysis.ts                 solc AST structural extraction (~1000 lines)
    architecture-analyzer.ts        Blueprint: LLM classification, attack surface, invariants
    types.ts                        Shared type definitions
    solodit.ts                      Historical vulnerability search
  scaffold/
    foundry-project.ts              Temp Foundry project creation
    dependencies.ts                 forge/halmos/cast validation
  parsers/
    halmos-output.ts                Halmos result parser
    etherscan.ts                    Etherscan API types
  report/
    generator.ts                    Markdown + JSON report (not yet wired)
```

~5,350 lines of TypeScript across 17 source files.

## Current Status

### What's Connected

- Threat model -> analyze workflow via `--threat-model`
- Verify-only mode for restarting interrupted runs
- File-based context for large codebases
- LLM contract classification
- Anti-slop, self-contradiction, and deduplication filters
- Halmos -> Foundry fuzz fallback
- Blueprint persistence to disk

### What's Disconnected

- **Report generation** — `src/report/generator.ts` is fully implemented but never called. Analysis results are streamed as console text, not parsed into structured reports.
- **`--output` flag** — Unused by the analyze orchestrator.

### TODO

- [ ] Wire report generation into analyze pipeline
- [ ] Temp directory cleanup (`/tmp/forge-proof-*` accumulates)
- [ ] Auto-detect solc pragma version
- [ ] Merge existing remappings from target project
- [ ] Unit tests for parsers and AST analysis
- [ ] Integration tests on benchmark contracts
- [ ] Resume interrupted analysis (checkpoint intermediate state)

## License

MIT
