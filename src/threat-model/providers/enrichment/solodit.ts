/**
 * Solodit enrichment provider — wraps the existing searchSolodit() module
 * as a pluggable EnrichmentProvider.
 */

import type {
  EnrichmentProvider,
  EnrichmentContext,
  EnrichmentResult,
} from "../types.js";
import { searchSolodit } from "../../solodit.js";
import type { ContractType } from "../../types.js";

export const soloditProvider: EnrichmentProvider = {
  id: "solodit",
  name: "Solodit",
  phase: "enrichment",
  flag: "solodit",
  flagDescription: "Enable Solodit historical vulnerability enrichment",
  extraFlags: [
    {
      flag: "--solodit-key <key>",
      description: "Solodit API key (or set SOLODIT_API_KEY env var)",
    },
  ],

  async enrich(ctx: EnrichmentContext): Promise<EnrichmentResult> {
    console.log("  Querying Solodit for historical findings...");
    let count = 0;

    try {
      const soloditKey =
        (ctx.flagValues["solodit-key"] as string | undefined) ||
        process.env.SOLODIT_API_KEY;
      const classifiedType = (ctx.precomputed.blueprint?.classification.type ||
        "other") as ContractType;

      const results = await searchSolodit(
        classifiedType,
        ctx.categories,
        soloditKey,
      );

      for (const threat of ctx.threats) {
        const findings = results.get(threat.category);
        if (findings && findings.length > 0) {
          threat.historicalEvidence = {
            source: "solodit",
            references: findings.map((f) => ({
              title: f.title,
              url: f.url,
              similarity: `Matches threat category: ${threat.category}`,
            })),
          };
          count += findings.length;
        }
      }
      console.log(`  Solodit: ${count} relevant findings attached.`);
    } catch {
      console.log("  Solodit: query failed, continuing without enrichment.");
    }

    return { findingsAttached: count, sourceKey: "solodit" };
  },
};
