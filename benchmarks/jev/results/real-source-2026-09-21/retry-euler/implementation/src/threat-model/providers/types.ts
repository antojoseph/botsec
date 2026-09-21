/**
 * Provider interfaces for the pluggable threat model pipeline.
 *
 * Five provider types correspond to pipeline phases:
 * - PrecomputeProvider:       Phase 0 — run analysis tools, write to .forge-proof/
 * - AgentPassProvider:        Phase 1 — additional agent definitions for focused passes
 * - EnrichmentProvider:       Phase 2 — annotate threats with external evidence
 * - SynthesisFilterProvider:  Phase 2 — custom post-processing on threat array
 * - OutputFormatProvider:     Phase 2 — alternative output formats (SARIF, etc.)
 *
 * To add a new provider: implement the interface, register in registry.ts.
 * The CLI flag auto-appears from the ProviderMeta declaration.
 */

import type {
  PrecomputedAnalysis,
  Threat,
  ThreatCategory,
  ThreatModel,
  ContractType,
} from "../types.js";
import type { AgentDefinition } from "../../agents/explorer.js";

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

export interface ExtraFlag {
  /** Full flag string, e.g. "--slither-path <path>" */
  readonly flag: string;
  readonly description: string;
  readonly defaultValue?: string;
}

/** Shared metadata — every provider self-declares its CLI flag. */
export interface ProviderMeta {
  /** Unique identifier, e.g. "slither", "solodit" */
  readonly id: string;
  /** Human-readable name for console output */
  readonly name: string;
  /** CLI flag name WITHOUT dashes — "slither" becomes --slither */
  readonly flag: string;
  /** Description shown in --help */
  readonly flagDescription: string;
  /** Additional CLI options this provider needs */
  readonly extraFlags?: ExtraFlag[];
  /**
   * If true, provider runs by default and can be disabled with --no-{flag}.
   * If false/undefined, provider is opt-in and enabled with --{flag}.
   */
  readonly defaultEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Phase 0: Pre-compute Providers
// ---------------------------------------------------------------------------

export interface PrecomputeContext {
  /** Foundry project root */
  projectDir: string;
  /** .forge-proof/ directory (already created) */
  forgeProofDir: string;
  /** Already-computed core analysis (structural, blueprint, etc.) */
  precomputed: PrecomputedAnalysis;
  /** CLI flag values for this provider's extraFlags */
  flagValues: Record<string, string | boolean>;
}

export interface PrecomputeResult {
  /** Path(s) written, for logging */
  outputPaths: string[];
  /** Prompt section appended to the agent's data instructions */
  agentPromptSection: string;
  /** Key added to metadata.sourcesQueried */
  sourceKey: string;
  /** Structured data merged into PrecomputedAnalysis (e.g., structural, blueprint, abi) */
  data?: Partial<PrecomputedAnalysis>;
}

/**
 * Runs an analysis tool during Phase 0 and writes results to .forge-proof/
 * for the agent to read.
 */
export interface PrecomputeProvider extends ProviderMeta {
  readonly phase: "precompute";
  run(ctx: PrecomputeContext): Promise<PrecomputeResult>;
}

// ---------------------------------------------------------------------------
// Phase 1: Agent Pass Providers
// ---------------------------------------------------------------------------

export interface AgentPassContext {
  precomputed: PrecomputedAnalysis;
  blueprintPath?: string;
  codemapPath?: string;
  flagValues: Record<string, string | boolean>;
}

export interface AgentPassResult {
  /** Agent name (used as key in the agents map) */
  agentName: string;
  /** The agent definition */
  agent: AgentDefinition;
  /** Delegation prompt for the orchestrator */
  delegationPrompt: string;
}

/**
 * Provides an additional agent definition that runs during Phase 1
 * for specialized analysis passes (reentrancy-focused, oracle-focused, etc.)
 */
export interface AgentPassProvider extends ProviderMeta {
  readonly phase: "agent-pass";
  buildAgent(ctx: AgentPassContext): AgentPassResult;
}

// ---------------------------------------------------------------------------
// Phase 2: Enrichment Providers
// ---------------------------------------------------------------------------

export interface EnrichmentContext {
  /** Threats to enrich — mutate in-place (attach historicalEvidence, etc.) */
  threats: Threat[];
  contractType: ContractType;
  categories: ThreatCategory[];
  precomputed: PrecomputedAnalysis;
  flagValues: Record<string, string | boolean>;
}

export interface EnrichmentResult {
  /** How many findings were attached */
  findingsAttached: number;
  /** Key added to metadata.sourcesQueried */
  sourceKey: string;
}

/**
 * Enriches threats with external data after the agent has produced them.
 * Solodit is the reference implementation.
 */
export interface EnrichmentProvider extends ProviderMeta {
  readonly phase: "enrichment";
  enrich(ctx: EnrichmentContext): Promise<EnrichmentResult>;
}

// ---------------------------------------------------------------------------
// Phase 2: Synthesis Filter Providers
// ---------------------------------------------------------------------------

/**
 * A filter that runs during synthesis. Can remove, merge, or modify threats.
 * Runs AFTER built-in quality gates (anti-slop, self-contradiction).
 */
export interface SynthesisFilterProvider extends ProviderMeta {
  readonly phase: "synthesis-filter";
  apply(threats: Threat[], precomputed: PrecomputedAnalysis): Threat[];
}

// ---------------------------------------------------------------------------
// Phase 2: Output Format Providers
// ---------------------------------------------------------------------------

export interface OutputContext {
  threatModel: ThreatModel;
  runDir: string;
  flagValues: Record<string, string | boolean>;
}

/**
 * Produces output in an alternative format (e.g., SARIF, HTML).
 * Runs after synthesis, alongside the default JSON output.
 */
export interface OutputFormatProvider extends ProviderMeta {
  readonly phase: "output";
  write(ctx: OutputContext): string;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type Provider =
  | PrecomputeProvider
  | AgentPassProvider
  | EnrichmentProvider
  | SynthesisFilterProvider
  | OutputFormatProvider;
