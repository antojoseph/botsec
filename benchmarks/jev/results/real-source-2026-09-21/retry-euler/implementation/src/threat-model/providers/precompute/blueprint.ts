/**
 * Blueprint PrecomputeProvider — wraps buildBlueprint() from architecture-analyzer.ts.
 *
 * Depends on structural analysis (from the AST provider) being available
 * in ctx.precomputed. If structural data is missing, the provider skips
 * with a warning.
 */

import type {
  PrecomputeProvider,
  PrecomputeContext,
  PrecomputeResult,
} from "../types.js";
import { buildBlueprint } from "../../architecture-analyzer.js";

export const blueprintProvider: PrecomputeProvider = {
  id: "blueprint",
  name: "Architectural Blueprint",
  phase: "precompute",
  flag: "blueprint",
  flagDescription: "Build architectural blueprint from AST structural analysis",
  defaultEnabled: true,

  async run(ctx: PrecomputeContext): Promise<PrecomputeResult> {
    if (!ctx.precomputed.structural) {
      console.log(
        "  Warning: skipping blueprint — structural analysis not available.",
      );
      return {
        outputPaths: [],
        agentPromptSection: "",
        sourceKey: "architecture-blueprint",
      };
    }

    console.log("  Building architectural blueprint...");
    const blueprint = await buildBlueprint(
      ctx.precomputed.structural,
      ctx.precomputed.abi || {},
    );

    const classType = blueprint.classification.type;
    const classConf = blueprint.classification.confidence;
    const funcCount = blueprint.attackSurface.length;
    const invCount = blueprint.inferredInvariants.length;
    const questCount = blueprint.investigationQuestions.length;
    const ceiCount = blueprint.patternFindings.ceiViolations.length;

    console.log(
      `  Blueprint: classified as "${classType}" (${classConf} confidence), ` +
        `${funcCount} functions scored, ` +
        `${invCount} invariants inferred, ` +
        `${questCount} investigation questions`,
    );
    if (ceiCount > 0) {
      console.log(`  CEI violations pre-detected: ${ceiCount}`);
    }

    return {
      outputPaths: [],
      agentPromptSection: "",
      sourceKey: "architecture-blueprint",
      data: { blueprint },
    };
  },
};
