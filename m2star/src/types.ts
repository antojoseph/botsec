/**
 * Core type definitions for the M2* Model Iteration System.
 */

// ─── Skill System ─────────────────────────────────────────────────────────────

export interface SkillDefinition {
  name: string;           // e.g. "exp-plan"
  command: string;        // e.g. "/exp-plan"
  description: string;
  /** Skills this one auto-chains to on success */
  chainTo?: string[];
  /** Human checkpoint required before executing */
  requiresHumanApproval?: boolean;
  handler: (ctx: SkillContext) => Promise<SkillResult>;
}

export interface SkillContext {
  input: string;
  memory: MemoryStore;
  guardrails: GuardrailsConfig;
  workdir: string;
  /** Resolved chain depth (prevents infinite loops) */
  chainDepth: number;
  /** Parent skill that triggered this one, if any */
  calledBy?: string;
}

export interface SkillResult {
  success: boolean;
  output: string;
  artifacts?: Record<string, string>;  // filename → content
  /** Next skill to chain to (overrides chainTo if set) */
  nextSkill?: string;
  /** Whether a human checkpoint was raised */
  escalated?: boolean;
  escalationReason?: string;
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export type MemoryTier = "session" | "project" | "global";

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  key: string;
  value: unknown;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Times this entry was read/referenced */
  accessCount: number;
}

export interface MemoryStore {
  get(key: string, tier?: MemoryTier): unknown;
  set(key: string, value: unknown, tier?: MemoryTier, tags?: string[]): void;
  search(query: string, tier?: MemoryTier): MemoryEntry[];
  list(tier?: MemoryTier): MemoryEntry[];
  snapshot(): Record<string, unknown>;
}

// ─── Guardrails ───────────────────────────────────────────────────────────────

export interface GuardrailsConfig {
  /** Max chain depth before forcing human review */
  maxChainDepth: number;
  /** Confidence threshold below which agent escalates */
  escalateBelow: number;
  /** Patterns in output that trigger escalation */
  escalationKeywords: string[];
  /** Whether to allow destructive operations (delete, overwrite) */
  allowDestructive: boolean;
}

export interface GuardrailCheck {
  passed: boolean;
  violations: string[];
  confidence: number;
}

// ─── Evaluation ───────────────────────────────────────────────────────────────

export interface EvalMetric {
  name: string;
  value: number;
  unit: string;
  threshold?: number;
  passed?: boolean;
}

export interface EvalReport {
  skillName: string;
  runId: string;
  timestamp: string;
  metrics: EvalMetric[];
  overallScore: number;
  passed: boolean;
  notes: string;
}

// ─── Experiment Workflow ──────────────────────────────────────────────────────

export type ExperimentPhase =
  | "plan"
  | "dev_run"
  | "analyze_report"
  | "review_discuss"
  | "iterate";

export interface Experiment {
  id: string;
  name: string;
  description: string;
  hypothesis: string;
  phase: ExperimentPhase;
  createdAt: string;
  updatedAt: string;
  iterations: number;
  results?: ExperimentResults;
  issues: ExperimentIssue[];
  artifacts: Record<string, string>;
}

export interface ExperimentResults {
  metrics: EvalMetric[];
  logs: string;
  summary: string;
  modelImprovement?: string;
  nextSteps: string[];
}

export interface ExperimentIssue {
  id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved";
  fix?: string;
  createdAt: string;
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  model: "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";
  maxTurns: number;
  systemPrompt: string;
  tools: string[];
}

export interface HarnessConfig {
  guardrails: GuardrailsConfig;
  memoryDir: string;
  outputDir: string;
  agent: AgentConfig;
}
