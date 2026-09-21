/**
 * Threat Model types — the structured output of the threat-model command
 * and the contract between threat-model and analyze.
 */

export type ContractType =
  | "vault"
  | "dex"
  | "lending"
  | "token"
  | "governance"
  | "bridge"
  | "staking"
  | "nft"
  | "oracle"
  | "proxy"
  | "other";

export type ThreatCategory =
  | "access-control"
  | "reentrancy"
  | "oracle-manipulation"
  | "flash-loan"
  | "arithmetic"
  | "denial-of-service"
  | "front-running"
  | "token-handling"
  | "upgradeability"
  | "cross-contract"
  | "governance"
  | "randomness"
  | "unchecked-calls"
  | "logic-error";

export interface Actor {
  name: string;
  type: "user" | "admin" | "contract" | "attacker";
  capabilities: string[];
}

export interface Asset {
  name: string;
  type: "funds" | "tokens" | "access" | "state";
  /** contract:stateVariable */
  location: string;
}

export interface TrustBoundary {
  name: string;
  description: string;
  /** file:function locations that cross this boundary */
  crossedBy: string[];
}

// ---------------------------------------------------------------------------
// CodeTrace — the anti-slop mechanism. Every threat must show how it was found.
// ---------------------------------------------------------------------------

export interface TraceStep {
  /** Tool / source: "Grep" | "Read" | "AST" | "forge-inspect" | "Etherscan" */
  action: string;
  /** What was searched / read */
  target: string;
  /** What was discovered at this step */
  finding: string;
}

export interface CeiTimeline {
  function: string;
  /** State vars read before the external call */
  stateReads: string[];
  /** The external call site (file:line) */
  externalCall: string;
  /** State vars written after the external call */
  stateWritesAfter: string[];
}

export interface DataFlow {
  /** Where value enters (e.g. "deposit(uint256)") */
  source: string;
  /** Where value exits (e.g. "withdraw(uint256)") */
  sink: string;
  /** State vars value passes through */
  intermediateState: string[];
  /** Real tx volume through this path (from Etherscan v2) */
  onChainVolume?: string;
}

export interface CodeTrace {
  steps: TraceStep[];
  /** For reentrancy / state-ordering threats */
  ceiTimeline?: CeiTimeline;
  /** For value-flow threats (enriched by Etherscan v2) */
  dataFlow?: DataFlow;
}

// ---------------------------------------------------------------------------
// Threat — a single identified threat backed by a code trace
// ---------------------------------------------------------------------------

export interface HistoricalReference {
  title: string;
  url?: string;
  similarity: string;
}

export interface SourceCitation {
  id: string;
  /** Workspace-relative Solidity path; distinct compilation units retain their paths. */
  path: string;
  startLine: number;
  endLine: number;
  quote: string;
}

/** The generator's reasoning, not an independently verified security verdict. */
export interface ClaimAssessment {
  conclusion: "supported" | "unresolved" | "contradicted";
  executionContext: string;
  sourceReferences: SourceCitation[];
  steps: Array<{ action: string; expectedResult: string; citationIds: string[] }>;
  checks: Array<{
    kind: "reachability" | "guards-and-rollback" | "callback-state" | "profit-and-loss";
    result: "supported" | "unresolved" | "blocked" | "not-applicable";
    reason: string;
    citationIds: string[];
  }>;
  missingEvidence: string[];
}

/** Mechanical citation checks cannot establish the truth of an attack claim. */
export interface ClaimReview {
  status: "citations-checked" | "needs-review" | "not-assessed";
  executionVerified: false;
  issues: string[];
  sourceReferences: Array<{ id: string; path: string; quoteMatches: boolean; fileSha256?: string }>;
}

export interface Threat {
  id: string;
  category: ThreatCategory;
  title: string;
  description: string;
  /** file:function:line locations */
  affectedCode: string[];
  assets: string[];
  severity: "Critical" | "High" | "Medium" | "Low";
  confidence: "high" | "medium" | "low";

  /** REQUIRED — the code trace that discovered this threat */
  trace: CodeTrace;

  /** Enrichment from external sources (added in synthesis phase by providers) */
  historicalEvidence?: {
    source: string;
    references: HistoricalReference[];
  };
  /** Etherscan v2 data supporting this threat */
  onChainEvidence?: string;

  /** Halmos check_ properties to verify this threat */
  suggestedProperties: string[];
  /** Step-by-step exploit using traced code paths */
  attackScenario?: string;
  claimAssessment?: ClaimAssessment;
  claimReview?: ClaimReview;
  mergedClaims?: Array<{ findingId: string; assessment?: ClaimAssessment; review?: ClaimReview }>;
  /** 1 = highest priority */
  priority: number;
}

// ---------------------------------------------------------------------------
// OnChainProfile — built from Etherscan v2 transaction data
// ---------------------------------------------------------------------------

export interface InternalTransfer {
  from: string;
  to: string;
  /** wei */
  value: string;
}

export interface ValueFlow {
  txHash: string;
  functionName: string;
  /** wei */
  value: string;
  internalTransfers: InternalTransfer[];
}

export interface OnChainProfile {
  address: string;
  chainId: number;
  /** functionName → call count */
  functionCallFrequency: Record<string, number>;
  topCallers: Array<{
    address: string;
    callCount: number;
    isContract: boolean;
  }>;
  valueFlows: ValueFlow[];
  failedTxPatterns: Array<{
    functionName: string;
    count: number;
    commonRevert?: string;
  }>;
  adminActions: Array<{
    functionName: string;
    caller: string;
    timestamp: number;
  }>;
  /** functionName → { min, max, median } parameter values */
  parameterRanges: Record<
    string,
    { min: string; max: string; median: string }
  >;
}

// ---------------------------------------------------------------------------
// ThreatModel — the top-level output document
// ---------------------------------------------------------------------------

export interface ThreatModel {
  version: "1.0";
  target: string;
  contractType: ContractType;
  timestamp: string;
  actors: Actor[];
  assets: Asset[];
  trustBoundaries: TrustBoundary[];
  threats: Threat[];
  /** Preserve rejected leads so a smaller report does not hide what was investigated. */
  dismissedCandidates?: Array<{ title: string; reason: string; sourceReferences: SourceCitation[] }>;
  onChainProfile?: OnChainProfile;
  precomputed: {
    astAnalysisAvailable: boolean;
    blueprintAvailable?: boolean;
    functionsAnalyzed: number;
    stateVarsTracked: number;
    invariantsInferred?: number;
    ceiViolationsDetected?: number;
    etherscanDataAvailable: boolean;
  };
  metadata: {
    sourcesQueried: string[];
    soloditFindings: number;
  };
}

export interface OperationStep {
  /** Index in execution order (0-based) */
  index: number;
  type:
    | "state-read"
    | "state-write"
    | "external-call"
    | "internal-call"
    | "branch"
    | "revert";
  /** What was accessed/called */
  target: string;
  /** Source location from the AST src field */
  src?: string;
}

export interface AuthCheck {
  type: "modifier" | "require" | "if-revert";
  /** The modifier or condition name */
  name: string;
  /** Whether msg.sender is checked */
  checksMsgSender: boolean;
  /** What msg.sender is compared against (if detectable) */
  comparedTo?: string;
}

export interface Guard {
  type: "require" | "assert" | "custom-error" | "revert";
  /** Error name or message */
  name?: string;
  /** Whether the condition involves msg.sender */
  checksMsgSender: boolean;
  /** Brief description of the condition */
  condition?: string;
}

/**
 * Structural analysis extracted from the solc AST (via forge build --build-info).
 * Provides call graphs, state var maps, inheritance, function summaries,
 * operation ordering (CEI), auth checks, guards, and data dependency.
 */
export interface StructuralAnalysis {
  callGraph: Record<string, string[]>;
  stateVarMap: Record<
    string,
    {
      readBy: string[];
      writtenBy: string[];
      type: string;
      visibility: string;
    }
  >;
  inheritance: Record<string, string[]>;
  functionSummary: Record<
    string,
    {
      visibility: string;
      modifiers: string[];
      stateVarsRead: string[];
      stateVarsWritten: string[];
      externalCalls: string[];
      internalCalls: string[];
    }
  >;
  /** Per-function ordered operation list for CEI analysis */
  operationOrder: Record<string, OperationStep[]>;
  /** Per-function msg.sender auth conditions */
  authChecks: Record<string, AuthCheck[]>;
  /** Per-function require/assert/revert inventory */
  guardInventory: Record<string, Guard[]>;
  /**
   * Data-dependency map: variable → variables it depends on (transitive).
   * Two scopes: per-function and per-contract.
   * Taint sources (msg.sender, msg.value, function params) are tracked.
   */
  dataDependency: DataDependencyMap;
}

export interface DataDependencyMap {
  /** Per-function: variable → [variables it depends on] */
  byFunction: Record<string, Record<string, string[]>>;
  /** Per-contract: variable → [variables it depends on] (cross-function, transitive) */
  byContract: Record<string, Record<string, string[]>>;
  /** Variables tainted by external input (msg.sender, msg.value, function params) */
  tainted: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// ArchitecturalBlueprint — semantic layer above raw structural analysis
// ---------------------------------------------------------------------------

/** Classification of a contract's architectural pattern with confidence */
export interface ContractClassification {
  /** Primary pattern detected */
  type: ContractType;
  /** Detection confidence: how many signals matched */
  confidence: "high" | "medium" | "low";
  /** Signals that led to this classification */
  signals: string[];
  /** Known vulnerability classes for this contract type */
  knownVulnerabilityClasses: string[];
}

/** A function scored by its attack surface exposure */
export interface AttackSurfaceEntry {
  /** Qualified function name: Contract.function */
  function: string;
  /** Numeric score (higher = more exposed). Range: 0-100 */
  score: number;
  /** Factors that contribute to the score */
  factors: string[];
  /** Whether this function can receive ETH */
  receivesValue: boolean;
  /** Whether this function makes external calls */
  makesExternalCalls: boolean;
  /** Whether this function lacks access control */
  unguarded: boolean;
}

/** An invariant inferred from code structure */
export interface InferredInvariant {
  /** Human-readable description */
  description: string;
  /** Category of invariant */
  kind: "solvency" | "conservation" | "monotonicity" | "access" | "state-machine" | "no-profit";
  /** State variables involved */
  stateVars: string[];
  /** Functions that could violate this invariant */
  threatenedBy: string[];
  /** Informal Solidity-like assertion */
  assertion: string;
  /** Confidence that this invariant should hold */
  confidence: "high" | "medium" | "low";
}

/** A CEI violation detected by operation ordering analysis */
export interface CeiViolation {
  /** Function where the violation occurs */
  function: string;
  /** The external call that creates the window */
  externalCall: string;
  /** State variables written after the external call */
  stateWritesAfter: string[];
  /** Whether there's a reentrancy guard (modifier) present */
  hasReentrancyGuard: boolean;
  /** Functions reachable from the external call that touch the same state */
  reentrantPaths: string[];
}

/** A pair of state variables that should track each other */
export interface StateVarPairing {
  /** The "aggregate" variable (e.g., totalDeposits) */
  aggregate: string;
  /** The "individual" variable (e.g., balances mapping) */
  individual: string;
  /** Functions that update aggregate but not individual, or vice versa */
  mismatchedUpdates: string[];
  /** Inferred relationship */
  relationship: string;
}

/** A value flow path from entry to exit */
export interface ValueFlowPath {
  /** Entry point function */
  source: string;
  /** Exit point function */
  sink: string;
  /** State variables value passes through */
  intermediateState: string[];
  /** Whether the path uses balance-before/after pattern */
  checksActualReceived: boolean;
  /** Whether external calls on this path could divert value */
  hasExternalCallOnPath: boolean;
}

/** Pre-computed findings organized by cross-reference pattern */
export interface PatternFindings {
  /** Pattern 1: External calls with trust boundary analysis */
  externalCallReceivers: Array<{
    function: string;
    call: string;
    receiverType: "immutable" | "state-var" | "msg-sender" | "parameter" | "unknown";
    callbackRisk: "high" | "medium" | "low" | "none";
  }>;
  /** Pattern 2: CEI violations pre-detected */
  ceiViolations: CeiViolation[];
  /** Pattern 3: State variable conservation pairings */
  stateVarPairings: StateVarPairing[];
  /** Pattern 5: Interface assumptions that need validation */
  interfaceAssumptions: Array<{
    interface: string;
    calledBy: string[];
    assumptions: string[];
  }>;
  /** Pattern 6: Privilege escalation surface */
  privilegeSurface: {
    adminFunctions: string[];
    unguardedStateMutators: string[];
    guardedBy: Record<string, string[]>;
  };
  /** Pattern 7: Value flow paths */
  valueFlowPaths: ValueFlowPath[];
}

/**
 * ArchitecturalBlueprint — a semantic layer built on top of StructuralAnalysis.
 *
 * Where StructuralAnalysis answers "what does the code structurally do?",
 * the blueprint answers "what does this contract *mean*, what should hold true,
 * and where should the agent look first?"
 */
export interface ArchitecturalBlueprint {
  /** What kind of contract this is and why we think so */
  classification: ContractClassification;
  /** Functions ranked by attack surface exposure */
  attackSurface: AttackSurfaceEntry[];
  /** Invariants inferred from code patterns */
  inferredInvariants: InferredInvariant[];
  /** Pre-computed findings organized by the 7 cross-reference patterns */
  patternFindings: PatternFindings;
  /** Top-level questions the agent should investigate, ordered by priority */
  investigationQuestions: string[];
}

// ---------------------------------------------------------------------------
// PrecomputedAnalysis — everything gathered before the agent runs
// ---------------------------------------------------------------------------

export interface PrecomputedAnalysis {
  /** The user's Foundry project root */
  projectDir: string;

  /** contract name → ABI entries (always available) */
  abi: Record<string, any[]>;
  /** contract name → storage slot layout */
  storageLayout: Record<string, any>;
  /** contract name → { selector → signature } */
  methodIds: Record<string, Record<string, string>>;

  /** Structural analysis from solc AST (always available after forge build) */
  structural?: StructuralAnalysis;

  /** Semantic blueprint built on top of structural analysis */
  blueprint?: ArchitecturalBlueprint;

  /** Available if --address provided (Etherscan v2) */
  onChain?: OnChainProfile;
}
