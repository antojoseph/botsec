# Forge Proof

AI-powered formal verification for smart contracts. Uses Claude Opus + Halmos symbolic execution to find real bugs with mathematical proof, not just pattern matching.

```
  ___                      ___                 __
 / __\___  _ __ __ _  ___ / _ \_ __ ___   ___ / _|
/ _\/ _ \| '__/ _` |/ _ \ /_)/ '__/ _ \ / _ \ |_
/ / | (_) | | | (_| |  __/ ___/| | | (_) | (_) |  _|
\/   \___/|_|  \__, |\___\/    |_|  \___/ \___/|_|
               |___/
```

## What It Does

Forge Proof provides a two-stage workflow: **threat model** then **analyze**.

### Stage 1: `forge-proof threat-model`

Generates a structured threat model for a Foundry project:

1. **Pre-computation** — Walks the solc AST to extract call graphs, state variable maps, inheritance, CEI ordering, auth checks, guards, and data dependency from concrete contracts (interfaces and libraries are auto-filtered). Optionally fetches Etherscan v2 transaction data.
2. **Agentic exploration** — An Opus agent with 7 systematic xref patterns traces code paths using the pre-computed structural data. Every threat must include a TRACE with real code locations (anti-slop filter).
3. **Synthesis** — Queries Solodit API for historical findings, ranks threats by severity x confidence x on-chain activity, drops untraced threats.

Output: `threat-model.json` with ranked threats, code traces, and suggested Halmos properties.

### Stage 2: `forge-proof analyze`

Runs three specialized AI agents to formally verify the contract:

1. **Explorer Agent** (Opus, read-only) — Deep static analysis: maps state variables, traces external calls, identifies reentrancy surfaces, produces vulnerability hypotheses and property suggestions. When a threat model is provided via `--threat-model`, the explorer **validates known threats** instead of discovering from scratch, and identifies any additional threats.
2. **On-Chain Agent** (Sonnet, Bash) — Fetches real transaction data from Etherscan v2 to identify usage patterns, anomalies, and concrete test parameters *(optional, requires `--address`)*
3. **Verifier Agent** (Opus, read/write/bash) — Writes Halmos symbolic tests (`check_` functions), compiles with Forge, runs the SMT solver, interprets counterexamples, iterates on specs. When a threat model is provided, **Critical/High threats and their suggested properties are prioritized first**.

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **Node.js** (20+) | Yes | [nodejs.org](https://nodejs.org) |
| **Foundry** (forge, cast) | Yes | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| **Halmos** | Yes | `pip install halmos` or `uv tool install --python 3.12 halmos` |
| **Anthropic API Key** | Yes | `export ANTHROPIC_API_KEY=sk-ant-...` |
| **Etherscan API Key** | Optional | For on-chain analysis: `export ETHERSCAN_API_KEY=...` |

Verify your setup:

```bash
forge-proof check
```

## Quick Start

```bash
npm install
npm run build

# 1. Generate a threat model for your Foundry project
forge-proof threat-model ./my-defi-project -o ./out

# 2. Run formal verification, guided by the threat model
forge-proof analyze ./my-defi-project/src/Vault.sol --threat-model ./out/threat-model.json

# Or analyze a standalone contract without a threat model
forge-proof analyze ./contracts/Vault.sol

# With on-chain transaction analysis (both stages)
forge-proof threat-model ./my-defi-project --address 0x1234... --etherscan-key YOUR_KEY -o ./out
forge-proof analyze ./my-defi-project/src/Vault.sol --threat-model ./out/threat-model.json \
  --address 0x1234... --etherscan-key YOUR_KEY
```

### Development

```bash
npm run dev -- threat-model ./my-project        # Threat model via tsx
npm run dev -- analyze ./contracts/Vault.sol    # Analyze via tsx
npm run dev -- check                             # Dependency check
```

## CLI Reference

```
forge-proof analyze <path>
  --address <addr>          On-chain contract address (enables on-chain agent)
  --chain <id>              Chain ID: 1=mainnet, 8453=base, 42161=arbitrum [default: 1]
  --etherscan-key <key>     Etherscan API key (or ETHERSCAN_API_KEY env var)
  --loop <n>                Halmos loop unrolling bound [default: 3]
  --solver-timeout <ms>     SMT solver timeout in ms [default: 10000]
  --max-turns <n>           Max agent reasoning turns [default: 500]
  -o, --output <dir>        Output directory [default: forge-proof-output]
  --threat-model <file>     Path to threat model JSON (from threat-model command)

forge-proof threat-model <foundry-project-path>
  --address <addr>          On-chain contract address (optional, Etherscan v2 enrichment)
  --chain <id>              Chain ID [default: 1]
  --etherscan-key <key>     Etherscan API key (or ETHERSCAN_API_KEY env var)
  --solodit-key <key>       Solodit API key (or SOLODIT_API_KEY env var)
  -o, --output <dir>        Output directory [default: forge-proof-output]
  --max-turns <n>           Max agent reasoning turns [default: 200]

forge-proof check           Verify dependencies are installed
```

## Benchmark Contracts

The `benchmarks/` directory contains intentionally vulnerable contracts for testing:

| Contract | Vulnerability | File |
|----------|---------------|------|
| VulnerableVault | Reentrancy (CEI violation — external call before state update) | `benchmarks/targets/reentrancy-vault.sol` |
| InflatableVault | ERC4626 first-depositor inflation attack | `benchmarks/targets/erc4626-inflation.sol` |
| FeeVault | Insolvency from fee-on-transfer tokens | `benchmarks/targets/fee-on-transfer.sol` |

## Architecture

### End-to-End Workflow

```
forge-proof threat-model <project>          forge-proof analyze <path> --threat-model <file>
  │                                           │
  ├─ Phase 0: Pre-Computation                 ├─ Scaffold temp Foundry project
  │  solc AST → call graphs, state vars,      │  (copy contracts, install halmos-cheatcodes)
  │  CEI ordering, auth, guards, deps         │
  │  forge inspect → ABI, storage, methods    ├─ Load threat-model.json (if provided)
  │  Etherscan v2 → tx data (if --address)    │  Inject ranked threats + suggested properties
  │                                           │  into orchestrator prompt
  ├─ Phase 1: Agentic Exploration             │
  │  Threat Modeler Agent (Opus)              ├─ Phase 1: Parallel Analysis
  │  7 xref patterns, pre-seeded code map     │  ┌──────────────────────┐ ┌─────────────────┐
  │  Every threat → TRACE with code locs      │  │ Explorer (Opus)      │ │ On-Chain (Sonnet)│
  │                                           │  │ Validates threats     │ │ Etherscan v2     │
  ├─ Phase 2: Synthesis                       │  │ from threat model,   │ │ Usage patterns,  │
  │  Solodit API → historical findings        │  │ finds new ones       │ │ concrete values  │
  │  Anti-slop filter, threat ranking         │  └──────────────────────┘ └─────────────────┘
  │                                           │
  ▼                                           ├─ Phase 2: Formal Verification
  threat-model.json ─────────────────────────>│  Verifier Agent (Opus)
                                              │  Prioritizes Critical/High threats
                                              │  Writes check_ tests → forge build → halmos
                                              │  Interprets counterexamples, iterates (3x)
                                              │
                                              ▼
                                              Console output
```

## AST Analysis Engine

`src/threat-model/ast-analysis.ts` (~1000 lines) extracts structural data from the solc AST with zero external dependencies. Verified at 100% feature parity with Slither's structural analysis on benchmark contracts.

| Feature | What It Extracts |
|---------|-----------------|
| **Call graph** | Internal + external calls per function, cross-contract resolution via global AST ID map, low-level calls (.call/.transfer/.delegatecall). Interfaces and libraries excluded. |
| **State variable map** | Per-variable: which functions read it, which write it, type, visibility |
| **Inheritance** | Direct parent contracts per contract |
| **Function summaries** | Visibility, modifiers, state vars read/written, internal/external calls. Concrete and abstract contracts only. |
| **Operation ordering** | Execution-order operations per function — enables direct CEI violation detection (state-write after external-call) |
| **Auth checks** | msg.sender conditions via modifiers and inline require/if-revert patterns |
| **Guard inventory** | require/assert/revert statements with human-readable condition summaries |
| **Data dependency** | Transitive variable influence (A depends on B depends on C → A depends on C), compound assignment self-deps |
| **Taint tracking** | Variables influenced by msg.sender, msg.value, tx.origin, or public function parameters |

Tested against damn-vulnerable-defi: 406 functions, 159 call graph entries, 131 state variables, 31 inheritance relations, 107 data dependency graphs.

---

## Current Status: v0.1.0

~4,060 lines of TypeScript across 16 source files. Both pipelines work end-to-end and are connected via `--threat-model`.

### What Works

- **Threat model → analyze workflow** — `threat-model` generates ranked threats with code traces and suggested properties; `analyze --threat-model` loads them and injects into the orchestrator prompt to focus the Explorer and Verifier agents
- **Analyze pipeline** — Scaffolds temp project, runs Explorer + On-Chain + Verifier agents via Claude Agent SDK, streams output to terminal
- **Threat model pipeline** — Pre-computes AST analysis + Etherscan v2 data, runs threat modeler agent, enriches with Solodit, writes `threat-model.json`
- **AST analysis** — Full structural extraction from solc AST at Slither parity (9/9 features)
- **CLI** — All three commands (`analyze`, `threat-model`, `check`) with proper option parsing
- **Dependency checking** — Validates forge/halmos/cast at startup

### What's Disconnected

- **Report generation** — `generateReport()` and `printSummary()` in `src/report/generator.ts` are fully implemented but never called from the orchestrator. Agent output is printed as free-form text, not parsed into structured `Finding[]` / `VerifiedProperty[]`.
- **`--output` flag** — Parsed but unused by the analyze orchestrator (threat-model pipeline does write output).

### Shortcuts Taken

- **No temp directory cleanup** — `/tmp/forge-proof-*` dirs accumulate across runs
- **Hardcoded solc 0.8.28** — Scaffolded projects use a fixed compiler version
- **No dependency resolution** — OpenZeppelin/other imports aren't auto-installed
- **Unstructured agent output** — Agents return free-form text; no JSON schema enforcement
- **Fragile Halmos regex** — Output parser is sensitive to format changes

### TODO

#### Wired but Disconnected (fix first)

- [ ] **Wire report generation** — Call `generateReport()` and `printSummary()` from the analyze orchestrator. Parse agent output into `Finding[]` and `VerifiedProperty[]`. Write Markdown + JSON to `--output` directory.
- [ ] **Wire `--output` flag** — Orchestrator should pass output dir to report generator.

#### Robustness

- [ ] **Temp directory cleanup** — Add `process.on("exit")` / `SIGINT` / `SIGTERM` handlers. Wrap orchestrator in try/finally.
- [ ] **Auto-detect Solidity pragma** — Parse `pragma solidity ^X.Y.Z` from target contracts, set `solc_version` in `foundry.toml` accordingly.
- [ ] **Auto-install contract dependencies** — Detect `@openzeppelin/` and similar imports, run `forge install` for known library prefixes.
- [ ] **Merge existing remappings** — If target project has `remappings.txt` or `foundry.toml`, merge into scaffolded project.

#### Enhancements

- [ ] **Structured agent output** — Define JSON schemas for each agent's output. Parse and validate programmatically.
- [ ] **Multi-contract support** — Accept glob patterns, analyze cross-contract interactions.
- [ ] **Etherscan v2 pagination** — Fetch beyond 500 transactions with rate-limited pagination.
- [ ] **Progress indicators** — Show phase, elapsed time, properties verified/pending.
- [ ] **Config file** — `.forge-proofrc` or `forge-proof.config.json` for project-level defaults.
- [ ] **Resume interrupted analysis** — Save intermediate state for crash recovery.

#### Testing

- [ ] **Unit tests for parsers** — `halmos-output.ts`, `etherscan.ts` against sample outputs.
- [ ] **Unit tests for AST analysis** — Verify extraction against benchmark contracts.
- [ ] **Integration tests** — End-to-end `threat-model` + `analyze` on benchmark contracts.

#### Lower Priority

- [ ] HTML/PDF report output
- [ ] Performance metrics (time per agent, token usage)
- [ ] Custom block explorer support (BlockScout, etc.)
- [ ] Caching layer for Etherscan/Solodit responses
- [ ] Graceful degradation (continue with partial results on agent failure)

## License

MIT
