/**
 * Self-Contradiction SynthesisFilterProvider — downgrades threats whose
 * descriptions contain exonerating language that contradicts the finding.
 *
 * When the agent hedges ("properly handled", "not exploitable") it signals
 * low confidence. This filter detects those patterns and lowers severity
 * and confidence accordingly.
 */

import type { SynthesisFilterProvider } from "../types.js";
import type { Threat, PrecomputedAnalysis } from "../../types.js";

const EXONERATING_PATTERNS: RegExp[] = [
  /properly handled/i,
  /actually safe/i,
  /not exploitable/i,
  /correctly implemented/i,
  /^not a vulnerability/i,
  /false positive/i,
];

const SEVERITY_ORDER: Threat["severity"][] = ["Critical", "High", "Medium", "Low"];

function lowerSeverity(severity: Threat["severity"]): Threat["severity"] {
  const idx = SEVERITY_ORDER.indexOf(severity);
  if (idx < 0 || idx >= SEVERITY_ORDER.length - 1) return SEVERITY_ORDER[SEVERITY_ORDER.length - 1];
  return SEVERITY_ORDER[idx + 1];
}

export const selfContradictionProvider: SynthesisFilterProvider = {
  id: "self-contradiction",
  name: "Self-Contradiction Filter",
  phase: "synthesis-filter",
  flag: "self-contradiction",
  flagDescription: "Downgrade threats that contradict themselves",
  defaultEnabled: true,

  apply(threats: Threat[], _precomputed: PrecomputedAnalysis): Threat[] {
    let downgraded = 0;

    for (const threat of threats) {
      const text = `${threat.description || ""} ${threat.attackScenario || ""}`;
      const matchCount = EXONERATING_PATTERNS.filter((re) =>
        re.test(text),
      ).length;

      const shouldDowngrade =
        matchCount >= 2 || (matchCount >= 1 && text.length < 120);

      if (shouldDowngrade) {
        threat.severity = lowerSeverity(threat.severity);
        threat.confidence = "low";
        downgraded++;
      }
    }

    if (downgraded > 0) {
      console.log(
        `  Self-contradiction: downgraded ${downgraded} threat(s).`,
      );
    }
    return threats;
  },
};
