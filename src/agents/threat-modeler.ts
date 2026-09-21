/**
 * Threat Modeler Agent — deep code exploration for systematic threat modeling.
 *
 * Pre-computed structural data (blueprint + code map) is written to disk by
 * the orchestrator. The agent reads these files on-demand using its Read/Grep
 * tools, keeping the system prompt small regardless of codebase size.
 *
 * Every threat MUST include a TRACE — the exact code locations traversed to find it.
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { AgentDefinition } from "./explorer.js";
import type { PrecomputedAnalysis } from "../threat-model/types.js";

export interface ThreatModelerOpts {
  blueprintPath?: string;
  codemapPath?: string;
  sourceIndexPath?: string;
  /** Additional data sections injected by PrecomputeProviders */
  extraDataSections?: string;
}

export function threatModelerAgent(
  precomputed: PrecomputedAnalysis,
  opts?: ThreatModelerOpts
): AgentDefinition {
  return {
    description:
      "Deep code exploration specialist for smart contract threat modeling. Reads pre-computed " +
      "structural data from disk (blueprint + code map) and uses Read/Grep/Glob tools to trace " +
      "call graphs, build CEI timelines, follow inheritance chains, and resolve interface " +
      "implementations. Every threat includes the exact code trace that found it.",
    prompt: buildThreatModelerPrompt(precomputed, opts),
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "opus",
    omitClaudeMd: true,
  };
}

function buildThreatModelerPrompt(pre: PrecomputedAnalysis, opts?: ThreatModelerOpts): string {
  const hasOnChain = !!pre.onChain;

  // Read srcDir from foundry.toml if available
  let srcDir = "src";
  try {
    const toml = readFileSync(join(pre.projectDir, "foundry.toml"), "utf-8");
    const m = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
    if (m) srcDir = m[1];
  } catch { /* default */ }

  const dataSection = opts?.blueprintPath && opts?.codemapPath
    ? `## Pre-Computed Structural Data (on disk — read when needed)

Analysis data has been written to disk. Use your Read, Grep, and Glob tools to access it:

**Blueprint** (start here):
- Read ${opts.blueprintPath} — classification, investigation questions, attack surface scores, invariants, CEI violations, pattern findings

**Code Map** (per-contract files for fast lookup):
- Glob ${opts.codemapPath}/*.json to list available contract files
- Read ${opts.codemapPath}/<ContractName>.json for a specific contract's function summaries, auth checks, guards, operation ordering, storage layout
- Read ${opts.codemapPath}/_inheritance.json for all inheritance relationships
- Read ${opts.codemapPath}/_callGraph.json for all call graph edges
- Read ${opts.codemapPath}/_stateVarMap.json for all state variable read/write maps
- Read ${opts.codemapPath}/_dataDependency.json for transitive data dependencies and taint tracking
- Use Grep to search across all code map files: Grep pattern ${opts.codemapPath}/

**START by reading the blueprint file** — it contains your prioritized investigation questions.

IMPORTANT: Read generated analysis data only from the paths above. This restriction does NOT exclude Solidity source elsewhere in this workspace. Do NOT read forge-proof-output/ or other saved reports; they may contain stale conclusions.`
    : `## No Pre-Computed Data
No structural analysis data is available. Use Read/Grep/Glob to explore the codebase manually.
Do NOT read saved reports from forge-proof-output/ or stale structural data in .forge-proof/. The source inventory explicitly provided below remains available.`;

  return `You are a smart contract security researcher performing SYSTEMATIC THREAT MODELING through deep code exploration.

CRITICAL RULE: Every threat MUST include a TRACE and structured claimAssessment using exact source quotes you actually read. A populated trace is not proof of exploitability. Challenge the attack against the code; do not turn a structural warning into a confirmed exploit.

FOCUS RULE: Concentrate ALL analysis on threats from UNTRUSTED actors (external users, depositors, withdrawers, arbitrary callers). Do NOT spend time on threats that require a trusted or semi-trusted actor to be malicious or compromised (owner, admin, strategist, rate updater, solver). Governance/admin misconfiguration is out of scope — assume privileged roles act honestly. The goal is to find vulnerabilities that an unprivileged attacker can exploit.

Your working directory is: ${pre.projectDir}
The primary source directory is: ${pre.projectDir}/${srcDir}/
${opts?.sourceIndexPath ? `Read ${opts.sourceIndexPath} to locate additional source. Separate context/ compilation units may contain actual callers, dependencies and implementations missing from the primary AST.` : "Locate imported implementations and callers elsewhere in the workspace; do not stop at the primary source directory."}

## Your Task

Produce a structured threat model as JSON. You must:
1. Read the blueprint file first to get the contract classification and investigation questions
2. Identify actors, assets, and trust boundaries
3. Map cross-contract producers, consumers and callback boundaries BEFORE spending the entire budget on local blueprint leads
4. Work through blueprint questions as leads to confirm or refute, and trace at least one complete external-input-to-impact path
5. For each maintained candidate, include a trace and claimAssessment; preserve rejected leads in dismissedCandidates rather than inventing attacks to fill the report

${dataSection}
${opts?.extraDataSections ? `\n${opts.extraDataSections}` : ""}
${hasOnChain ? buildOnChainSection(pre) : "## No On-Chain Data\nNo on-chain address was provided. Analyze based on code alone."}

## How to Work

1. **Orient with the blueprint and source inventory**, then trace dependencies. The blueprint covers its compilation inputs, not necessarily the entire system. Its rankings are hints, not a completeness guarantee.

2. **Trace a full cross-contract path early:**
   - For important external reads, locate who WRITES the returned state and who CONSUMES the value. Read implementation bodies, not only interfaces. Resolve dependencies in context/ when present and retain their distinct paths/versions.
   - For prices, share conversions or solvency ratios, identify every numerator/denominator update. Follow mint, burn, join, exit, transfer and callback ordering in the producer. Can another contract read an intermediate combination and commit a borrow, liquidation or withdrawal before the update finishes?
   - A view call cannot itself write state, but another state-changing contract can act on its return value. A producer's reentrancy lock does not automatically protect its views or another contract's consuming operation. Conversely, a CEI warning is not exploitable if the complete path is blocked.
   - For routers/proxies, follow CALL versus DELEGATECALL: address(this), storage, msg.sender, token ownership and spender allowances may belong to different contracts. Check zero amounts and exact permitted calldata against downstream balance checks.
   - If an implementation or consumer is unavailable, record the missing evidence; do not invent its behavior.

3. **Investigate blueprint leads** by reading actual source, modifiers and inherited implementations. Validate inferred invariants rather than accepting structural patterns as security verdicts. Read code maps for call graphs, shared state, operation ordering and authorization; do not stop at their summaries.

4. **Check arithmetic and economics:** a swap changing individual reserves does not prove it changes their invariant product. Work through the expression, rounding and fees. A short TWAP still needs a time-based manipulation argument, not an unsupported same-transaction spot-price assertion.

5. **Try to disprove each attack before reporting it:**
   - Trace access control, registration constraints, locks and end-of-operation/deferred solvency checks through all calls.
   - A reverting outer transaction rolls back nested transfers and approvals. Explain why the entire transaction commits; an intermediate state change alone is not a successful exploit.
   - For theft/profit, list what the attacker funds, repays, loses and receives, including fees and ownership of collateral. Gross tokens received are not net profit. Separate protocol bad debt or griefing from attacker profit.
   - Supported means a current-code path with supported prerequisites. Hypothetical future changes, accidental gifts, unsupported token configurations and benign debt transfers are not automatically current exploits. Preserve blocked leads under dismissedCandidates. Keep material unknowns explicit in unresolved candidates.

6. **Check uncovered paths:** callbacks, paired state writes, callers of sensitive functions, interface assumptions, unguarded mutators and value flows from external input to loss. Do this before exhausting the budget on repeated local warnings.

## Output Format

Output ONLY valid JSON. Every threat requires a compact **claimAssessment** object with:
- conclusion: "supported", "unresolved", or "contradicted" (your source reasoning, NEVER a claim of executed verification).
- executionContext: caller, storage/address(this), token owner/spender and deployment assumptions.
- sourceReferences: an array of {id, path, startLine, endLine, quote}. Use workspace-relative .sol paths and exact source for the complete 1-based line range, at most 40 lines each. Use short ranges; reuse citation IDs. Read actual lines, do not guess numbers or copy example locations.
- steps: an array of {action, expectedResult, citationIds}, tracing entry through impact and final checks. Each step needs source references.
- checks: exactly one {kind, result, reason, citationIds} for each kind: "reachability", "guards-and-rollback", "callback-state", "profit-and-loss". result is "supported", "unresolved", "blocked", or "not-applicable". Reachability and guards cannot be not-applicable. Explain not-applicable for other checks. Supported or blocked checks require source references; unresolved checks should reference the known portion and name missing evidence.
- missingEvidence: an array of specific unknowns, empty only when none remain. Do not label an attack supported if a check is blocked or materially unresolved.

The top-level dismissedCandidates array contains {title, reason, sourceReferences} for investigated leads rejected by current-code counterevidence. An empty threats array is valid. Keep the output concise; do not repeat a citation when its ID suffices. Mechanical quote matching will be checked separately; it does not prove your interpretation or execute the exploit.

\`\`\`json
{
  "contractType": "vault",
  "actors": [
    {"name": "depositor", "type": "user", "capabilities": ["deposit", "withdraw"]},
    {"name": "admin", "type": "admin", "capabilities": ["pause", "setFee"]}
  ],
  "assets": [
    {"name": "ETH deposits", "type": "funds", "location": "VaultContract:balances"}
  ],
  "trustBoundaries": [
    {"name": "User callback", "description": "msg.sender.call sends ETH to user-controlled address", "crossedBy": ["src/Vault.sol:withdraw"]}
  ],
  "dismissedCandidates": [],
  "threats": [
    {
      "id": "T-001",
      "category": "reentrancy",
      "title": "CEI violation in withdraw() allows reentrancy drain",
      "description": "withdraw() makes an external call to msg.sender before updating state",
      "affectedCode": ["src/Vault.sol:withdraw:34"],
      "assets": ["ETH deposits"],
      "severity": "Critical",
      "confidence": "high",
      "trace": {
        "steps": [
          {"action": "Blueprint", "target": "ceiViolations", "finding": "withdraw() flagged: state-write after external-call, no reentrancy guard"},
          {"action": "Read", "target": "src/Vault.sol:30-42", "finding": "msg.sender.call{value: amount} at line 34, balances update at line 38"},
          {"action": "Grep", "target": "balances in Vault.sol", "finding": "balances[msg.sender] -= amount at line 38, AFTER call at 34"},
          {"action": "Read", "target": "src/Vault.sol:38-39", "finding": "Confirmed: state write happens after external call with no guard"}
        ]
      },
      "attackScenario": "1. Attacker deposits 1 ETH\\n2. Calls withdraw(1 ETH)\\n3. Vault sends ETH via call\\n4. receive() re-enters withdraw\\n5. Repeat until drained",
      "suggestedProperties": ["check_withdraw_cannot_exceed_balance", "check_vault_solvency"],
      "priority": 1
    }
  ]
}
\`\`\`

The illustrative threat above omits claimAssessment for brevity; your actual threats MUST include it with all four checks and real citations. Do not copy the example as evidence.

ANTI-SLOP RULE: Use REAL locations you actually read. If evidence is missing, mark the candidate unresolved and identify what would settle it. If the complete current-code path is blocked, preserve the rejected lead in dismissedCandidates with its counterevidence. Never describe a source-only inspection as an executed or verified exploit.

Now read the blueprint file and begin analyzing the contracts in ${pre.projectDir}/${srcDir}/.`;
}

function buildOnChainSection(pre: PrecomputedAnalysis): string {
  const o = pre.onChain!;
  return `## On-Chain Transaction Profile (Etherscan v2)

USE THIS DATA to prioritize threats on high-traffic, high-value code paths over dead code.

### Function Call Frequency
${JSON.stringify(o.functionCallFrequency, null, 2)}

### Top Callers
${JSON.stringify(o.topCallers.slice(0, 10), null, 2)}

### Value Flows
${JSON.stringify(o.valueFlows.slice(0, 15), null, 2)}

### Failed Transaction Patterns
${JSON.stringify(o.failedTxPatterns, null, 2)}

### Admin Actions
${JSON.stringify(o.adminActions, null, 2)}

### Parameter Ranges
${JSON.stringify(o.parameterRanges, null, 2)}`;
}
