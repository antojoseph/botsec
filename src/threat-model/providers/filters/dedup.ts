/**
 * Deduplication SynthesisFilterProvider — merges threats with significantly
 * overlapping affected code locations using Jaccard similarity.
 *
 * When two threats share >50% of their affectedCode entries, they are
 * merged: the higher-severity threat survives, descriptions are concatenated,
 * and suggestedProperties are combined.
 */

import type { SynthesisFilterProvider } from "../types.js";
import type { Threat, PrecomputedAnalysis } from "../../types.js";

const OVERLAP_THRESHOLD = 0.5;

const SEVERITY_RANK: Record<Threat["severity"], number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

function jaccardOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const dedupProvider: SynthesisFilterProvider = {
  id: "dedup",
  name: "Deduplication",
  phase: "synthesis-filter",
  flag: "dedup",
  flagDescription: "Merge threats with overlapping affected code",
  defaultEnabled: true,

  apply(threats: Threat[], _precomputed: PrecomputedAnalysis): Threat[] {
    const merged = new Set<number>();
    let mergeCount = 0;

    for (let i = 0; i < threats.length; i++) {
      if (merged.has(i)) continue;
      for (let j = i + 1; j < threats.length; j++) {
        if (merged.has(j)) continue;

        const overlap = jaccardOverlap(
          threats[i].affectedCode,
          threats[j].affectedCode,
        );

        if (
          overlap > OVERLAP_THRESHOLD &&
          threats[i].category === threats[j].category
        ) {
          // Keep the higher-severity threat, merge data from the other
          const keepIdx =
            SEVERITY_RANK[threats[i].severity] >=
            SEVERITY_RANK[threats[j].severity]
              ? i
              : j;
          const dropIdx = keepIdx === i ? j : i;

          const keep = threats[keepIdx];
          const drop = threats[dropIdx];

          // A citation check for one report does not cover a combined claim.
          // Preserve each original assessment and make that limitation visible.
          if (keep.claimReview || drop.claimReview || keep.claimAssessment || drop.claimAssessment || keep.mergedClaims || drop.mergedClaims) {
            const originals = (t: Threat) => t.mergedClaims ?? [{ findingId: t.id, assessment: t.claimAssessment, review: t.claimReview }];
            keep.mergedClaims = [...originals(keep), ...originals(drop)];
            delete keep.claimAssessment;
            keep.claimReview = {
              status: "needs-review", executionVerified: false, sourceReferences: [],
              issues: ["Combined report requires review; original claim assessments are preserved in mergedClaims"],
            };
          }

          // Merge descriptions
          keep.description = `${keep.description}\n\n[Merged] ${drop.description}`;

          // Merge suggestedProperties (deduplicated)
          const propSet = new Set([
            ...keep.suggestedProperties,
            ...drop.suggestedProperties,
          ]);
          keep.suggestedProperties = [...propSet];

          // Merge affectedCode (deduplicated)
          const codeSet = new Set([
            ...keep.affectedCode,
            ...drop.affectedCode,
          ]);
          keep.affectedCode = [...codeSet];

          merged.add(dropIdx);
          mergeCount++;

          // If the current outer threat was dropped, stop comparing it against
          // later threats — its content is already merged into the keeper.
          if (dropIdx === i) break;
        }
      }
    }

    const result = threats.filter((_, idx) => !merged.has(idx));

    if (mergeCount > 0) {
      console.log(
        `  Dedup: merged ${mergeCount} threat(s) with overlapping code.`,
      );
    }
    return result;
  },
};
