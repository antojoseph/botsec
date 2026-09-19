# Forge Proof — Code Review Findings

Review date: 2026-09-18
Repo: `botsec/botsec` (branch `claude/smart-contract-vulnerability-cli-6HOiW`)
Scope: static review of `src/` (~7.5k lines), CLI surface, docs, benchmarks.

Baseline checks:
- `npx tsc --noEmit` → exit 0 (clean build; no `noUnusedLocals`, so dead code compiles silently).
- `git status` → clean tree.
- No test suite exists (README/CLAUDE.md state this explicitly).

Legend: **High** = real runtime/correctness bug; **Medium** = conditional bug or important gap; **Low** = cleanup/doc.

---

## Summary

| ID | Severity | Area | One-line |
|----|----------|------|----------|
| F1 | High | `src/agents/threat-modeler.ts` | `require()` in ESM always throws → `srcDir` never read |
| F2 | High | `src/threat-model/architecture-analyzer.ts` | `threatenedBy` uses filtered index against unfiltered keys |
| F3 | High | `src/threat-model/providers/filters/dedup.ts` | Same threat can be merged twice (duplicate content) |
| F4 | High | `src/threat-model/solodit.ts` | Solodit key unused + endpoint 404 → enrichment dead |
| F5 | High | `src/agents/onchain.ts` | Uses deprecated Etherscan v1 endpoints |
| F6 | High | `src/orchestrator.ts` | `--mutation-test` silently disabled by `--no-audit-spec` |
| F7 | High | `src/agents/verifier.ts` | Test template import `../src/` resolves one level too high |
| F8 | Medium | `src/verification/halmos-json.ts` | `classify()` destructures `num_paths` unguarded |
| F9 | Medium | prompts | `/src/` hardcoded for non-default `src` dirs |
| F10 | Medium | `src/threat-model/ast-analysis.ts` | CEI walker skips `UncheckedBlock`/`Try`/`DoWhile` |
| F11 | Medium | docs + `precompute.ts` | `--allow-npm-install` docs contradict `--ignore-scripts` |
| F12 | Low | multiple | Unused code / dead exports |
| F13 | Low | `src/index.ts` | `program.parse()` with async actions (use `parseAsync`) |
| F14 | Low | `src/orchestrator.ts` | Empty final text → no report, exit 0 |
| F15 | Low | `etherscan.ts`, `eval-providers.sh`, README | Misc. |
| F16 | Low | `src/threat-model/ast-analysis.ts` | Stale header comment (artifact vs build-info) |

---

## High

### F1 — `require()` in an ES module: `srcDir` detection silently broken

**Location:** `src/agents/threat-modeler.ts:41-48` (compiled to `dist/agents/threat-modeler.js:27-28`)

```ts
// Read srcDir from foundry.toml if available
let srcDir = "src";
try {
  const { readFileSync } = require("fs");
  const { join } = require("path");
  const toml = readFileSync(join(pre.projectDir, "foundry.toml"), "utf-8");
  const m = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
  if (m) srcDir = m[1];
} catch { /* default */ }
```

**Symptom:** `package.json` has `"type": "module"`, so `require` is not defined in the emitted ESM module. The call throws `ReferenceError`, the `catch` swallows it, and `srcDir` always falls back to `"src"`.

**Evidence (confirmed):**
```
$ node --input-type=module -e 'try { require("fs") } catch(e) { console.log(e.message) }'
require is not defined
```
`dist/agents/threat-modeler.js:27` still contains `require("fs")`.

**Impact:** For any Foundry project with a non-default `src` (e.g. `src = "contracts"`), the agent prompt tells the model to look in `${projectDir}/src/` (`threat-modeler.ts:82`, `:167`) — a directory that does not exist. Only default-`src` projects are unaffected.

**Fix:** Import `readFileSync` and `join` at the top of the module via ESM imports and drop the `require` calls.

---

### F2 — Wrong `threatenedBy` functions (index mismatch)

**Location:** `src/threat-model/architecture-analyzer.ts:368-376`

```ts
threatenedBy: pair.mismatchedUpdates.length > 0
  ? pair.mismatchedUpdates
  : Object.values(s.functionSummary)
      .filter((f) => f.stateVarsWritten.some((v) =>
        v === pair.aggregate || v === pair.individual
      ))
      .map((_, i) => Object.keys(s.functionSummary)[i])
      .filter(Boolean),
```

**Symptom:** `.filter()` removes entries, so the surviving array's indices no longer align with `Object.keys(s.functionSummary)`. The `.map((_, i) => keys[i])` therefore returns the wrong function names.

**Evidence (confirmed):**
```
expected ['A.foo','C.baz'] -> got ['A.foo','B.bar']
```

**Impact:** The incorrect `threatenedBy` list is embedded in the blueprint's inferred invariants and then in `generateQuestions()` output (`architecture-analyzer.ts`), so the threat modeler is pointed at the wrong functions to investigate.

**Fix:** Iterate entries and keep the key:
```ts
Object.entries(s.functionSummary)
  .filter(([, f]) => f.stateVarsWritten.some((v) => v === pair.aggregate || v === pair.individual))
  .map(([k]) => k)
```

---

### F3 — Deduplication can merge the same threat twice

**Location:** `src/threat-model/providers/filters/dedup.ts:48-88`

```ts
for (let i = 0; i < threats.length; i++) {
  if (merged.has(i)) continue;
  for (let j = i + 1; j < threats.length; j++) {
    if (merged.has(j)) continue;
    const overlap = jaccardOverlap(threats[i].affectedCode, threats[j].affectedCode);
    if (overlap > OVERLAP_THRESHOLD && threats[i].category === threats[j].category) {
      const keepIdx = SEVERITY_RANK[threats[i].severity] >= SEVERITY_RANK[threats[j].severity] ? i : j;
      const dropIdx = keepIdx === i ? j : i;
      const keep = threats[keepIdx];
      const drop = threats[dropIdx];
      // ...merge description/properties/affectedCode...
      merged.add(dropIdx);
      mergeCount++;
    }
  }
}
```

**Symptom:** When `i` is the lower-severity threat (`keepIdx === j`, `dropIdx === i`), `merged.add(i)` happens but the inner loop keeps comparing the already-merged `i` against later threats. Its content is merged again into another threat, and `mergeCount` is inflated.

**Evidence (confirmed)** with A(Low), B(Critical), C(Critical), all same category/overlap:
```
merged A into B
merged A into C
merged C into B
mergeCount: 3
remaining: [ 'B' ]
B desc: B \n\n[Merged] A \n\n[Merged] C \n\n[Merged] A   <-- A appears twice
```

**Fix:** Once the current `i` is dropped, stop comparing it (`break` out of the inner loop), or track a per-iteration "already dropped" flag.

---

### F4 — Solodit enrichment is non-functional; the API key has no effect

**Location:** `src/threat-model/solodit.ts:110-119`

```ts
async function querySolodit(keyword: string, _soloditKey?: string): Promise<SoloditFinding[]> {
  try {
    const encoded = encodeURIComponent(keyword);
    const response = execSync(
      `curl -s "https://solodit.cyfrin.io/api/v1/search?query=${encoded}&limit=5" 2>/dev/null`,
      ...
```

**Symptom A:** `_soloditKey` is never used — no auth header, query param, or bearer token is added. The caller chain is `solodit.ts:38` → `querySolodit(keyword, soloditKey)`, but the parameter is dropped. So `--solodit-key` / `SOLODIT_API_KEY` do nothing.

**Symptom B (confirmed live):** the endpoint is not an API:
```
$ curl -s -o /dev/null -w "%{http_code} %{content_type}" "https://solodit.cyfrin.io/api/v1/search?query=reentrancy&limit=1"
404 text/html
```
`JSON.parse` on the HTML throws, the catch returns `[]`, and no findings are ever attached.

**Impact:** `--solodit` runs but never enriches anything; `metadata.soloditFindings` stays 0.

**Fix:** Either point at the real Solodit API/MCP with the key applied, or remove the provider/flag.

---

### F5 — On-chain agent uses deprecated Etherscan v1 endpoints

**Location:** `src/agents/onchain.ts:17-70` (`getEtherscanBase`, `buildOnchainPrompt`)

The prompt hands the agent legacy v1 URLs, e.g.:
```
curl -s "https://api.etherscan.io/api?module=account&action=txlist&address=...&apikey=..."
```
and per-chain v1 subdomains (`api.polygonscan.com`, `api.arbiscan.io`, `api-goerli.etherscan.io`).

**Evidence (confirmed live):**
```json
{"status":"0","message":"NOTOK",
 "result":"You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration"}
```
Etherscan v1 was fully deprecated on 2025-08-15.

**Contrast:** the precompute provider already uses v2 correctly:
`src/threat-model/providers/precompute/etherscan.ts:77` → `https://api.etherscan.io/v2/api` + `chainid`.

**Fix:** Migrate the on-chain agent prompt to the v2 base URL with a `chainid` parameter, and drop the per-chain subdomains.

---

### F6 — `--mutation-test` silently does nothing with `--no-audit-spec`

**Location:** `src/orchestrator.ts:223-263`

```ts
if (opts.auditSpec !== false) {
  try {
    // ... vacuity classification ...
    if (opts.mutationTest) {
      // ... mutation testing ...
    }
  } catch (err) { ... }
}
```

Mutation testing is nested inside the audit-spec block, so `analyze --mutation-test --no-audit-spec` runs no mutation testing and prints no warning.

**Evidence:** CLI help lists the two flags independently (`node dist/index.js analyze --help`), and `runMutationTesting` establishes its own baseline (`cleanBuild` + `runHalmos` in `mutation/runner.ts`), so it does not need the vacuity run.

**Fix:** Run mutation testing outside the `auditSpec !== false` guard (it is independent of the vacuity classification).

---

### F7 — Verifier test template uses the wrong relative import path

**Location:** `src/agents/verifier.ts:53`

```solidity
import {TargetContract} from "../src/TargetContract.sol";
```

Tests are written to `<project>/.forge-proof/test/`. Relative to that file, `../src` resolves to `<project>/.forge-proof/src`, not `<project>/src`. The correct path is `../../src/...`.

**Evidence (confirmed):** the committed benchmark tests use `../../src`:
- `reports/damn-vulnerable-defi/halmos-tests/SideEntranceVerification.t.sol:6` → `"../../src/side-entrance/SideEntranceLenderPool.sol"`
- `reports/damn-vulnerable-defi/halmos-tests/TrusterVerification.t.sol:7` → `"../../src/truster/TrusterLenderPool.sol"`

**Impact:** agents copying the template emit uncompilable imports until they debug and fix them.

**Fix:** Change the template to `../../src/TargetContract.sol`.

---

## Medium

### F8 — Unguarded destructuring in the Halmos classifier

**Location:** `src/verification/halmos-json.ts:103`

```ts
function classify(t: RawTestResult): { verdict: Verdict; reason?: string } {
  const [, normalPaths] = t.num_paths;
```

Everywhere else the module is defensive (`t.num_paths?.[0] ?? 0`), but here a missing `num_paths` throws `TypeError: Cannot destructure property ... of undefined`.

**Fix:** `const normalPaths = t.num_paths?.[1] ?? 0;`

---

### F9 — Prompts hardcode `/src/` for non-default `src` directories

**Locations:**
- `src/orchestrator.ts:412` (verify-only prompt): `Source contracts are in: ${projectDir}/src/`
- `src/orchestrator.ts:498` (analyze prompt): `...the contract source code in ${projectDir}/src/`
- `src/threat-model/orchestrator.ts:399,404`: `...in ${pre.projectDir}/src/...`

`precompute.ts` and `ast-analysis.ts` read `src` from `foundry.toml` correctly, so the structural analysis is fine, but the natural-language briefs point at the wrong directory for projects like `src = "contracts"` or `src = "src/contracts"`.

**Fix:** Resolve `srcDir` from `foundry.toml` once and interpolate it into the prompts (this also makes F1 moot for the prompt text).

---

### F10 — CEI operation-order walker misses common constructs

**Location:** `src/threat-model/ast-analysis.ts` (`extractOperationOrder` → `walkStatements` / `classifyExpression`)

`walkStatements` handles only `Block`, `ExpressionStatement`, `VariableDeclarationStatement`, `IfStatement`, `ForStatement`/`WhileStatement`, `RevertStatement`, `Return`. It does not descend into:
- `UncheckedBlock`
- `TryStatement` (try/catch)
- `DoWhileStatement`

Also `classifyExpression` does not recurse into function-call arguments, so nested calls such as `foo(bar())` only record `foo`.

**Impact:** state writes and external calls inside `unchecked {}`, `try { ... } catch { ... }` and `do { ... } while` blocks are not recorded, so pre-detected CEI violations (and attack-surface scoring) can under-report.

**Fix:** Handle those node types in `walkStatements`, and recurse into `FunctionCall.arguments` in `classifyExpression`.

---

### F11 — `--allow-npm-install` docs contradict the code

**Locations:**
- Code: `src/threat-model/precompute.ts:50` → `execSync("npm install --silent --ignore-scripts", ...)`
- Docs claiming scripts run:
  - `README.md:75`, `README.md:187-188`
  - `CLAUDE.md:99`
  - `src/index.ts:205-206` (CLI help text)
- Docs stating the opposite: `README.md:485-486` ("runs with `--ignore-scripts`")

**Symptom:** The README is internally inconsistent, and the flag's help text overstates the risk. Because `--ignore-scripts` is passed, the target's lifecycle scripts are *not* executed.

**Fix:** Make the docs match the code (remove "executes its lifecycle scripts" language), or remove `--ignore-scripts` if running scripts is actually intended.

---

## Low / cleanup

### F12 — Unused code and dead exports

| Symbol | Location | Note |
|--------|----------|------|
| `receivesMsgValue` | `src/threat-model/architecture-analyzer.ts:259` | Computed, never used |
| `collectSolFileNames` | `src/threat-model/ast-analysis.ts:996` | Never called |
| `detectPragma` | `src/scaffold/foundry-project.ts:151` | Exported, never used |
| `agentPassProviders` | `src/threat-model/providers/registry.ts:70` | No provider uses the `agent-pass` phase |

`tsconfig.json` does not enable `noUnusedLocals`, so the compiler stays silent.

### F13 — `program.parse()` with async actions

`src/index.ts:333` calls `program.parse()`, but every `.action(...)` handler is `async`. Commander does not await async actions with `parse()`; `parseAsync()` is the correct call. It currently works because child processes/network keep the event loop alive and the handlers catch their own errors, but `parseAsync` is more robust.

### F14 — Empty final text produces no report, exit 0

`src/orchestrator.ts:273` only writes a report `if (finalReport.trim())`. If verification wrote tests (so the guard at `:200` passes) but the orchestrator returned no final text, the run exits 0 with no report. A silent partial-success is worth surfacing.

### F15 — Miscellaneous

- `src/threat-model/providers/precompute/etherscan.ts`: sort comparators return `-1` for equal elements (`b.value > a.value ? 1 : -1`, and the same for `parameterRanges`), which is not a valid strict-weak-ordering comparator.
- `benchmarks/eval-providers.sh:38`: hard-gates on `ANTHROPIC_API_KEY`, contradicting the documented gateway/Bedrock/Vertex credential paths.
- `README.md:14` vs `:19`: headline says "19/19 Vulnerabilities Found" while the score line says "18/18 challenges" (the threat model contains 19 threats; the report records 16 violations). Pick one consistent metric.
- `src/orchestrator.ts:199`: `const verificationExpected = true;` makes the condition a constant — either remove it or make it meaningful.
- `src/threat-model/orchestrator.ts` `parseAgentOutput` strategy 4 uses a greedy `[\s\S]*` that can over-capture past the threats array.

### F16 — Stale header comment in `ast-analysis.ts`

`src/threat-model/ast-analysis.ts:8-9` says ASTs come from per-contract artifact JSON (`out/<File>.sol/<Contract>.json`), but `analyzeFromAST` actually reads `out/build-info/*.json`. Update the comment to match.

---

## Verified-good (not issues)

- Credential resolution correctly supports `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`. The Anthropic SDK constructor does read both env vars (`node_modules/@anthropic-ai/sdk/client.js:59,70,79`), so the OpenRouter path works.
- Halmos big-integer preservation (`preserveBigIntegers`) and byte-offset mutation handling (`operators.ts`) are sound.
- Agent isolation is applied consistently: `settingSources: []` on both orchestrators and `omitClaudeMd: true` on every agent.
- `runHalmos` treats a non-zero Halmos exit as expected and only fails on a missing JSON report.

---

## Suggested fix order

1. F1, F2, F3 (silent wrong output in the threat-model pipeline)
2. F5, F4 (broken external enrichment paths)
3. F6, F7 (analyze/verifier correctness)
4. F8, F9, F10 (defensive gaps)
5. F11–F16 (docs/cleanup)
