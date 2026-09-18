/**
 * Architecture Analyzer — builds an ArchitecturalBlueprint from StructuralAnalysis.
 *
 * This is the semantic layer that sits between raw AST extraction and the
 * threat modeler agent. It answers three questions:
 *
 * 1. WHAT is this contract? (classification)
 * 2. WHERE should the agent look first? (attack surface scoring)
 * 3. WHAT should be true? (invariant inference)
 *
 * Attack-surface scoring and invariant inference are deterministic, derived
 * purely from the AST. Contract classification is the one LLM call, and it
 * degrades to type "other" if no credential is available. The goal is to give
 * the agent a "briefing packet" so it spends its turns confirming/deepening
 * findings rather than rediscovering structure.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  StructuralAnalysis,
  ContractType,
  ArchitecturalBlueprint,
  ContractClassification,
  AttackSurfaceEntry,
  InferredInvariant,
  CeiViolation,
  StateVarPairing,
  ValueFlowPath,
  PatternFindings,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildBlueprint(
  structural: StructuralAnalysis,
  abi: Record<string, any[]>
): Promise<ArchitecturalBlueprint> {
  const classification = await classifyWithLLM(structural);
  const attackSurface = scoreAttackSurface(structural);
  const inferredInvariants = inferInvariants(structural, classification);
  const patternFindings = precomputePatternFindings(structural);
  const investigationQuestions = generateQuestions(
    classification,
    attackSurface,
    inferredInvariants,
    patternFindings
  );

  return {
    classification,
    attackSurface,
    inferredInvariants,
    patternFindings,
    investigationQuestions,
  };
}

// ---------------------------------------------------------------------------
// 1. Contract Classification (LLM-based)
// ---------------------------------------------------------------------------

const VALID_TYPES: ContractType[] = [
  "vault", "dex", "lending", "token", "governance",
  "bridge", "staking", "nft", "oracle", "proxy", "other",
];

/**
 * Classify the contract type using a fast LLM call (Haiku).
 * Reads contract names and their public/external function signatures to
 * determine the primary purpose. Far more accurate than static pattern
 * matching, especially for projects with many support contracts.
 */
async function classifyWithLLM(
  s: StructuralAnalysis
): Promise<ContractClassification> {
  // Build a compact summary: contract names → public/external functions
  const contractFuncs: Record<string, string[]> = {};
  for (const [qualifiedName, summary] of Object.entries(s.functionSummary)) {
    if (summary.visibility !== "public" && summary.visibility !== "external") continue;
    const [contract, func] = qualifiedName.includes(".")
      ? [qualifiedName.split(".")[0], qualifiedName.split(".").slice(1).join(".")]
      : ["Unknown", qualifiedName];
    if (!contractFuncs[contract]) contractFuncs[contract] = [];
    contractFuncs[contract].push(func);
  }

  // Limit to keep prompt small — show up to 30 contracts, 10 functions each
  const contractEntries = Object.entries(contractFuncs).slice(0, 30);
  const summary = contractEntries
    .map(([c, funcs]) => `${c}: ${funcs.slice(0, 10).join(", ")}${funcs.length > 10 ? ` (+${funcs.length - 10} more)` : ""}`)
    .join("\n");

  const prompt = `Classify this Solidity project into exactly ONE type based on its contract names and public functions.

Valid types: ${VALID_TYPES.join(", ")}

Contracts and their public/external functions:
${summary}

Respond with ONLY a JSON object: {"type": "<type>", "confidence": "high"|"medium"|"low", "signals": ["reason1", "reason2"]}

Important: DecoderAndSanitizer contracts are just whitelisting helpers — ignore them for classification. Focus on the core contract architecture.`;

  try {
    // Deliberately a cheap model — this is a one-shot classification, not
    // analysis. Override with FORGE_PROOF_CLASSIFIER_MODEL when running through
    // an LLM gateway that namespaces model ids (e.g. OpenRouter expects
    // "anthropic/claude-haiku-4.5").
    const client = new Anthropic();
    const response = await client.messages.create({
      model: process.env.FORGE_PROOF_CLASSIFIER_MODEL || "claude-haiku-4-5",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    // Find the text block rather than assuming it is first — a thinking block
    // can precede it.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const json = JSON.parse(text.replace(/```json?\n?|\n?```/g, "").trim());
    const type = VALID_TYPES.includes(json.type) ? json.type : "other";

    return {
      type,
      confidence: json.confidence || "medium",
      signals: Array.isArray(json.signals) ? json.signals : [],
      knownVulnerabilityClasses: KNOWN_VULNS[type] || KNOWN_VULNS["other"],
    };
  } catch (err: any) {
    console.warn(`  Warning: LLM classification failed (${err.message?.slice(0, 80)}), defaulting to "other"`);
    return {
      type: "other",
      confidence: "low",
      signals: ["LLM classification unavailable"],
      knownVulnerabilityClasses: KNOWN_VULNS["other"],
    };
  }
}

const KNOWN_VULNS: Record<string, string[]> = {
  vault: [
    "First-depositor / inflation attack (ERC4626)",
    "Share price manipulation via donation",
    "Rounding errors in share/asset conversion",
    "Reentrancy in withdraw (CEI violation)",
    "Fee-on-transfer token incompatibility",
    "Flash loan deposit/withdraw for profit",
  ],
  dex: [
    "Price manipulation via flash loan",
    "Sandwich attack / front-running on swaps",
    "Constant-product invariant violation",
    "Reentrancy in swap callback",
    "Reserve update inconsistency",
    "Fee-on-transfer token pair handling",
  ],
  lending: [
    "Oracle price manipulation for undercollateralized borrow",
    "Liquidation threshold manipulation",
    "Flash loan borrow without proper collateral check",
    "Interest rate calculation rounding",
    "Bad debt accumulation (insolvency)",
    "Re-entrancy in liquidation flow",
  ],
  token: [
    "Infinite approval exploit",
    "Transfer fee accounting errors",
    "Rebasing supply inconsistency",
    "Permit/signature replay",
    "Double-spend via reentrancy",
  ],
  staking: [
    "Reward calculation manipulation",
    "Fee-on-transfer token staking insolvency",
    "Flash stake for reward extraction",
    "Reward distribution rounding errors",
    "Withdrawal griefing (DoS)",
  ],
  governance: [
    "Flash loan governance attack (borrow tokens, vote, return)",
    "Proposal execution front-running",
    "Voting power double-counting across snapshots",
    "Quorum manipulation",
    "Timelock bypass",
  ],
  bridge: [
    "Message replay across chains",
    "Fraudulent state proof acceptance",
    "Double-spending during lock/unlock",
    "Operator key compromise (centralization)",
    "Reorg handling failures",
  ],
  oracle: [
    "Stale price data usage",
    "Price manipulation in single block",
    "Flash loan TWAP manipulation",
    "Missing price feed validation",
    "Decimal precision mismatches",
  ],
  proxy: [
    "Storage collision between proxy and implementation",
    "Uninitialized implementation (selfdestruct risk)",
    "Function selector clash",
    "Upgrade to malicious implementation",
    "Delegatecall to untrusted target",
  ],
  nft: [
    "Reentrancy via onERC721Received callback",
    "Unrestricted minting",
    "Token ID collision / reuse",
    "Metadata manipulation",
  ],
  other: [
    "Reentrancy (CEI violations)",
    "Access control bypass",
    "Integer overflow/underflow",
    "Unhandled return values",
    "Front-running / MEV extraction",
  ],
};

// ---------------------------------------------------------------------------
// 2. Attack Surface Scoring
// ---------------------------------------------------------------------------

/**
 * Score each function by its attack surface exposure. Factors:
 * - External/public visibility (base score)
 * - Receives ETH (payable)
 * - Makes external calls (reentrancy surface)
 * - Writes state after external call (CEI violation)
 * - Lacks access control (unguarded)
 * - Handles token transfers
 * - Number of state variables written
 * - Number of state variables read (complexity)
 */
function scoreAttackSurface(s: StructuralAnalysis): AttackSurfaceEntry[] {
  const entries: AttackSurfaceEntry[] = [];

  for (const [funcName, summary] of Object.entries(s.functionSummary)) {
    // Only score external/public functions — internal ones aren't direct attack surface
    if (summary.visibility !== "external" && summary.visibility !== "public") {
      continue;
    }

    let score = 0;
    const factors: string[] = [];

    // Base: external/public visibility
    score += 10;
    factors.push(`${summary.visibility} visibility`);

    // Payable: can receive ETH
    // We detect this via ABI or presence of msg.value in dependencies
    const receivesMsgValue = Object.values(s.dataDependency.tainted)
      .some((vars) => vars.includes("msg.value"));
    const funcTainted = s.dataDependency.tainted[funcName] || [];
    const receivesValue = funcTainted.includes("msg.value");
    if (receivesValue) {
      score += 20;
      factors.push("receives ETH (payable)");
    }

    // External calls: reentrancy surface
    const makesExternalCalls = summary.externalCalls.length > 0;
    if (makesExternalCalls) {
      score += 15;
      factors.push(`${summary.externalCalls.length} external call(s): ${summary.externalCalls.join(", ")}`);
    }

    // CEI violation: state writes after external calls
    const opOrder = s.operationOrder[funcName] || [];
    let lastExternalCallIdx = -1;
    let hasStateWriteAfterCall = false;
    for (const op of opOrder) {
      if (op.type === "external-call") lastExternalCallIdx = op.index;
      if (op.type === "state-write" && lastExternalCallIdx >= 0 && op.index > lastExternalCallIdx) {
        hasStateWriteAfterCall = true;
      }
    }
    if (hasStateWriteAfterCall) {
      score += 25;
      factors.push("STATE WRITE AFTER EXTERNAL CALL (CEI violation)");
    }

    // Access control: unguarded state mutators are high-risk
    const authChecksForFunc = s.authChecks[funcName] || [];
    const hasMsgSenderCheck = authChecksForFunc.some((c) => c.checksMsgSender);
    const unguarded = !hasMsgSenderCheck && summary.stateVarsWritten.length > 0;
    if (unguarded) {
      score += 15;
      factors.push("no access control but writes state");
    }

    // State mutation volume
    if (summary.stateVarsWritten.length > 2) {
      score += 5;
      factors.push(`writes ${summary.stateVarsWritten.length} state vars`);
    }

    // Token transfer handling
    const handlesTokens = summary.externalCalls.some(
      (c) =>
        c.includes("transfer") ||
        c.includes("transferFrom") ||
        c.includes("safeTransfer")
    );
    if (handlesTokens) {
      score += 10;
      factors.push("handles token transfers");
    }

    // Low-level calls (higher risk than typed calls)
    const hasLowLevelCall = summary.externalCalls.some((c) =>
      c.startsWith("low_level.")
    );
    if (hasLowLevelCall) {
      score += 10;
      factors.push("uses low-level call");
    }

    // Cap at 100
    score = Math.min(100, score);

    entries.push({
      function: funcName,
      score,
      factors,
      receivesValue,
      makesExternalCalls,
      unguarded,
    });
  }

  // Sort by score descending
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// ---------------------------------------------------------------------------
// 3. Invariant Inference
// ---------------------------------------------------------------------------

/**
 * Infer likely invariants from structural patterns. These are hypotheses —
 * the agent and Halmos will validate them.
 */
function inferInvariants(
  s: StructuralAnalysis,
  classification: ContractClassification
): InferredInvariant[] {
  const invariants: InferredInvariant[] = [];

  // A. Aggregate-individual conservation invariants
  // Look for pairs like (totalDeposits, balances) or (totalStaked, staked)
  // where one is a scalar and the other is a mapping, and both are written
  // by the same functions.
  const aggregatePairs = findAggregatePairs(s);
  for (const pair of aggregatePairs) {
    invariants.push({
      description: `${pair.aggregate} should equal the sum of all ${pair.individual} entries`,
      kind: "conservation",
      stateVars: [pair.aggregate, pair.individual],
      threatenedBy: pair.mismatchedUpdates.length > 0
        ? pair.mismatchedUpdates
        : Object.values(s.functionSummary)
            .filter((f) => f.stateVarsWritten.some((v) =>
              v === pair.aggregate || v === pair.individual
            ))
            .map((_, i) => Object.keys(s.functionSummary)[i])
            .filter(Boolean),
      assertion: `assert(${shortName(pair.aggregate)} == sum(${shortName(pair.individual)}[*]))`,
      confidence: pair.mismatchedUpdates.length > 0 ? "medium" : "high",
    });
  }

  // B. Solvency: actual balance >= tracked balance
  // If the contract uses IERC20.balanceOf(address(this)) and also tracks state
  // like totalDeposits/totalStaked, the actual balance should be >= tracked.
  const balanceOfCalls = Object.entries(s.functionSummary).filter(([_, f]) =>
    f.externalCalls.some((c) => c.includes("balanceOf"))
  );
  const trackedTotals = Object.keys(s.stateVarMap).filter((v) => {
    const name = v.toLowerCase();
    return (
      name.includes("total") &&
      (name.includes("deposit") ||
        name.includes("stake") ||
        name.includes("balance") ||
        name.includes("supply"))
    );
  });

  if (trackedTotals.length > 0) {
    for (const total of trackedTotals) {
      invariants.push({
        description: `Contract's actual token/ETH balance should always be >= ${shortName(total)}`,
        kind: "solvency",
        stateVars: [total],
        threatenedBy: s.stateVarMap[total]?.writtenBy || [],
        assertion: `assert(token.balanceOf(address(this)) >= ${shortName(total)})`,
        confidence: "high",
      });
    }
  }

  // C. Vault-specific: share price monotonicity
  if (classification.type === "vault") {
    const hasConvertToAssets = Object.keys(s.functionSummary).some((f) =>
      f.toLowerCase().includes("converttoassets")
    );
    if (hasConvertToAssets) {
      invariants.push({
        description: "Share price should never decrease (excluding fees): converting 1 share should always return >= 1 asset after deposit",
        kind: "monotonicity",
        stateVars: Object.keys(s.stateVarMap).filter(
          (v) =>
            v.toLowerCase().includes("share") ||
            v.toLowerCase().includes("supply") ||
            v.toLowerCase().includes("asset")
        ),
        threatenedBy: Object.keys(s.functionSummary).filter((f) =>
          f.toLowerCase().includes("deposit") ||
          f.toLowerCase().includes("withdraw") ||
          f.toLowerCase().includes("redeem")
        ),
        assertion: "assert(convertToAssets(1e18) after deposit >= convertToAssets(1e18) before deposit)",
        confidence: "medium",
      });
    }

    // Vault: no zero-share deposits
    invariants.push({
      description: "A deposit of non-zero assets should always produce non-zero shares (prevents inflation attack)",
      kind: "no-profit",
      stateVars: Object.keys(s.stateVarMap).filter((v) =>
        v.toLowerCase().includes("share")
      ),
      threatenedBy: Object.keys(s.functionSummary).filter((f) =>
        f.toLowerCase().includes("deposit")
      ),
      assertion: "assert(assets > 0 implies shares > 0)",
      confidence: "high",
    });
  }

  // D. Staking-specific: reward conservation
  if (classification.type === "staking") {
    invariants.push({
      description: "Total rewards distributed should never exceed total rewards funded",
      kind: "conservation",
      stateVars: Object.keys(s.stateVarMap).filter((v) =>
        v.toLowerCase().includes("reward")
      ),
      threatenedBy: Object.keys(s.functionSummary).filter(
        (f) =>
          f.toLowerCase().includes("claim") ||
          f.toLowerCase().includes("reward") ||
          f.toLowerCase().includes("distribute")
      ),
      assertion: "assert(totalRewardsClaimed <= totalRewardsFunded)",
      confidence: "medium",
    });
  }

  // E. Access control invariants: admin-only functions should reject non-admin
  const adminFuncs = Object.entries(s.authChecks)
    .filter(([_, checks]) => checks.some((c) => c.checksMsgSender))
    .map(([func]) => func);
  if (adminFuncs.length > 0) {
    invariants.push({
      description: `Admin-only functions (${adminFuncs.map(shortName).join(", ")}) should revert when called by non-admin`,
      kind: "access",
      stateVars: [],
      threatenedBy: adminFuncs,
      assertion: "assert(msg.sender != admin implies revert)",
      confidence: "high",
    });
  }

  // F. No-profit: deposit then immediate withdraw should not yield profit
  const hasDeposit = Object.keys(s.functionSummary).some((f) =>
    f.toLowerCase().includes("deposit") || f.toLowerCase().includes("stake")
  );
  const hasWithdraw = Object.keys(s.functionSummary).some((f) =>
    f.toLowerCase().includes("withdraw") ||
    f.toLowerCase().includes("unstake") ||
    f.toLowerCase().includes("redeem")
  );
  if (hasDeposit && hasWithdraw) {
    invariants.push({
      description: "An immediate deposit-then-withdraw cycle should not yield profit for the depositor",
      kind: "no-profit",
      stateVars: [],
      threatenedBy: Object.keys(s.functionSummary).filter(
        (f) =>
          f.toLowerCase().includes("deposit") ||
          f.toLowerCase().includes("withdraw") ||
          f.toLowerCase().includes("stake") ||
          f.toLowerCase().includes("unstake") ||
          f.toLowerCase().includes("redeem")
      ),
      assertion: "assert(balance_after_withdraw <= balance_before_deposit)",
      confidence: "medium",
    });
  }

  return invariants;
}

// ---------------------------------------------------------------------------
// 4. Pattern Pre-computation
// ---------------------------------------------------------------------------

function precomputePatternFindings(s: StructuralAnalysis): PatternFindings {
  return {
    externalCallReceivers: findExternalCallReceivers(s),
    ceiViolations: findCeiViolations(s),
    stateVarPairings: findAggregatePairs(s),
    interfaceAssumptions: findInterfaceAssumptions(s),
    privilegeSurface: findPrivilegeSurface(s),
    valueFlowPaths: findValueFlowPaths(s),
  };
}

/** Pattern 1: Classify each external call's receiver trust level */
function findExternalCallReceivers(
  s: StructuralAnalysis
): PatternFindings["externalCallReceivers"] {
  const results: PatternFindings["externalCallReceivers"] = [];

  for (const [funcName, summary] of Object.entries(s.functionSummary)) {
    for (const call of summary.externalCalls) {
      let receiverType: "immutable" | "state-var" | "msg-sender" | "parameter" | "unknown" = "unknown";
      let callbackRisk: "high" | "medium" | "low" | "none" = "low";

      if (call.startsWith("low_level.")) {
        // Low-level calls (.call, .transfer, .send) typically go to msg.sender or a parameter
        receiverType = "msg-sender";
        callbackRisk = "high";
      } else if (call.includes("transfer") || call.includes("safeTransfer")) {
        // Token transfers: receiver is usually a parameter, but the token itself could be a state var
        receiverType = "state-var";
        callbackRisk = call.includes("safe") ? "medium" : "low";
      } else if (call.includes("balanceOf") || call.includes("totalSupply")) {
        receiverType = "state-var";
        callbackRisk = "none";
      } else {
        // External contract call — could be immutable or state var
        receiverType = "unknown";
        callbackRisk = "medium";
      }

      results.push({ function: funcName, call, receiverType, callbackRisk });
    }
  }

  return results;
}

/** Pattern 2: Find CEI violations from operation ordering */
function findCeiViolations(s: StructuralAnalysis): CeiViolation[] {
  const violations: CeiViolation[] = [];

  for (const [funcName, ops] of Object.entries(s.operationOrder)) {
    let lastExternalCall: string | null = null;
    let lastExternalCallIdx = -1;
    const stateWritesAfter: string[] = [];

    for (const op of ops) {
      if (op.type === "external-call") {
        lastExternalCall = op.target;
        lastExternalCallIdx = op.index;
      }
      if (
        op.type === "state-write" &&
        lastExternalCallIdx >= 0 &&
        op.index > lastExternalCallIdx
      ) {
        stateWritesAfter.push(op.target);
      }
    }

    if (lastExternalCall && stateWritesAfter.length > 0) {
      // Check for reentrancy guard
      const funcSummary = s.functionSummary[funcName];
      const hasReentrancyGuard = funcSummary?.modifiers.some(
        (m) =>
          m.toLowerCase().includes("nonreentrant") ||
          m.toLowerCase().includes("reentrancy")
      ) ?? false;

      // Find reentrant paths: functions reachable from the external call
      // that write to the same state variables
      const affectedVars = new Set(stateWritesAfter);
      const reentrantPaths: string[] = [];
      for (const [otherFunc, otherSummary] of Object.entries(
        s.functionSummary
      )) {
        if (otherFunc === funcName) continue;
        if (
          otherSummary.visibility === "external" ||
          otherSummary.visibility === "public"
        ) {
          const writesAffected = otherSummary.stateVarsWritten.some((v) =>
            affectedVars.has(v)
          );
          if (writesAffected) {
            reentrantPaths.push(otherFunc);
          }
        }
      }

      violations.push({
        function: funcName,
        externalCall: lastExternalCall,
        stateWritesAfter,
        hasReentrancyGuard,
        reentrantPaths,
      });
    }
  }

  return violations;
}

/** Pattern 3: Find aggregate-individual state variable pairs */
function findAggregatePairs(s: StructuralAnalysis): StateVarPairing[] {
  const pairs: StateVarPairing[] = [];
  const vars = Object.entries(s.stateVarMap);

  // Heuristic: a "total" scalar paired with a mapping, both written by overlapping functions
  const scalars = vars.filter(
    ([name, info]) =>
      !info.type.includes("mapping") &&
      (name.toLowerCase().includes("total") ||
        name.toLowerCase().includes("supply"))
  );
  const mappings = vars.filter(([_, info]) =>
    info.type.includes("mapping")
  );

  for (const [scalarName, scalarInfo] of scalars) {
    for (const [mappingName, mappingInfo] of mappings) {
      // Check if they share writers
      const commonWriters = scalarInfo.writtenBy.filter((f) =>
        mappingInfo.writtenBy.includes(f)
      );
      if (commonWriters.length === 0) continue;

      // Check if one writes without the other
      const scalarOnly = scalarInfo.writtenBy.filter(
        (f) => !mappingInfo.writtenBy.includes(f)
      );
      const mappingOnly = mappingInfo.writtenBy.filter(
        (f) => !scalarInfo.writtenBy.includes(f)
      );

      const mismatchedUpdates = [...scalarOnly, ...mappingOnly];

      // Infer relationship based on naming
      const scalarShort = shortName(scalarName).toLowerCase();
      const mappingShort = shortName(mappingName).toLowerCase();

      let relationship = `${shortName(scalarName)} == sum(${shortName(mappingName)})`;
      if (
        scalarShort.includes("deposit") &&
        mappingShort.includes("balance")
      ) {
        relationship = `${shortName(scalarName)} tracks the sum of all ${shortName(mappingName)} entries`;
      } else if (
        scalarShort.includes("stake") &&
        mappingShort.includes("stake")
      ) {
        relationship = `${shortName(scalarName)} is the aggregate of per-user ${shortName(mappingName)}`;
      } else if (
        scalarShort.includes("share") &&
        mappingShort.includes("share")
      ) {
        relationship = `${shortName(scalarName)} equals the sum of all ${shortName(mappingName)} balances`;
      }

      pairs.push({
        aggregate: scalarName,
        individual: mappingName,
        mismatchedUpdates,
        relationship,
      });
    }
  }

  return pairs;
}

/** Pattern 5: Identify interface assumptions that need validation */
function findInterfaceAssumptions(
  s: StructuralAnalysis
): PatternFindings["interfaceAssumptions"] {
  const results: PatternFindings["interfaceAssumptions"] = [];

  // Group external calls by target contract/interface
  const callsByInterface: Record<string, Set<string>> = {};
  for (const [funcName, summary] of Object.entries(s.functionSummary)) {
    for (const call of summary.externalCalls) {
      if (call.startsWith("low_level.")) continue;
      const [iface] = call.split(".");
      if (!callsByInterface[iface]) callsByInterface[iface] = new Set();
      callsByInterface[iface].add(funcName);
    }
  }

  for (const [iface, callers] of Object.entries(callsByInterface)) {
    if (iface === "external") continue;

    const assumptions: string[] = [];

    // Check what functions are called on this interface
    const calledFunctions = new Set<string>();
    for (const caller of callers) {
      const summary = s.functionSummary[caller];
      for (const call of summary.externalCalls) {
        if (call.startsWith(`${iface}.`)) {
          calledFunctions.add(call.split(".")[1]);
        }
      }
    }

    if (calledFunctions.has("transfer") || calledFunctions.has("transferFrom")) {
      assumptions.push("Assumes token transfer sends exact amount (no fee-on-transfer)");
      assumptions.push("Assumes transfer returns true on success (some tokens don't return)");
    }
    if (calledFunctions.has("balanceOf")) {
      assumptions.push("Assumes balanceOf reflects actual holdings (not rebasing token)");
    }
    if (calledFunctions.has("safeTransferFrom")) {
      assumptions.push("Assumes receiver handles onERC721Received callback safely");
    }
    if (calledFunctions.has("approve")) {
      assumptions.push("Assumes approve works for non-zero to non-zero (some tokens require 0 first)");
    }

    if (assumptions.length > 0) {
      results.push({
        interface: iface,
        calledBy: [...callers],
        assumptions,
      });
    }
  }

  return results;
}

/** Pattern 6: Map privilege escalation surface */
function findPrivilegeSurface(
  s: StructuralAnalysis
): PatternFindings["privilegeSurface"] {
  const adminFunctions: string[] = [];
  const unguardedStateMutators: string[] = [];
  const guardedBy: Record<string, string[]> = {};

  for (const [funcName, summary] of Object.entries(s.functionSummary)) {
    if (summary.visibility !== "external" && summary.visibility !== "public") {
      continue;
    }

    const authChecksForFunc = s.authChecks[funcName] || [];
    const hasMsgSenderCheck = authChecksForFunc.some((c) => c.checksMsgSender);

    if (hasMsgSenderCheck) {
      adminFunctions.push(funcName);
      const guards = authChecksForFunc
        .filter((c) => c.checksMsgSender)
        .map((c) => {
          if (c.comparedTo) return `${c.type}: msg.sender == ${c.comparedTo}`;
          return `${c.type}: ${c.name}`;
        });
      guardedBy[funcName] = guards;
    } else if (summary.stateVarsWritten.length > 0) {
      unguardedStateMutators.push(funcName);
    }
  }

  return { adminFunctions, unguardedStateMutators, guardedBy };
}

/** Pattern 7: Trace value flow paths through the contract */
function findValueFlowPaths(s: StructuralAnalysis): ValueFlowPath[] {
  const paths: ValueFlowPath[] = [];

  // Sources: functions that receive value (have token transferFrom or are payable)
  const sources = Object.entries(s.functionSummary).filter(([funcName, f]) => {
    const receivesTokens = f.externalCalls.some((c) => c.includes("transferFrom"));
    const tainted = s.dataDependency.tainted[funcName] || [];
    const receivesEth = tainted.includes("msg.value");
    return receivesTokens || receivesEth;
  });

  // Sinks: functions that send value (have token transfer or low-level call with value)
  const sinks = Object.entries(s.functionSummary).filter(([_, f]) => {
    const sendsTokens = f.externalCalls.some(
      (c) =>
        (c.includes("transfer") && !c.includes("transferFrom")) ||
        c.startsWith("low_level.call") ||
        c.startsWith("low_level.transfer") ||
        c.startsWith("low_level.send")
    );
    return sendsTokens;
  });

  for (const [sourceName, sourceFunc] of sources) {
    for (const [sinkName, sinkFunc] of sinks) {
      // Find shared state variables (value must flow through state)
      const sourceWrites = new Set(sourceFunc.stateVarsWritten);
      const sinkReads = new Set(sinkFunc.stateVarsRead);
      const intermediateState = [...sourceWrites].filter((v) =>
        sinkReads.has(v)
      );

      if (intermediateState.length === 0 && sourceName !== sinkName) continue;

      // Check if source uses balance-before/after pattern
      const checksActualReceived =
        sourceFunc.externalCalls.some((c) => c.includes("balanceOf")) &&
        sourceFunc.externalCalls.some((c) => c.includes("transferFrom"));

      // Check if there's an external call on the path between source and sink
      const hasExternalCallOnPath =
        sourceFunc.externalCalls.length > 0 || sinkFunc.externalCalls.length > 0;

      paths.push({
        source: sourceName,
        sink: sinkName,
        intermediateState,
        checksActualReceived,
        hasExternalCallOnPath,
      });
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// 5. Investigation Questions
// ---------------------------------------------------------------------------

function generateQuestions(
  classification: ContractClassification,
  attackSurface: AttackSurfaceEntry[],
  invariants: InferredInvariant[],
  patterns: PatternFindings
): string[] {
  const questions: string[] = [];

  // CEI violations — highest priority (only unguarded ones)
  for (const v of patterns.ceiViolations) {
    if (!v.hasReentrancyGuard) {
      questions.push(
        `CRITICAL: ${v.function} writes state (${v.stateWritesAfter.join(", ")}) after external call to ${v.externalCall}. No reentrancy guard detected. Can the external call re-enter and exploit the stale state?`
      );
    } else if (v.reentrantPaths.length > 0) {
      questions.push(
        `${v.function} has a CEI violation but has a reentrancy guard. Is the guard applied to ALL reentrant paths? Check: ${v.reentrantPaths.join(", ")}`
      );
    }
  }

  // Inferred invariants — high value, previously unused
  for (const inv of invariants) {
    questions.push(
      `Invariant [${inv.kind}]: ${inv.description}. Assertion: ${inv.assertion}. Threatened by: ${inv.threatenedBy.map(shortName).join(", ")}. Read the code to verify this holds and identify any violation path.`
    );
  }

  // Unguarded state mutators (score >= 40)
  for (const func of patterns.privilegeSurface.unguardedStateMutators) {
    const summary = attackSurface.find((a) => a.function === func);
    if (summary && summary.score >= 40) {
      questions.push(
        `${func} writes state but has no access control. What prevents a malicious caller from abusing this? Factors: ${summary.factors.join(", ")}`
      );
    }
  }

  // Token interface assumptions
  for (const iface of patterns.interfaceAssumptions) {
    for (const assumption of iface.assumptions) {
      questions.push(
        `Interface ${iface.interface} used by ${iface.calledBy.map(shortName).join(", ")}: ${assumption}. Read the code to verify if this assumption is validated.`
      );
    }
  }

  // Value flow integrity
  for (const path of patterns.valueFlowPaths) {
    if (!path.checksActualReceived) {
      questions.push(
        `Value flow ${shortName(path.source)} → ${path.intermediateState.map(shortName).join(" → ")} → ${shortName(path.sink)}: Source does not check actual amount received. Is this vulnerable to fee-on-transfer tokens?`
      );
    }
  }

  // State variable conservation
  for (const pair of patterns.stateVarPairings) {
    if (pair.mismatchedUpdates.length > 0) {
      questions.push(
        `Conservation risk: ${shortName(pair.aggregate)} and ${shortName(pair.individual)} are updated together in some functions but not in: ${pair.mismatchedUpdates.map(shortName).join(", ")}. Can these diverge?`
      );
    }
  }

  // Contract-type-specific
  for (const vuln of classification.knownVulnerabilityClasses.slice(0, 3)) {
    questions.push(
      `Known ${classification.type} vulnerability: "${vuln}". Trace the relevant code path to confirm or rule out.`
    );
  }

  // Deduplicate: group by first 50 chars (catches near-identical questions)
  const seen = new Set<string>();
  const deduped = questions.filter((q) => {
    const key = q.slice(0, 50).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortName(qualified: string): string {
  return qualified.includes(".") ? qualified.split(".").pop()! : qualified;
}

