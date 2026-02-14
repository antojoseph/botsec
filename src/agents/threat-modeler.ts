/**
 * Threat Modeler Agent — deep code exploration for systematic threat modeling.
 *
 * Uses pre-computed structural analysis (solc AST call graphs, forge inspect
 * storage layouts, Etherscan v2 transaction data) as a "code map" and systematic
 * cross-referencing patterns to produce evidence-backed threats.
 *
 * Every threat MUST include a TRACE — the exact code locations traversed to find it.
 */

import type { AgentDefinition } from "./explorer.js";
import type { PrecomputedAnalysis } from "../threat-model/types.js";

export function threatModelerAgent(
  precomputed: PrecomputedAnalysis
): AgentDefinition {
  return {
    description:
      "Deep code exploration specialist for smart contract threat modeling. Traces call graphs, " +
      "builds CEI timelines, follows inheritance chains, and resolves interface implementations " +
      "to produce evidence-backed threats. Every threat includes the exact code trace that found it.",
    prompt: buildThreatModelerPrompt(precomputed),
    tools: ["Read", "Grep", "Glob", "Bash"],
    model: "opus",
  };
}

function buildThreatModelerPrompt(pre: PrecomputedAnalysis): string {
  const hasStructural = !!pre.structural;
  const hasOnChain = !!pre.onChain;

  return `You are a smart contract security researcher performing SYSTEMATIC THREAT MODELING through deep code exploration.

CRITICAL RULE: Every threat you identify MUST include a TRACE showing the exact sequence of code locations you traversed to discover it. A threat without a trace is speculation — delete it. You are building an evidence chain, not generating opinions.

Your working directory is: ${pre.projectDir}
All source contracts are in: ${pre.projectDir}/src/

## Your Task

Produce a structured threat model as JSON. You must:
1. Classify the contract type (vault/dex/lending/token/governance/bridge/staking/nft/oracle/proxy/other)
2. Identify actors, assets, and trust boundaries
3. Systematically enumerate threats using the cross-referencing patterns below
4. For each threat, include the TRACE showing how you found it

${hasStructural ? buildCodeMapSection(pre) : buildFallbackSection()}

${hasOnChain ? buildOnChainSection(pre) : "## No On-Chain Data\nNo on-chain address was provided. Analyze based on code alone."}

## Systematic Cross-Referencing Strategy

You have Read, Grep, Glob, and Bash tools. Use them in coordinated sequences to trace code paths.

### Pattern 1 — External Call Receiver Tracing

For each external call found in the ${hasStructural ? "function summary above" : "source code"}:
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

The Operation Order data above shows the execution order of operations per function.
Look for any "state-write" step that appears AFTER an "external-call" step — this is a CEI violation.

For each function flagged:
1. Read the actual function body to confirm the ordering
2. Identify what state is written after the external call
3. Trace: can the external call re-enter this function?
   - Does any path from the external target lead back to this function?
4. If yes: this is a reentrancy vulnerability. Build the full attack scenario.

### Pattern 3 — State Variable Conservation Check

For each pair of state vars that should maintain an invariant (e.g., totalDeposits == sum(balances[*])):
1. From the ${hasStructural ? "state var map above" : "code"}, find all functions that write to either variable
2. Read each writing function
3. Verify: every write to var A has a corresponding write to var B
4. Find: any code path where they diverge
   - External calls between paired writes (reentrancy can break conservation)
   - Conditional branches where only one is updated
   - Functions that write to one but not the other

### Pattern 4 — Reverse Xref (Who Calls Function X?)

From the ${hasStructural ? "call graph above" : "source code (Grep for function calls)"}:
1. For a given function X, find all internal callers of X
2. Find all external callers (public/external visibility)
3. Trace caller chains: if A calls B calls X, then A can reach X
4. For reentrancy: can an external call from X eventually call X again?
   - Follow: X calls external → external calls Y → Y calls X (back-edge)

### Pattern 5 — Interface Assumption Validation

For each external interface the contract interacts with:
1. Grep for the interface definition
2. Read the interface — what functions does it declare?
3. If implementation is available in the codebase: Read it, trace its behavior
4. If implementation is external (e.g., arbitrary IERC20):
   - Document ALL possible behaviors: fee-on-transfer, rebasing, hooks, revert
   - For each contract function that calls through this interface:
     a. Does it check return values?
     b. Does it measure balance-before/balance-after?
     c. Does it handle zero amounts?

### Pattern 6 — Privilege Escalation Path Tracing

The Auth Checks data above shows which functions check msg.sender and what they compare against.

1. From Auth Checks: find all functions with checksMsgSender=true — these are access-controlled
2. Find functions WITHOUT auth checks that write to critical state — these may be unguarded
3. Grep for how the owner/admin address is set and if it can change
4. For each admin function: what damage can it do? (pause, drain, upgrade, change params)
5. Trace: is there any path from unprivileged caller to admin state change?
   - Check: are any guards bypassable via flash loan manipulation?
${hasOnChain ? "5. Correlate with Etherscan v2 admin actions data — who actually called these?" : ""}

### Pattern 7 — Source-to-Sink Value Tracing

For each function that accepts value (payable) or token transfers:
1. Identify the SOURCE: where does value enter? (msg.value, transferFrom, etc.)
2. Trace through state: what state variables does it update?
3. Identify the SINK: where does value exit? (transfer, call with value, etc.)
4. Build the full flow: deposit() → balances[user] → withdraw() → user.call{value}()
5. Check: can the flow be interrupted or diverted?
   - Can an attacker enter at source and exit at a different sink?
   - Can value get stuck (no sink reachable)?
   - Do intermediate state updates match source and sink amounts?
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
          {"action": "AST", "target": "operationOrder", "finding": "state-write after external-call in withdraw()"},
          {"action": "Read", "target": "src/Vault.sol:30-42", "finding": "msg.sender.call at line 34"},
          {"action": "Grep", "target": "balances\\\\[ in Vault.sol", "finding": "write at line 38, AFTER call at 34"},
          {"action": "Read", "target": "src/Vault.sol:38-39", "finding": "balances[msg.sender] -= amount after external call"}
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

Now analyze the contracts in ${pre.projectDir}/src/ using the patterns above.`;
}

function buildCodeMapSection(pre: PrecomputedAnalysis): string {
  const s = pre.structural!;
  return `## Code Map (pre-computed from solc AST + forge inspect)

Use this map to guide your exploration. DO NOT re-discover what's already here.
Instead, use the map to identify INTERESTING PATHS to trace deeply.

### Contract Inheritance
${JSON.stringify(s.inheritance, null, 2)}

### Function Summary (who reads/writes what, who calls whom)
${JSON.stringify(s.functionSummary, null, 2)}

### State Variable Read/Write Map
${JSON.stringify(s.stateVarMap, null, 2)}

### Call Graph
${JSON.stringify(s.callGraph, null, 2)}

### Operation Order (for CEI analysis — look for state-write AFTER external-call)
${JSON.stringify(s.operationOrder, null, 2)}

### Auth Checks (msg.sender conditions per function)
${JSON.stringify(s.authChecks, null, 2)}

### Guard Inventory (require/assert/revert per function)
${JSON.stringify(s.guardInventory, null, 2)}

### Data Dependencies (variable A depends on variable B — transitive)
Contract-level (cross-function):
${JSON.stringify(s.dataDependency.byContract, null, 2)}

Tainted variables (depend on msg.sender, msg.value, function params):
${JSON.stringify(s.dataDependency.tainted, null, 2)}

### Storage Layout
${JSON.stringify(pre.storageLayout, null, 2)}`;
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
