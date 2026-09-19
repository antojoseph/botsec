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

IMPORTANT: Only read data from the paths listed above. Do NOT read files from forge-proof-output/ or any other directory — those may contain stale data from previous runs on different projects.`
    : `## No Pre-Computed Data
No structural analysis data is available. Use Read/Grep/Glob to explore the codebase manually.
Do NOT read files from forge-proof-output/ or .forge-proof/ — no pre-computed data was generated for this project.`;

  return `You are a smart contract security researcher performing SYSTEMATIC THREAT MODELING through deep code exploration.

CRITICAL RULE: Every threat you identify MUST include a TRACE showing the exact sequence of code locations you traversed to discover it. A threat without a trace is speculation — delete it. You are building an evidence chain, not generating opinions.

FOCUS RULE: Concentrate ALL analysis on threats from UNTRUSTED actors (external users, depositors, withdrawers, arbitrary callers). Do NOT spend time on threats that require a trusted or semi-trusted actor to be malicious or compromised (owner, admin, strategist, rate updater, solver). Governance/admin misconfiguration is out of scope — assume privileged roles act honestly. The goal is to find vulnerabilities that an unprivileged attacker can exploit.

Your working directory is: ${pre.projectDir}
All source contracts are in: ${pre.projectDir}/${srcDir}/

## Your Task

Produce a structured threat model as JSON. You must:
1. Read the blueprint file first to get the contract classification and investigation questions
2. Identify actors, assets, and trust boundaries
3. Work through the INVESTIGATION QUESTIONS from the blueprint — each one is a pre-computed lead you must confirm or refute by reading actual code
4. For each confirmed threat, include the TRACE showing how you found it
5. After exhausting the pre-computed leads, apply the cross-referencing patterns to find anything missed

${dataSection}
${opts?.extraDataSections ? `\n${opts.extraDataSections}` : ""}
${hasOnChain ? buildOnChainSection(pre) : "## No On-Chain Data\nNo on-chain address was provided. Analyze based on code alone."}

## How to Work

1. **START by reading the blueprint file** — it contains investigation questions, attack surface rankings, inferred invariants, and pre-detected CEI violations. These are your highest-priority leads.

2. **For each investigation question:**
   a. Read the actual source code at the locations mentioned
   b. Determine: is this a real threat, a false positive, or needs more investigation?
   c. If real: build the full attack scenario and trace
   d. If false positive: briefly note why (e.g., "reentrancy guard present on line 42")

3. **Validate the inferred invariants** — read the code to confirm each invariant should hold.

4. **Use the attack surface ranking** to allocate your time — spend more turns on high-score functions.

5. **Use the code map file** when you need detailed structural data (call graphs, state var read/write maps, auth checks, etc.) — search with Grep for specific contract or function names.

6. **Apply cross-referencing patterns** for any angle not covered:
   - External call receiver tracing (who can callback?)
   - CEI timeline construction (state-write after external-call?)
   - State variable conservation (paired writes diverge?)
   - Reverse xref (who calls function X?)
   - Interface assumption validation (fee-on-transfer? return values checked?)
   - Privilege escalation paths (unguarded state mutators?)
   - Source-to-sink value tracing (can attacker divert value?)

## Output Format

Output ONLY valid JSON matching this schema. Do NOT include any text before or after the JSON.

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

ANTI-SLOP RULE: If you cannot fill in the trace.steps with REAL code locations you actually read, DO NOT include the threat. Speculation without evidence is worse than silence.

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
