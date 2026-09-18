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

1. **Pre-computation** — Builds the project, walks the solc AST to extract call graphs, state variable maps, inheritance, CEI ordering, auth checks, guards, and data dependencies. Installs npm dependencies only when `--allow-npm-install` is passed (it runs the target's lifecycle scripts). Filters out test/script contracts. Writes per-contract structural data to `.forge-proof/codemap/` and blueprint to `.forge-proof/blueprint.json`.
2. **LLM classification** — Haiku classifies the contract type (vault, lending, dex, staking, etc.) to inform invariant inference and investigation questions.
3. **Agentic exploration** — Opus agent reads the blueprint and per-contract code map files on-demand (file-based context — no prompt size limits). Focuses exclusively on untrusted-actor attack paths. Every threat requires a TRACE with exact file:line locations.
4. **Synthesis** — Anti-slop filter drops traceless threats, self-contradiction filter downgrades primarily-exonerating threats, deduplication merges overlapping findings, threats ranked by severity x confidence.

Output: timestamped directory with `threat-model.json` + `blueprint.json`

### Stage 2: `forge-proof analyze <project> --threat-model <file>`

Formally verifies threats using Halmos symbolic execution.

1. **Explorer Agent** (Opus) — Validates known threats from the threat model, identifies additional ones
2. **On-Chain Agent** (Sonnet) — Fetches Etherscan v2 transaction data for concrete test values *(optional)*
3. **Verifier Agent** (Opus) — Discovers existing tests before writing new ones. Writes `check_` Halmos tests, compiles, runs the SMT solver, interprets counterexamples. Diagnoses timeouts: if nonlinear 256-bit math (unsolvable), falls back to Foundry fuzz immediately. If solvable, tries input narrowing first.

Use `--verify-only` to restart just the verification phase without re-running exploration.

Output: timestamped directory with `forge-proof-report.md` + `forge-proof-report.json`

## Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| **Node.js** (20+) | Yes | [nodejs.org](https://nodejs.org) |
| **Foundry** (forge, cast) | Yes | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| **Halmos** | Yes | `uv tool install --python 3.12 halmos` (needs Python >= 3.11) |
| **Claude credential** | Yes | `export ANTHROPIC_API_KEY=sk-ant-...` (see below for alternatives) |

```bash
forge-proof check   # Verify dependencies and credential
```

### Model providers

The credential is resolved from any of the following, so you are not limited to
a first-party Anthropic key:

| Provider | Configuration |
|----------|---------------|
| Anthropic API | `ANTHROPIC_API_KEY=sk-ant-...` |
| LLM gateway (OpenRouter, LiteLLM, ...) | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1` |
| Stored profile | `ant auth login` |

#### OpenRouter

OpenRouter exposes an Anthropic-Messages-compatible endpoint, so no proxy and no
code change are needed:

```bash
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"
export ANTHROPIC_API_KEY=""            # must be explicitly empty

# Map the three agent tiers onto whichever models you want
export ANTHROPIC_DEFAULT_OPUS_MODEL="anthropic/claude-sonnet-4.5"
export ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/claude-haiku-4.5"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/claude-haiku-4.5"
export CLAUDE_CODE_SUBAGENT_MODEL="anthropic/claude-haiku-4.5"

# The blueprint classifier calls the Messages API directly and needs the
# gateway's namespaced model id
export FORGE_PROOF_CLASSIFIER_MODEL="anthropic/claude-haiku-4.5"
```

Agents are declared with model *aliases* (`opus`/`sonnet`/`haiku`) rather than
pinned model ids specifically so this remapping works without touching code.

Caveats: OpenRouter only guarantees Claude Code compatibility on the Anthropic
first-party provider, and prompt caching and the 1M context window are
first-party only. Structured output (`outputFormat: json_schema`, used by
`threat-model`) and multi-turn subagent delegation are the parts most likely to
degrade on non-Claude models — the pipeline falls back to text JSON extraction
when structured output is unavailable.

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
  --max-budget <usd>        Max spend in USD before stopping [default: 50]
  --allow-npm-install       Run `npm install` in the target (executes its
                            lifecycle scripts — trusted targets only)

  Provider toggles (all on by default, generated from the provider registry):
  --no-ast                  Disable solc AST structural analysis
  --no-inspect              Disable forge inspect (ABI, storage layout)
  --no-blueprint            Disable architectural blueprint
  --no-anti-slop            Disable the trace-required quality gate
  --no-self-contradiction   Disable the self-contradiction downgrade
  --no-dedup                Disable threat deduplication
  --no-ranking              Disable threat ranking

forge-proof analyze <path>
  --threat-model <file>     Threat model JSON from Stage 1
  --verify-only             Skip exploration, run verification only (requires --threat-model)
  --address <addr>          On-chain contract address
  --chain <id>              Chain ID [default: 1]
  --etherscan-key <key>     Etherscan API key
  --loop <n>                Halmos loop bound [default: 3]
  --solver-timeout <ms>     SMT solver timeout [default: 10000]
  --max-turns <n>           Max agent turns [default: 500]
  --max-budget <usd>        Max spend in USD before stopping [default: 100]
  --no-audit-spec           Skip the independent Halmos re-run that flags
                            vacuous properties (on by default)
  --mutation-test           Inject bugs and score how many the spec catches
                            (no model tokens — forge + halmos only)
  --max-mutants <n>         Mutants to run with --mutation-test [default: 10]
  -o, --output <dir>        Output directory [default: forge-proof-output]

forge-proof check           Verify dependencies and resolve the Claude credential
```

Adding a provider to `src/threat-model/providers/registry.ts` generates its CLI
flag automatically from the provider's `ProviderMeta` — default-on providers get
`--no-<flag>`, opt-in providers get `--<flag>`.

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
  |   Threat Modeler (Opus)                 |   Verifier (Opus)
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

**Halmos timeout diagnosis** — Instead of a hard timeout, the verifier diagnoses WHY halmos timed out. Nonlinear 256-bit math (mulDivDown, etc.) is recognized as unsolvable and falls back to fuzz immediately. Simpler constraints are retried with narrowed input types.

**Self-contained agent prompts** — Halmos rules, the test template, and the known
environment pitfalls live directly in the verifier's system prompt
(`src/agents/verifier.ts`) rather than in an external skill. The tool has no
dependency on what is installed in the operator's `~/.claude`, so a fresh clone
behaves identically to a configured one.

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
    verifier.ts                     Halmos tests + fuzz fallback
  threat-model/
    orchestrator.ts                 Threat model pipeline coordinator
    precompute.ts                   AST + forge inspect + Etherscan v2
    ast-analysis.ts                 solc AST structural extraction (~1000 lines)
    architecture-analyzer.ts        Blueprint: LLM classification, attack surface, invariants
    types.ts                        Shared type definitions
    solodit.ts                      Historical vulnerability search (opt-in via --solodit)
    providers/
      registry.ts                   Single source of truth for all providers
      types.ts                      Provider interfaces (5 pipeline phases)
      precompute/                   ast, inspect, blueprint, etherscan
      enrichment/                   solodit
      filters/                      anti-slop, self-contradiction, dedup, ranking
  scaffold/
    foundry-project.ts              Temp Foundry project creation + HALMOS_ENV
    dependencies.ts                 forge/halmos/cast + credential resolution
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
- Timestamped output directories
- Report persistence (MD + JSON)
- Existing test discovery before writing new ones
- Provider toggles (`--no-ast`, `--no-dedup`, ...) wired to the registry
- Vacuity classification of every Halmos result (structured, via `--json-output`)
- Mutation testing to score how much the generated spec actually proves
- Works against any Anthropic-compatible endpoint (Anthropic API, OpenRouter,
  Bedrock, Vertex) — see [Model providers](#model-providers)

### Verification environment

Generated Halmos tests live in `.forge-proof/test/`, outside Foundry's default
source paths, so the project's own `test/` directory is never touched. Two
environment variables (`HALMOS_ENV` in `src/scaffold/foundry-project.ts`) are
exported for every forge/halmos invocation and are both mandatory:

| Variable | Why |
|---|---|
| `FOUNDRY_TEST=.forge-proof/test` | Without it, `forge build` never compiles the generated tests and halmos finds nothing to run |
| `FOUNDRY_DYNAMIC_TEST_LINKING=false` | Foundry >= 1.3 otherwise rewrites `new Contract()` into a `vm.deployCode(string)` cheatcode that Halmos cannot execute, failing `setUp()` on every test |

Halmos selects tests by contract and function name — `--match-contract` / `-mc`,
`--match-test` / `-mt`, `--function`. There is no `--match-path` flag.

### Spec strength — is a `[PASS]` worth anything?

A Halmos `[PASS]` only means no counterexample was found *for the property as
written*. A property that asserts nothing, or whose assumptions are
contradictory, passes in a way that is byte-identical to a real proof. For an
audit tool that is the most dangerous possible output, so every run independently
audits the spec the agent produced.

**Vacuity classification** (on by default) re-runs Halmos with `--json-output`
and separates real proofs from empty ones:

```
10 verified, 2 violated, 10 vacuous, 0 errored
WARNING: 10 propert(ies) proved nothing — see the VACUOUS section of the report.
```

A property whose every path reverted never reached its assertion. It is reported
under `VACUOUS`, never under `VERIFIED`.

**Mutation testing** (`--mutation-test`) answers the harder question: are the
properties that *do* hold actually constraining anything? It injects bugs derived
from the solc AST — removing a `require`, shifting a comparison boundary,
inverting an arithmetic operator, dropping a state write — rebuilds, and re-runs
the verified properties.

```
Mutation score: 44% — 4 killed, 5 survived

SURVIVED  M005  require(balances[msg.sender] >= amount)   <- the overdraw guard
SURVIVED  M006  >= -> >   (off-by-one on that same guard)
SURVIVED  M007  require(success, "Transfer failed")
```

A surviving mutant is a reproducible demonstration that the spec does not detect
that bug. In the run above, the vault's entire overdraw guard could be deleted
and all ten "verified" properties still passed — the spec constrained bookkeeping
but not guards. No confidence score a model assigns to its own work can tell you
that.

Mutation testing spends no model tokens; it is forge and halmos only. Each
mutant costs one rebuild plus one Halmos run, so `--max-mutants` bounds the
wall-clock cost. Mutants are chosen round-robin across operators so a small
budget still yields a representative score.

### Security model

`analyze` and `threat-model` are designed to be pointed at code you do not
trust, so the agents are isolated from the target:

- `settingSources: []` and `omitClaudeMd: true` — the target's `CLAUDE.md` and
  `.claude/settings.json` are never loaded as instructions, even though agents
  run with `permissionMode: "bypassPermissions"`
- `npm install` inside the target is opt-in (`--allow-npm-install`) and runs
  with `--ignore-scripts`, because lifecycle scripts are arbitrary code execution

### TODO

- [ ] AST support for non-Foundry projects (Hardhat, multi-compiler like Project Delta)
- [ ] Temp directory cleanup (`$TMPDIR/forge-proof-*` accumulates; kept for now so
      `--verify-only` can resume an interrupted run)
- [ ] Merge existing remappings from target project
- [ ] Per-phase cost tracking (Explorer vs Verifier breakdown)
- [ ] Unit tests for AST analysis
- [ ] Integration tests on benchmark contracts
- [ ] Resume interrupted analysis (checkpoint intermediate state)
- [ ] Diff reports across timestamped runs

### Known limitations with non-Anthropic models

Routing through a gateway works, but weaker models mishandle subagent
delegation: they treat the synchronous Task tool as if it were asynchronous,
announce that the verifier "is now running", and end the turn before any
verification happens.

The orchestrator prompts state explicitly that Task is synchronous. **This
reduces the failure rate but does not eliminate it** — it still reproduces on
Haiku-class orchestrators. Because a silent false pass is the worst outcome for
a security tool, `analyze` also verifies the artifacts directly: if no `.sol`
files were written to `.forge-proof/test/`, it refuses to write a report and
exits non-zero.

Observed with `ANTHROPIC_DEFAULT_OPUS_MODEL` set to:

| Model | Result |
|---|---|
| `anthropic/claude-sonnet-4.5` | Completes; 5 test files, 20 symbolic tests |
| `anthropic/claude-haiku-4.5` | Reliably ends the turn early — caught by the guard |

If you hit the guard, re-run, or point `ANTHROPIC_DEFAULT_OPUS_MODEL` at a more
capable model for the orchestrator role. The subagents themselves do fine on
cheaper models; it is specifically the delegating orchestrator that needs
capability.

## License

MIT
