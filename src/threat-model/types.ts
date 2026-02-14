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
  /** Tool / source: "Grep" | "Read" | "Slither" | "forge-inspect" | "Etherscan" */
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

  /** Enrichment from Solodit (added in synthesis phase) */
  historicalEvidence?: {
    source: "solodit";
    references: HistoricalReference[];
  };
  /** Etherscan v2 data supporting this threat */
  onChainEvidence?: string;

  /** Halmos check_ properties to verify this threat */
  suggestedProperties: string[];
  /** Step-by-step exploit using traced code paths */
  attackScenario?: string;
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
  onChainProfile?: OnChainProfile;
  precomputed: {
    slitherAvailable: boolean;
    detectorsRun: number;
    detectorFindings: number;
    etherscanDataAvailable: boolean;
  };
  metadata: {
    sourcesQueried: string[];
    soloditFindings: number;
  };
}

// ---------------------------------------------------------------------------
// Slither structured output types
// ---------------------------------------------------------------------------

export interface SlitherDetector {
  check: string;
  impact: string;
  confidence: string;
  description: string;
  elements: Array<{
    type: string;
    name: string;
    source_mapping?: {
      filename_relative: string;
      lines: number[];
    };
  }>;
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

export interface SlitherAnalysis {
  detectors: SlitherDetector[];
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

  /** Available if slither is installed */
  slither?: SlitherAnalysis;

  /** Available if --address provided (Etherscan v2) */
  onChain?: OnChainProfile;
}
