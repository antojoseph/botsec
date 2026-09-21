/**
 * Ranking SynthesisFilterProvider — scores and sorts threats by severity,
 * confidence, on-chain activity, and historical evidence.
 *
 * Lower priority numbers = higher importance. The formula:
 *   priority = round(100 / (sevWeight * confWeight * onChainBoost * histBoost))
 *
 * Threats are sorted ascending by priority and re-numbered sequentially.
 */

import type { SynthesisFilterProvider } from "../types.js";
import type { Threat, PrecomputedAnalysis } from "../../types.js";

const SEVERITY_WEIGHTS: Record<Threat["severity"], number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

const CONFIDENCE_WEIGHTS: Record<Threat["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function getOnChainBoost(
  threat: Threat,
  precomputed: PrecomputedAnalysis,
): number {
  if (!precomputed.onChain) return 1.0;

  const freq = precomputed.onChain.functionCallFrequency;
  for (const code of threat.affectedCode) {
    // affectedCode entries are "file:function:line" — extract function name
    const parts = code.split(":");
    const funcName = parts.length >= 2 ? parts[1] : parts[0];
    for (const [key, count] of Object.entries(freq)) {
      if (key.includes(funcName)) {
        if (count > 100) return 2.0;
        if (count > 10) return 1.5;
      }
    }
  }
  return 1.0;
}

function getHistoricalBoost(threat: Threat): number {
  return threat.historicalEvidence ? 1.3 : 1.0;
}

export const rankingProvider: SynthesisFilterProvider = {
  id: "ranking",
  name: "Threat Ranking",
  phase: "synthesis-filter",
  flag: "ranking",
  flagDescription:
    "Score and sort threats by severity, confidence, and on-chain activity",
  defaultEnabled: true,

  apply(threats: Threat[], precomputed: PrecomputedAnalysis): Threat[] {
    for (const threat of threats) {
      const sevWeight = SEVERITY_WEIGHTS[threat.severity] || 1;
      const confWeight = CONFIDENCE_WEIGHTS[threat.confidence] || 1;
      const onChainBoost = getOnChainBoost(threat, precomputed);
      const histBoost = getHistoricalBoost(threat);

      threat.priority = Math.round(
        100 / (sevWeight * confWeight * onChainBoost * histBoost),
      );
    }

    threats.sort((a, b) => a.priority - b.priority);

    // Re-number sequentially (1-based)
    for (let i = 0; i < threats.length; i++) {
      threats[i].priority = i + 1;
    }

    return threats;
  },
};
