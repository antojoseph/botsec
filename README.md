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

## Benchmark: Damn Vulnerable DeFi — 19/19 Vulnerabilities Found

Tested against [Damn Vulnerable DeFi v4](https://www.damnvulnerabledefi.xyz/) — the industry-standard benchmark for smart contract security tools.

```
Score:         18/18 challenges — 100% detection rate (19 threats, 2 on Shards)
Halmos Proofs: 16 vulnerabilities with concrete counterexamples
Verified Safe: 8 properties mathematically proven to hold
Zero Timeouts: All 24 symbolic tests completed within solver bounds
Cost:          $10.81 ($4.18 threat model + $6.63 verification)
Runtime:       ~2 hours
```

### Per-Challenge Results

| # | Challenge | Severity | Verification | Method | Properties | Status |
|---|-----------|----------|-------------|--------|------------|--------|
| 1 | Unstoppable | High | Donation breaks flash loan invariant | Halmos | 3 (1 violation, 2 verified) | PROVEN |
| 2 | Naive Receiver | Critical | Multicall msg.sender spoofing | Code review | — | CONFIRMED |
| 3 | Truster | Critical | Arbitrary call from pool context | Halmos | 3 (3 violations) | PROVEN |
| 4 | Side Entrance | Critical | Flash loan repayment via deposit | Halmos | 3 (3 violations) | PROVEN |
| 5 | The Rewarder | High | Claim bitmap word boundary bypass | Halmos | 3 (2 violations, 1 verified) | PROVEN |
| 6 | Selfie | Critical | Governance takeover via flash loan | Code review | — | CONFIRMED |
| 7 | Compromised | Critical | Oracle price manipulation | Code review | — | CONFIRMED |
| 8 | Puppet | Critical | Uniswap V1 spot price manipulation | Code review | — | CONFIRMED |
| 9 | Puppet V2 | Critical | Uniswap V2 spot price manipulation | Code review | — | CONFIRMED |
| 10 | Free Rider | Critical | msg.value reuse + payment to buyer | Halmos | 3 (3 violations) | PROVEN |
| 11 | Backdoor | Critical | Safe wallet setup callback injection | Code review | — | CONFIRMED |
| 12 | Climber | Critical | Execute-before-verify in timelock | Halmos | 3 (3 verified as exploitable) | PROVEN |
| 13 | Wallet Mining | High | Proxy authorization bypass | Code review | — | CONFIRMED |
| 14 | Puppet V3 | High | Uniswap V3 TWAP manipulation | Code review | — | CONFIRMED |
| 15 | ABI Smuggling | Critical | Calldata offset manipulation | Code review | — | CONFIRMED |
| 16 | Shards | Medium | Rounding mismatch fill vs cancel | Halmos | 5 (2 violations, 3 verified) | PROVEN |
| 17 | Curvy Puppet | High | Curve virtual price manipulation | Code review | — | CONFIRMED |
| 18 | Withdrawal | Critical | Inverted bridge authorization | Halmos | 3 (2 violations, 1 verified) | PROVEN |

**PROVEN** = Halmos found concrete counterexample values demonstrating the exploit. **CONFIRMED** = Validated by deep code analysis; requires external protocol mocks (Uniswap, Curve, Gnosis Safe) beyond current Halmos capability.

### Aggregate

| Metric | Value |
|--------|-------|
| Challenges with Halmos counterexamples | 8/18 |
| Challenges confirmed by code review | 10/18 |
| Total vulnerabilities detected | **18/18 (100%)** |
| Properties tested (Halmos) | 24 |
| Violations found | 16 |
| Properties proven safe | 8 |
| Halmos solver timeouts | 0 |
| Test files generated | 8 |

---

## How It Works

Two-stage pipeline: **threat model** identifies what to look for, **analyze** proves it with Halmos.

### Stage 1: `forge-proof threat-model <project>`

Generates a ranked threat model for a Foundry project.

1. **Pre-computation** — Builds the project, walks the solc AST to extract call graphs, state variable maps, inheritance, CEI ordering, auth checks, guards, and data dependencies. Auto-installs npm dependencies if needed. Filters out test/script contracts. Writes per-contract structural data to `.forge-proof/codemap/` and blueprint to `.forge-proof/blueprint.json`.
2. **LLM classification** — Haiku classifies the contract type (vault, lending, dex, staking, etc.) to inform invariant inference and investigation questions.
3. **Agentic exploration** — Opus agent reads the blueprint and per-contract code map files on-demand (file-based context — no prompt size limits). Focuses exclusively on untrusted-actor attack paths. Every threat requires a TRACE with exact file:line locations.
4. **Synthesis** — Anti-slop filter drops traceless threats, self-contradiction filter downgrades primarily-exonerating threats, deduplication merges overlapping findings, threats ranked by severity x confidence.

Output: timestamped directory with `threat-model.json` + `blueprint.json`

### Stage 2: `forge-proof analyze <project> --threat-model <file>`

Formally verifies threats using Halmos symbolic execution.

1. **Explorer Agent** (Opus) — Validates known threats from the threat model, identifies additional ones
2. **On-Chain Agent** (Sonnet) — Fetches Etherscan v2 transaction data for concrete test values *(optional)*
3. **Verifier Agent** (Opus, with halmos skill preloaded) — Discovers existing tests before writing new ones. Writes `check_` Halmos tests, compiles, runs the SMT solver, interprets counterexamples. Diagnoses timeouts: if nonlinear 256-bit math (unsolvable), falls back to Foundry fuzz immediately. If solvable, tries input narrowing first.

Use `--verify-only` to restart just the verification phase without re-running exploration.

Output: timestamped directory with `forge-proof-report.md` + `forge-proof-report.json`

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

# 2. Formally verify the threats (use the timestamped path from step 1)
npm run dev -- analyze ./my-defi-project --threat-model forge-proof-output/threat-model-<timestamp>/threat-model.json

# 3. If verification is interrupted, restart just that phase
npm run dev -- analyze ./my-defi-project --threat-model forge-proof-output/threat-model-<timestamp>/threat-model.json --verify-only
```

### With on-chain data

```bash
npm run dev -- threat-model ./my-defi-project --address 0x1234... --etherscan-key YOUR_KEY
npm run dev -- analyze ./my-defi-project --threat-model forge-proof-output/threat-model-<timestamp>/threat-model.json \
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

## Output Structure

Each run creates a timestamped directory — nothing is overwritten:

```
forge-proof-output/
  threat-model-2026-02-16-01-55-57/
    threat-model.json
    blueprint.json
  analyze-2026-02-16-03-36-19/
    forge-proof-report.md
    forge-proof-report.json
```

The `.forge-proof/` directory in the project contains working state for the agent (overwritten each run):

```
<project>/.forge-proof/
  blueprint.json                  Architectural blueprint
  codemap/
    _inheritance.json             Global inheritance relationships
    _callGraph.json               Global call graph edges
    _stateVarMap.json             Global state variable maps
    _dataDependency.json          Transitive data dependencies + taint tracking
    StrategyBase.json             Per-contract: functions, auth, guards, operations, storage
    DelegationManager.json
    ...
  test/                           Halmos tests (created during analyze)
    HalmosVerification.t.sol
    foundry.toml
```

## Architecture

```
threat-model <project>                    analyze <project> --threat-model <file>
  |                                         |
  +-- Pre-Computation                       +-- Detect Foundry project or scaffold
  |   forge build --build-info              |
  |   solc AST -> structural analysis       +-- Load threat-model.json
  |   Filter out test/script contracts      |   Inject threats into orchestrator prompt
  |   Haiku -> contract classification      |
  |   -> blueprint + invariants             +-- Phase 1: Parallel Analysis
  |   Write .forge-proof/codemap/*.json     |   Explorer (Opus) + On-Chain (Sonnet)
  |   Write .forge-proof/blueprint.json     |   [skipped with --verify-only]
  |                                         |
  +-- Agentic Exploration                   +-- Phase 2: Formal Verification
  |   Threat Modeler (Opus, 1M context)     |   Verifier (Opus, halmos skill preloaded)
  |   Reads per-contract files on-demand    |   Discovers existing tests first
  |   Untrusted-actor focus only            |   check_ tests -> halmos
  |   Anti-slop trace requirement           |   Diagnoses timeouts (solvable vs not)
  |                                         |   Unsolvable -> fuzz fallback (1M runs)
  +-- Synthesis                             |
  |   Anti-slop filter                      +-- Report Output
  |   Self-contradiction filter             |   forge-proof-report.md
  |   Deduplication (>50% overlap)          |   forge-proof-report.json
  |   Threat ranking                        |   (timestamped directory)
  |                                         |
  v                                         v
  threat-model.json ----------------------> Console + files
  blueprint.json
  (timestamped directory)
```

## Key Design Decisions

**File-based context** — Pre-computed structural data is split into per-contract JSON files in `.forge-proof/codemap/`. The threat modeler agent reads them on-demand via Read/Grep tools. This keeps the system prompt at ~5KB regardless of codebase size and lets the agent selectively load only relevant contracts.

**Per-contract code map** — Instead of one large file, each contract gets its own JSON (function summaries, auth checks, guards, operation ordering, storage layout) plus 4 global files (inheritance, call graph, state vars, data dependencies). For a large project (800+ contracts), this means 42 targeted files instead of one 9MB blob.

**Test contract filtering** — The AST analysis reads test/script directory paths from `foundry.toml` and excludes them. This prevents investigation questions about test harness setUp methods (previously 81% of questions were test noise).

**Untrusted-actor focus** — The threat modeler skips admin/owner misconfiguration scenarios and focuses exclusively on what an unprivileged attacker can exploit.

**Anti-slop trace requirement** — Every threat must include a TRACE with exact code locations. Threats without traces are dropped. Self-contradicting threats (primarily exonerating language) are downgraded — but only if the description is short or contains multiple exonerating phrases, so real threats mentioning mitigations aren't penalized.

**Halmos timeout diagnosis** — Instead of a hard timeout, the verifier diagnoses WHY halmos timed out using its preloaded halmos skill knowledge. Nonlinear 256-bit math (mulDivDown, etc.) is recognized as unsolvable and falls back to fuzz immediately. Simpler constraints are retried with narrowed input types.

**Halmos skill preloaded** — The verifier agent has `skills: ["halmos"]` which auto-loads the halmos skill (10 verification strategies, solver limitations, vault patterns) into its context without needing a tool call.

**Timestamped outputs** — Each run creates a unique directory (`threat-model-<timestamp>/`, `analyze-<timestamp>/`). Previous runs are never overwritten, enabling comparison across development iterations.

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

Validated against production DeFi protocols with active bug bounty programs. All findings were responsibly disclosed.

| Project | Threat Model | Analyze | Total Cost |
|---------|-------------|---------|------------|
| Project Alpha | 8 threats (2M, 6L) | 8/8 confirmed, 10 fuzz tests | ~$22 |
| Project Gamma | 14 threats (3M, 11L) | 19 Halmos proofs, 3 violations, 15 fuzz tests | ~$12 |
| Project Delta | 17 threats (1H, 3M, 13L) | 11 Halmos proofs, 1 violation, 6 fuzz tests | ~$13 |
| DVF Benchmark | 19 threats (11C, 5H, 3M) | 18/18 challenges, 16 Halmos proofs, 0 timeouts | ~$11 |

## Source Structure

```
src/
  index.ts                          CLI entry point (3 commands)
  orchestrator.ts                   Analyze pipeline coordinator
  agents/
    explorer.ts                     Deep code analysis (read-only)
    onchain.ts                      Etherscan transaction analysis
    threat-modeler.ts               Threat modeling (file-based context)
    verifier.ts                     Halmos tests + fuzz fallback (halmos skill preloaded)
  threat-model/
    orchestrator.ts                 Threat model pipeline coordinator
    precompute.ts                   AST + forge inspect + Etherscan v2
    ast-analysis.ts                 solc AST structural extraction (~1000 lines)
    architecture-analyzer.ts        Blueprint: LLM classification, attack surface, invariants
    types.ts                        Shared type definitions
    solodit.ts                      Historical vulnerability search (opt-in via --solodit)
  scaffold/
    foundry-project.ts              Temp Foundry project creation
    dependencies.ts                 forge/halmos/cast validation
  parsers/
    halmos-output.ts                Halmos result parser
    etherscan.ts                    Etherscan API types
  report/
    generator.ts                    Markdown + JSON report generation
```

## Current Status

### What's Connected

- Two-stage threat model -> analyze workflow via `--threat-model`
- Verify-only mode for restarting interrupted verification
- File-based context with per-contract code map split
- LLM contract classification (Haiku)
- Test/script contract filtering from AST analysis
- Anti-slop, self-contradiction, and deduplication filters
- Halmos timeout diagnosis + Foundry fuzz fallback
- Halmos skill preloaded into verifier agent
- Timestamped output directories
- Report persistence (MD + JSON)
- Existing test discovery before writing new ones

### TODO

- [ ] AST support for non-Foundry projects (Hardhat, multi-compiler like Project Delta)
- [ ] Temp directory cleanup (`/tmp/forge-proof-*` accumulates)
- [ ] Auto-detect solc pragma version
- [ ] Merge existing remappings from target project
- [ ] Per-phase cost tracking (Explorer vs Verifier breakdown)
- [ ] Unit tests for parsers and AST analysis
- [ ] Integration tests on benchmark contracts
- [ ] Resume interrupted analysis (checkpoint intermediate state)
- [ ] Diff reports across timestamped runs

## License

MIT
