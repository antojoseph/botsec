/**
 * Threat Modeler Agent — deep code exploration for systematic threat modeling.
 *
 * Uses pre-computed structural analysis (solc AST call graphs, forge inspect
 * storage layouts, Etherscan v2 transaction data) AND an architectural blueprint
 * (contract classification, attack surface scoring, inferred invariants,
 * pre-organized pattern findings) to produce evidence-backed threats.
 *
 * The blueprint answers three questions deterministically before the agent starts:
 * 1. WHAT is this contract? (classification + known vulnerability classes)
 * 2. WHERE should the agent look first? (attack surface scoring + investigation questions)
 * 3. WHAT should be true? (inferred invariants the agent confirms or refutes)
 *
 * Every threat MUST include a TRACE — the exact code locations traversed to find it.
 */

import type { AgentDefinition } from "./explorer.js";
import type { PrecomputedAnalysis } from "../threat-model/types.js";

export function threatModelerAgent(
  precomputed: PrecomputedAnalysis,
  opts?: { costControl?: boolean }
): AgentDefinition {
  return {
    description:
      "Deep code exploration specialist for smart contract threat modeling. Receives an " +
      "architectural blueprint (contract classification, attack surface scores, inferred " +
      "invariants, pre-organized pattern findings) and uses it to trace call graphs, " +
      "build CEI timelines, follow inheritance chains, and resolve interface implementations. " +
      "Every threat includes the exact code trace that found it.",
    prompt: buildThreatModelerPrompt(precomputed, opts?.costControl),
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "opus",
  };
}

function buildThreatModelerPrompt(pre: PrecomputedAnalysis, costControl?: boolean): string {
  const hasStructural = !!pre.structural;
  const hasBlueprint = !!pre.blueprint;
  const hasOnChain = !!pre.onChain;

  return `You are a smart contract security researcher performing SYSTEMATIC THREAT MODELING through deep code exploration.

CRITICAL RULE: Every threat you identify MUST include a TRACE showing the exact sequence of code locations you traversed to discover it. A threat without a trace is speculation — delete it. You are building an evidence chain, not generating opinions.

Your working directory is: ${pre.projectDir}
All source contracts are in: ${pre.projectDir}/src/

## Your Task

Produce a structured threat model as JSON. You must:
1. Validate or correct the contract classification below
2. Identify actors, assets, and trust boundaries
3. Work through the INVESTIGATION QUESTIONS below — each one is a pre-computed lead you must confirm or refute by reading actual code
4. For each confirmed threat, include the TRACE showing how you found it
5. After exhausting the pre-computed leads, apply the cross-referencing patterns to find anything missed

${hasBlueprint ? buildBlueprintSection(pre) : ""}
${hasStructural ? (costControl ? buildTruncatedCodeMapSection(pre) : buildFullCodeMapSection(pre)) : buildFallbackSection()}
${hasOnChain ? buildOnChainSection(pre) : "## No On-Chain Data\nNo on-chain address was provided. Analyze based on code alone."}

## How to Work

You have a briefing packet above with pre-computed analysis. Your job is NOT to rediscover structure. Your job is to:

1. **START with the Investigation Questions** — these are the highest-priority leads. For each one:
   a. Read the actual source code at the locations mentioned
   b. Determine: is this a real threat, a false positive, or needs more investigation?
   c. If real: build the full attack scenario and trace
   d. If false positive: briefly note why (e.g., "reentrancy guard present on line 42")

2. **Validate the Inferred Invariants** — read the code to confirm each invariant should hold. Note any invariant that is actually violated by design (e.g., an intentional fee means balance < totalDeposits).

3. **Use the Attack Surface Ranking** to allocate your time — spend more turns on functions with score > 50 than on low-scoring getters.

4. **Apply the 7 Cross-Referencing Patterns** for any angle not already covered by the pre-computed findings.

## Systematic Cross-Referencing Patterns

You have Read, Grep, Glob, and Bash tools. Use them in coordinated sequences to trace code paths.

### Pattern 1 — External Call Receiver Tracing

${hasBlueprint && pre.blueprint!.patternFindings.externalCallReceivers.length > 0
  ? `Pre-computed external call receivers are listed above. For each one marked callbackRisk "high" or "medium":` : "For each external call found in the code:"}
1. Read the function body containing the external call
2. Determine the receiver: Is it a constructor-set immutable? A state var? msg.sender? A parameter?
3. If user-controlled (msg.sender, parameter, mutable state var):
   - This is a trust boundary crossing. The receiver can execute arbitrary code.
   - Grep for "receive()|fallback()" in the codebase — could the receiver callback into this contract?
4. If known contract (immutable set in constructor):
   - Grep for that contract/interface definition. Read its implementation.
   - Document: What does it do? Can it revert? Does it have hooks (ERC777)?
   - For IERC20: assume fee-on-transfer is possible unless proven otherwise.

### Pattern 2 — CEI Timeline Construction

${hasBlueprint && pre.blueprint!.patternFindings.ceiViolations.length > 0
  ? `Pre-computed CEI violations are listed above. For each one:` : "Look for any function where a state-write appears AFTER an external-call in the operation ordering:"}
1. Read the actual function body to confirm the ordering
2. Identify what state is written after the external call
3. Trace: can the external call re-enter this function?
   - Does any path from the external target lead back to this function?
4. If yes: this is a reentrancy vulnerability. Build the full attack scenario.

### Pattern 3 — State Variable Conservation Check

${hasBlueprint && pre.blueprint!.patternFindings.stateVarPairings.length > 0
  ? `Pre-computed aggregate-individual pairings are listed above. For each pair:` : "For each pair of state vars that should maintain an invariant:"}
1. Find all functions that write to either variable
2. Read each writing function
3. Verify: every write to var A has a corresponding write to var B
4. Find: any code path where they diverge
   - External calls between paired writes (reentrancy can break conservation)
   - Conditional branches where only one is updated
   - Functions that write to one but not the other

### Pattern 4 — Reverse Xref (Who Calls Function X?)

From the ${hasStructural ? "call graph" : "source code (Grep for function calls)"}:
1. For a given function X, find all internal callers of X
2. Find all external callers (public/external visibility)
3. Trace caller chains: if A calls B calls X, then A can reach X
4. For reentrancy: can an external call from X eventually call X again?
   - Follow: X calls external → external calls Y → Y calls X (back-edge)

### Pattern 5 — Interface Assumption Validation

${hasBlueprint && pre.blueprint!.patternFindings.interfaceAssumptions.length > 0
  ? `Pre-computed interface assumptions are listed above. For each assumption:` : "For each external interface the contract interacts with:"}
1. Read the interface definition and any available implementation
2. For each assumption listed: read the calling code and verify if it's checked
3. Specifically validate:
   a. Does it check return values from token transfers?
   b. Does it measure balance-before/balance-after for fee-on-transfer safety?
   c. Does it handle zero amounts, zero addresses, max uint256?

### Pattern 6 — Privilege Escalation Path Tracing

${hasBlueprint
  ? `Pre-computed privilege surface is listed above. Admin functions: ${pre.blueprint!.patternFindings.privilegeSurface.adminFunctions.length}, unguarded mutators: ${pre.blueprint!.patternFindings.privilegeSurface.unguardedStateMutators.length}. For each unguarded mutator:` : "For each function that writes state:"}
1. Determine if the lack of access control is intentional (e.g., deposit/withdraw are meant to be public)
2. For admin functions: what damage can they do? (pause, drain, upgrade, change params)
3. Grep for how the owner/admin address is set and if it can change
4. Trace: is there any path from unprivileged caller to admin state change?
${hasOnChain ? "5. Correlate with Etherscan v2 admin actions data — who actually called these?" : ""}

### Pattern 7 — Source-to-Sink Value Tracing

${hasBlueprint && pre.blueprint!.patternFindings.valueFlowPaths.length > 0
  ? `Pre-computed value flow paths are listed above. For each path where checksActualReceived is false:` : "For each function that accepts value (payable) or token transfers:"}
1. Read the source function: how does value enter?
2. Read the sink function: how does value exit?
3. Verify the intermediate state updates match amounts at both ends
4. Check: can an attacker enter at source and exit at a different sink for profit?
5. Check: can value get stuck with no reachable sink?
${hasOnChain ? `
If Etherscan v2 data is available:
6. Correlate with real transaction flows — do the theoretical paths match actual usage?
7. Flag high-value paths: if real txs show >100 ETH flowing through a path, mark as Critical
8. Note unused paths: theoretical sinks never used on-chain may indicate dead code or latent risk` : ""}

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
          {"action": "Grep", "target": "balances\\\\[ in Vault.sol", "finding": "balances[msg.sender] -= amount at line 38, AFTER call at 34"},
          {"action": "Read", "target": "src/Vault.sol:38-39", "finding": "Confirmed: state write happens after external call with no guard"}
        ],
        "ceiTimeline": {
          "function": "withdraw(uint256)",
          "stateReads": ["balances[msg.sender] at line 31"],
          "externalCall": "msg.sender.call{value: amount}('') at line 34",
          "stateWritesAfter": ["balances[msg.sender] -= amount at line 38"]
        }
      },
      "attackScenario": "1. Attacker deposits 1 ETH\\n2. Attacker calls withdraw(1 ETH)\\n3. Vault sends ETH to attacker via call\\n4. Attacker's receive() calls withdraw again\\n5. State not yet updated, so check passes\\n6. Repeat until vault is drained",
      "suggestedProperties": ["check_withdraw_cannot_exceed_balance", "check_vault_solvency"],
      "priority": 1
    }
  ]
}
\`\`\`

ANTI-SLOP RULE: If you cannot fill in the trace.steps with REAL code locations you actually read, DO NOT include the threat. Speculation without evidence is worse than silence.

Now analyze the contracts in ${pre.projectDir}/src/ using the investigation questions and patterns above.`;
}

// ---------------------------------------------------------------------------
// Blueprint Section — the new semantic briefing
// ---------------------------------------------------------------------------

function buildBlueprintSection(pre: PrecomputedAnalysis): string {
  const bp = pre.blueprint!;
  const sections: string[] = [];

  sections.push(`## Architectural Blueprint (pre-computed semantic analysis)

This blueprint was computed deterministically from the solc AST. It tells you WHAT this contract is, WHERE to look, and WHAT should be true. Use it as your starting point — confirm or refute each finding by reading actual code.`);

  // Classification
  sections.push(`
### Contract Classification
- **Type:** ${bp.classification.type} (confidence: ${bp.classification.confidence})
- **Signals:** ${bp.classification.signals.join("; ")}
- **Known vulnerability classes for ${bp.classification.type} contracts:**
${bp.classification.knownVulnerabilityClasses.map((v) => `  - ${v}`).join("\n")}`);

  // Investigation Questions (the most actionable part)
  if (bp.investigationQuestions.length > 0) {
    sections.push(`
### INVESTIGATION QUESTIONS (start here)

These are your highest-priority leads. Work through each one by reading the actual code.

${bp.investigationQuestions.map((q, i) => `**Q${i + 1}.** ${q}`).join("\n\n")}`);
  }

  // Attack Surface
  if (bp.attackSurface.length > 0) {
    sections.push(`
### Attack Surface Ranking (highest exposure first)

${bp.attackSurface
      .filter((a) => a.score > 0)
      .map(
        (a) =>
          `- **${a.function}** — score ${a.score}/100${a.unguarded ? " [UNGUARDED]" : ""}${a.receivesValue ? " [PAYABLE]" : ""}${a.makesExternalCalls ? " [EXT-CALLS]" : ""}\n  Factors: ${a.factors.join(", ")}`
      )
      .join("\n")}`);
  }

  // Inferred Invariants
  if (bp.inferredInvariants.length > 0) {
    sections.push(`
### Inferred Invariants (validate these)

These invariants were inferred from code structure. For each one, read the code to confirm it SHOULD hold, then note any function that could violate it.

${bp.inferredInvariants
      .map(
        (inv) =>
          `- **[${inv.kind}]** ${inv.description} (confidence: ${inv.confidence})\n  Assertion: \`${inv.assertion}\`\n  Threatened by: ${inv.threatenedBy.map(shortName).join(", ")}\n  State vars: ${inv.stateVars.map(shortName).join(", ")}`
      )
      .join("\n\n")}`);
  }

  // Pattern Findings
  const pf = bp.patternFindings;

  if (pf.ceiViolations.length > 0) {
    sections.push(`
### Pre-Detected CEI Violations (Pattern 2)

${pf.ceiViolations
      .map(
        (v) =>
          `- **${v.function}**: external call to \`${v.externalCall}\`, then writes: ${v.stateWritesAfter.join(", ")}` +
          (v.hasReentrancyGuard ? " (HAS reentrancy guard)" : " (NO reentrancy guard — INVESTIGATE)") +
          (v.reentrantPaths.length > 0
            ? `\n  Reentrant paths (other functions touching same state): ${v.reentrantPaths.join(", ")}`
            : "")
      )
      .join("\n")}`);
  }

  if (pf.stateVarPairings.length > 0) {
    sections.push(`
### State Variable Pairings (Pattern 3)

${pf.stateVarPairings
      .map(
        (p) =>
          `- **${shortName(p.aggregate)}** ↔ **${shortName(p.individual)}**: ${p.relationship}` +
          (p.mismatchedUpdates.length > 0
            ? `\n  WARNING: mismatched updates in: ${p.mismatchedUpdates.map(shortName).join(", ")}`
            : "\n  All updates appear paired.")
      )
      .join("\n")}`);
  }

  if (pf.interfaceAssumptions.length > 0) {
    sections.push(`
### Interface Assumptions to Validate (Pattern 5)

${pf.interfaceAssumptions
      .map(
        (ia) =>
          `- **${ia.interface}** (called by: ${ia.calledBy.map(shortName).join(", ")})\n${ia.assumptions.map((a) => `  - ${a}`).join("\n")}`
      )
      .join("\n")}`);
  }

  if (
    pf.privilegeSurface.adminFunctions.length > 0 ||
    pf.privilegeSurface.unguardedStateMutators.length > 0
  ) {
    sections.push(`
### Privilege Surface (Pattern 6)

**Admin functions (access-controlled):**
${pf.privilegeSurface.adminFunctions.map((f) => `- ${f}: guarded by ${(pf.privilegeSurface.guardedBy[f] || []).join(", ")}`).join("\n") || "  (none detected)"}

**Unguarded state mutators (public, no auth check, writes state):**
${pf.privilegeSurface.unguardedStateMutators.map((f) => `- ${f}`).join("\n") || "  (none detected — all state-writing functions have auth)"}`);
  }

  if (pf.externalCallReceivers.length > 0) {
    const highRisk = pf.externalCallReceivers.filter(
      (r) => r.callbackRisk === "high" || r.callbackRisk === "medium"
    );
    if (highRisk.length > 0) {
      sections.push(`
### External Call Receivers with Callback Risk (Pattern 1)

${highRisk
        .map(
          (r) =>
            `- **${r.function}** calls \`${r.call}\` — receiver: ${r.receiverType}, callback risk: ${r.callbackRisk}`
        )
        .join("\n")}`);
    }
  }

  if (pf.valueFlowPaths.length > 0) {
    sections.push(`
### Value Flow Paths (Pattern 7)

${pf.valueFlowPaths
      .map(
        (p) =>
          `- **${shortName(p.source)}** → [${p.intermediateState.map(shortName).join(" → ")}] → **${shortName(p.sink)}**` +
          (!p.checksActualReceived
            ? " — WARNING: source does not check actual amount received"
            : " — source checks balance before/after") +
          (p.hasExternalCallOnPath ? " — external call on path" : "")
      )
      .join("\n")}`);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Raw Code Map Section — structural data for deep reference
// ---------------------------------------------------------------------------

function buildFullCodeMapSection(pre: PrecomputedAnalysis): string {
  const s = pre.structural!;
  return `## Raw Code Map (structural AST data — use for deep reference)

The blueprint above summarizes the most important findings. This raw data is available for detailed investigation.

### Contract Inheritance
${JSON.stringify(s.inheritance, null, 2)}

### Function Summary (who reads/writes what, who calls whom)
${JSON.stringify(s.functionSummary, null, 2)}

### State Variable Read/Write Map
${JSON.stringify(s.stateVarMap, null, 2)}

### Call Graph
${JSON.stringify(s.callGraph, null, 2)}

### Operation Order (for CEI analysis)
${JSON.stringify(s.operationOrder, null, 2)}

### Auth Checks (msg.sender conditions per function)
${JSON.stringify(s.authChecks, null, 2)}

### Guard Inventory (require/assert/revert per function)
${JSON.stringify(s.guardInventory, null, 2)}

### Data Dependencies (transitive)
Contract-level:
${JSON.stringify(s.dataDependency.byContract, null, 2)}

Tainted variables:
${JSON.stringify(s.dataDependency.tainted, null, 2)}

### Storage Layout
${JSON.stringify(pre.storageLayout, null, 2)}`;
}

// Max code map size in characters (~200KB = ~50K tokens).
// Used with --cost-control to keep token usage low.
const CODE_MAP_BUDGET = 200_000;

function buildTruncatedCodeMapSection(pre: PrecomputedAnalysis): string {
  const s = pre.structural!;

  // Filter to high-value functions: those with external calls, CEI violations,
  // or that appear in the blueprint's attack surface (score > 0).
  const highValueFuncs = new Set<string>();
  if (pre.blueprint) {
    for (const entry of pre.blueprint.attackSurface) {
      if (entry.score > 0) highValueFuncs.add(entry.function);
    }
  }
  // Always include functions with external calls
  for (const [name, summary] of Object.entries(s.functionSummary)) {
    if (summary.externalCalls.length > 0) highValueFuncs.add(name);
  }

  // Filter function-keyed data to high-value functions only
  const filteredFuncSummary = filterByKeys(s.functionSummary, highValueFuncs);
  const filteredOpOrder = filterByKeys(s.operationOrder, highValueFuncs);
  const filteredAuthChecks = filterByKeys(s.authChecks, highValueFuncs);
  const filteredGuards = filterByKeys(s.guardInventory, highValueFuncs);

  // Filter storage layout to exclude DecoderAndSanitizer contracts
  const filteredStorage: Record<string, any> = {};
  for (const [name, layout] of Object.entries(pre.storageLayout)) {
    if (!name.includes("DecoderAndSanitizer") && !name.includes("Decoder")) {
      filteredStorage[name] = layout;
    }
  }

  // Build sections in priority order, tracking budget
  const sections: Array<{ label: string; data: string }> = [
    { label: "Contract Inheritance", data: JSON.stringify(s.inheritance) },
    { label: "Function Summary (filtered to high-value)", data: JSON.stringify(filteredFuncSummary) },
    { label: "State Variable Read/Write Map", data: JSON.stringify(s.stateVarMap) },
    { label: "Call Graph", data: JSON.stringify(s.callGraph) },
    { label: "Operation Order (for CEI analysis)", data: JSON.stringify(filteredOpOrder) },
    { label: "Auth Checks", data: JSON.stringify(filteredAuthChecks) },
    { label: "Guard Inventory", data: JSON.stringify(filteredGuards) },
    { label: "Tainted Variables", data: JSON.stringify(s.dataDependency.tainted) },
    { label: "Data Dependencies (contract-level)", data: JSON.stringify(s.dataDependency.byContract) },
    { label: "Storage Layout (core contracts)", data: JSON.stringify(filteredStorage) },
  ];

  let output = "## Raw Code Map (structural AST data — use for deep reference)\n\n";
  output += "The blueprint above summarizes the most important findings. This raw data is available for detailed investigation.\n";
  let budget = CODE_MAP_BUDGET - output.length;

  for (const section of sections) {
    const entry = `\n### ${section.label}\n${section.data}\n`;
    if (entry.length <= budget) {
      output += entry;
      budget -= entry.length;
    } else {
      output += `\n### ${section.label}\n(truncated — ${(section.data.length / 1024).toFixed(0)}KB exceeded budget)\n`;
    }
  }

  return output;
}

function filterByKeys<T>(obj: Record<string, T>, keys: Set<string>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.has(k)) result[k] = v;
  }
  return result;
}

function buildFallbackSection(): string {
  return `## No Pre-Computed Analysis Available

AST analysis did not produce results. You must build the code map yourself using Read/Grep/Glob:
1. Glob for all .sol files in src/
2. Grep for: contract/interface/library definitions, function signatures, state variables
3. Build your own call graph by Grepping for function calls
4. Map state variable reads/writes by Grepping for variable names with assignment operators

### Storage Layout (from forge inspect)
This is still available — check the ABI and storage layout for each contract.`;
}

function buildOnChainSection(pre: PrecomputedAnalysis): string {
  const o = pre.onChain!;
  return `## On-Chain Transaction Profile (Etherscan v2)

USE THIS DATA to prioritize threats on high-traffic, high-value code paths over dead code.

### Function Call Frequency (which code paths carry real traffic)
${JSON.stringify(o.functionCallFrequency, null, 2)}

### Top Callers
${JSON.stringify(o.topCallers.slice(0, 10), null, 2)}

### Value Flows (real ETH/token movement through the contract)
${JSON.stringify(o.valueFlows.slice(0, 15), null, 2)}

### Failed Transaction Patterns (potential attack surface / DoS)
${JSON.stringify(o.failedTxPatterns, null, 2)}

### Admin Actions (centralization evidence)
${JSON.stringify(o.adminActions, null, 2)}

### Real Parameter Ranges (use these for Halmos bounds in suggestedProperties)
${JSON.stringify(o.parameterRanges, null, 2)}

Use this data to:
- Prioritize threats on high-traffic, high-value code paths over dead code
- Confirm theoretical data flows with real transaction evidence
- Flag admin centralization risks backed by on-chain caller patterns
- Include real parameter ranges in suggested Halmos properties
- Note failed tx patterns as potential attack probing evidence`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortName(qualified: string): string {
  return qualified.includes(".") ? qualified.split(".").pop()! : qualified;
}
