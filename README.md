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

Forge Proof runs three specialized AI agents in sequence to analyze Solidity smart contracts:

1. **Explorer Agent** (Claude Opus) — Deep static analysis: maps state variables, traces external calls, identifies reentrancy surfaces, produces vulnerability hypotheses and property suggestions
2. **On-Chain Agent** (Claude Sonnet) — Fetches real transaction data from Etherscan to identify usage patterns, anomalies, and concrete test parameters *(optional, requires `--address`)*
3. **Verifier Agent** (Claude Opus) — Writes Halmos symbolic tests (`check_` functions), compiles with Forge, runs the SMT solver, interprets counterexamples, and iterates on specs

The final output is a security report containing mathematically verified properties, violations with counterexample attack scenarios, and severity assessments.

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

# Analyze a single contract
forge-proof analyze ./contracts/Vault.sol

# Analyze a project directory
forge-proof analyze ./src/

# With on-chain transaction analysis
forge-proof analyze ./src/Vault.sol --address 0x1234... --etherscan-key YOUR_KEY

# Custom Halmos bounds
forge-proof analyze ./contract.sol --loop 5 --solver-timeout 20000
```

### Development

```bash
npm run dev -- analyze ./contracts/Vault.sol    # Run directly via tsx
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

forge-proof check           Verify dependencies are installed
```

## Benchmark Contracts

The `benchmarks/` directory contains intentionally vulnerable contracts for testing:

| Contract | Vulnerability | File |
|----------|---------------|------|
| VulnerableVault | Reentrancy (CEI violation — external call before state update) | `benchmarks/targets/reentrancy-vault.sol` |
| InflatableVault | ERC4626 first-depositor inflation attack | `benchmarks/targets/erc4626-inflation.sol` |
| FeeVault | Insolvency from fee-on-transfer tokens | `benchmarks/targets/fee-on-transfer.sol` |

Run against a benchmark:

```bash
forge-proof analyze ./benchmarks/targets/reentrancy-vault.sol
```

## Architecture

```
CLI (index.ts)
  │
  ▼
Orchestrator (orchestrator.ts)
  │  Scaffolds temp Foundry project
  │  Builds agent definitions
  │  Runs Claude Agent SDK query()
  │
  ├─── Phase 1 (parallel via SDK Task tool) ──┐
  │    Explorer Agent (Opus, read-only)        │  On-Chain Agent (Sonnet, Bash)
  │    Deep code analysis                      │  Etherscan transaction data
  │    Vulnerability hypotheses                │  Usage patterns & anomalies
  │    Property suggestions                    │  Concrete test values
  ├────────────────────────────────────────────┘
  │
  ├─── Phase 2 ───────────────────────────────
  │    Verifier Agent (Opus, read/write/bash)
  │    Writes check_ Halmos tests
  │    forge build → halmos → interpret
  │    Iterates on failures (up to 3x/property)
  │
  ▼
  Phase 3: Final report
```

---

## Current Status: Prototype (v0.1.0)

This is an early-stage prototype. The core agent pipeline works end-to-end, but significant functionality is stubbed or missing. Below is an honest accounting of the current state.

### Corners Cut

These are places where shortcuts were taken to get the prototype working:

- **No temp directory cleanup** — `scaffoldFoundryProject()` creates dirs in `/tmp/forge-proof-*` via `mkdtempSync()` but never cleans them up. No signal handlers (SIGINT/SIGTERM), no `finally` block, no atexit. Over multiple runs, temp dirs accumulate.

- **Report pipeline disconnected** — `src/report/generator.ts` defines `generateReport()` and `printSummary()` with proper interfaces (`Finding`, `VerifiedProperty`, `AuditReport`), but the orchestrator never calls them. Reports exist only as agent console output. The `--output` CLI flag is parsed but unused.

- **CLI options not passed to agents** — `--loop`, `--solver-timeout` are parsed and printed to the console, then passed into the orchestrator prompt as string interpolation. They appear in the *prompt text* but are not enforced programmatically. The agent could ignore them.

- **Hardcoded solc version** — `foundry.toml` sets `solc_version = "0.8.28"`. Contracts using a different pragma will fail compilation. No detection or auto-matching of the target contract's pragma.

- **No contract dependency resolution** — If the target contract imports OpenZeppelin or other libraries, they aren't installed. The verifier agent has to diagnose and fix compilation errors manually (wasting turns).

- **`handleMessage()` is a stub** — The streaming message handler (`orchestrator.ts:165-213`) prints raw SDK messages to console. It doesn't parse, collect, or structure agent outputs. No extraction of findings, properties, or verification results.

- **Agent output is unstructured** — Agents are instructed via system prompt to format output in specific ways, but there's no validation or schema enforcement on what they return. Results are free-form text.

- **Magic numbers throughout** — `500` max turns, `500` character truncation threshold, `0.001 ETH` conversion threshold in the Halmos parser, `1 ETH` large-value threshold in the Etherscan parser. All hardcoded with no configuration.

- **Fragile Halmos output parsing** — `src/parsers/halmos-output.ts` uses hand-rolled regex (`/\[(\w+)\]\s+(\w+)\s*(.*)$/`, `/p_\w+/`, etc.). Sensitive to any change in Halmos output format.

- **`cast` absence not handled** — On-chain agent prompt references `cast 4byte-decode` but provides no fallback when cast isn't installed. The dependency checker warns but doesn't prevent the on-chain agent from running.

- **`rm` via execSync** — Default Foundry files removed with raw `execSync("rm ...")` instead of `unlinkSync()`. No error handling for missing files.

### TODO: Features to Implement

#### High Priority

- [ ] **Wire up report generation** — Connect `generateReport()` and `printSummary()` to the orchestrator. Parse agent output into `Finding[]` and `VerifiedProperty[]` structs. Write Markdown + JSON to `--output` directory.

- [ ] **Temp directory cleanup** — Add `process.on("exit", ...)` and `process.on("SIGINT", ...)` handlers to remove the temp Foundry project. Wrap the orchestrator in try/finally.

- [ ] **Auto-detect Solidity pragma** — Parse `pragma solidity ^X.Y.Z` from target contracts and set `solc_version` in `foundry.toml` accordingly.

- [ ] **Auto-install contract dependencies** — Detect `import "@openzeppelin/..."` and similar imports, run `forge install` for known libraries. Map common import prefixes to GitHub repos.

- [ ] **Structured agent output parsing** — Define JSON schemas for each agent's output. Have agents return structured JSON alongside natural language. Validate and extract data programmatically.

- [ ] **Existing remappings support** — If the target project has a `remappings.txt` or `foundry.toml`, merge those into the scaffolded project instead of overwriting.

#### Medium Priority

- [ ] **Multi-contract support** — Accept glob patterns (`./contracts/**/*.sol`) and analyze cross-contract interactions, not just single files.

- [ ] **Etherscan pagination** — Fetch more than 50 transactions. Implement paginated API calls with rate limiting and backoff.

- [ ] **Etherscan rate limiting** — Add delay between API calls. Respect 5 calls/sec free tier limit.

- [ ] **Version checking for external tools** — Verify minimum versions of forge, halmos, and cast at startup. Halmos output format varies between versions.

- [ ] **Retry logic for external commands** — `forge build`, `halmos`, and Etherscan API calls can fail transiently. Add retry with exponential backoff.

- [ ] **Config file support** — Add `.forge-proofrc` or `forge-proof.config.json` for project-level defaults (loop bounds, solver timeout, chain ID, common options).

- [ ] **Logging framework** — Replace `console.log`/`console.error` with structured logging. Add log levels (debug/info/warn/error) and optional file output.

- [ ] **Progress indicators** — Show real progress during long Halmos runs. Track which properties have been verified, which are pending, elapsed time.

- [ ] **Benchmark test coverage** — Write Halmos test harnesses for `erc4626-inflation.sol` and `fee-on-transfer.sol` benchmarks (only `reentrancy-vault.sol` has one currently).

#### Lower Priority

- [ ] **Custom block explorer support** — Allow alternative explorers (BlockScout, etc.) instead of only Etherscan. Support custom RPC endpoints.

- [ ] **Caching layer** — Cache Etherscan responses, Halmos compilation artifacts, and agent results. Avoid repeating identical work across runs.

- [ ] **Resume interrupted analysis** — Save intermediate state (exploration findings, partial verification results) so a crashed or interrupted run can continue where it left off.

- [ ] **HTML/PDF report output** — Currently only Markdown and JSON. Add rendered HTML or PDF for sharing with stakeholders.

- [ ] **Performance metrics** — Track and report: total execution time, time per agent, time per Halmos test, number of agent turns used, token consumption.

- [ ] **Parallel agent execution** — The orchestrator prompt tells the SDK to run explorer + on-chain "in parallel" via the Task tool, but this depends on SDK behavior. Verify and optimize actual concurrency.

- [ ] **Graceful degradation** — If one agent phase fails, continue with partial results instead of stopping entirely. Report what was completed.

- [ ] **Test suite** — Add unit tests for parsers (`halmos-output.ts`, `etherscan.ts`), scaffolding logic, and report generation. Integration tests against benchmark contracts.

- [ ] **Input validation** — Verify contract path exists before starting analysis. Validate Etherscan API key format. Check that `--chain` maps to a supported chain with a known explorer URL.

- [ ] **Python/pip dependency check** — Halmos requires Python but `dependencies.ts` only checks for the `halmos` binary, not the Python runtime.

## License

MIT
