/**
 * Anti-Slop SynthesisFilterProvider — drops threats that lack code traces.
 *
 * Every threat must have a non-empty trace.steps array to survive this filter.
 * This is the primary quality gate ensuring the agent backed each finding
 * with concrete evidence from the codebase.
 */

import type { SynthesisFilterProvider } from "../types.js";
import type { Threat, PrecomputedAnalysis } from "../../types.js";

export const antiSlopProvider: SynthesisFilterProvider = {
  id: "anti-slop",
  name: "Anti-Slop Filter",
  phase: "synthesis-filter",
  flag: "anti-slop",
  flagDescription: "Drop threats with empty code traces",
  defaultEnabled: true,

  apply(threats: Threat[], _precomputed: PrecomputedAnalysis): Threat[] {
    const before = threats.length;
    const filtered = threats.filter(
      (t) => t.trace?.steps?.length > 0,
    );
    const dropped = before - filtered.length;
    if (dropped > 0) {
      console.log(`  Anti-slop: dropped ${dropped} threat(s) with empty traces.`);
    }
    return filtered;
  },
};
