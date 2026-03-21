/**
 * Guardrails — safety checks and human escalation.
 *
 * Checks agent output for:
 *   - Escalation keywords (uncertainty signals)
 *   - Destructive operations
 *   - Chain depth limits
 *   - Confidence scoring via keyword heuristics
 */

import { GuardrailCheck, GuardrailsConfig } from "../types.js";

const DEFAULT_ESCALATION_KEYWORDS = [
  "i'm not sure",
  "i am not sure",
  "uncertain",
  "unclear",
  "cannot determine",
  "need clarification",
  "ambiguous",
  "please confirm",
  "requires human",
  "human review",
  "escalate",
];

const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bdrop table\b/i,
  /\brm -rf\b/i,
  /\boverwrite\b/i,
  /\btruncate\b/i,
  /\bformat\b/i,
];

const CONFIDENCE_POSITIVE = [
  "successfully",
  "completed",
  "verified",
  "confirmed",
  "found",
  "determined",
  "implemented",
];

const CONFIDENCE_NEGATIVE = [
  "failed",
  "error",
  "unable",
  "could not",
  "cannot",
  "issue",
  "problem",
  "bug",
];

export function defaultGuardrails(): GuardrailsConfig {
  return {
    maxChainDepth: 5,
    escalateBelow: 0.4,
    escalationKeywords: DEFAULT_ESCALATION_KEYWORDS,
    allowDestructive: false,
  };
}

export function checkGuardrails(
  output: string,
  config: GuardrailsConfig,
  chainDepth: number
): GuardrailCheck {
  const violations: string[] = [];
  const lower = output.toLowerCase();

  // Chain depth guard
  if (chainDepth >= config.maxChainDepth) {
    violations.push(`Chain depth ${chainDepth} exceeds maximum ${config.maxChainDepth}`);
  }

  // Escalation keyword check
  for (const kw of config.escalationKeywords) {
    if (lower.includes(kw)) {
      violations.push(`Escalation keyword detected: "${kw}"`);
      break;
    }
  }

  // Destructive operation check
  if (!config.allowDestructive) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(output)) {
        violations.push(`Destructive operation detected: ${pattern}`);
        break;
      }
    }
  }

  // Confidence heuristic
  let positiveHits = 0;
  let negativeHits = 0;
  for (const word of CONFIDENCE_POSITIVE) {
    if (lower.includes(word)) positiveHits++;
  }
  for (const word of CONFIDENCE_NEGATIVE) {
    if (lower.includes(word)) negativeHits++;
  }
  const total = positiveHits + negativeHits;
  const confidence = total === 0 ? 0.7 : positiveHits / total;

  if (confidence < config.escalateBelow) {
    violations.push(
      `Low confidence score ${confidence.toFixed(2)} below threshold ${config.escalateBelow}`
    );
  }

  return {
    passed: violations.length === 0,
    violations,
    confidence,
  };
}

export function formatEscalation(check: GuardrailCheck, skillName: string): string {
  return [
    `\n⚠️  GUARDRAIL ESCALATION — ${skillName}`,
    `Confidence: ${(check.confidence * 100).toFixed(0)}%`,
    `Violations:`,
    ...check.violations.map((v) => `  • ${v}`),
    `\nHuman review required before continuing.`,
  ].join("\n");
}
