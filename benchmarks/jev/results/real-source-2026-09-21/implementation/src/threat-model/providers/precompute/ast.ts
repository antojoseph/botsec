/**
 * AST PrecomputeProvider — wraps analyzeFromAST() from ast-analysis.ts.
 *
 * Runs solc AST extraction and returns structural analysis data.
 * Does NOT write code map files (the orchestrator handles that since
 * it needs to split by contract).
 */

import type {
  PrecomputeProvider,
  PrecomputeContext,
  PrecomputeResult,
} from "../types.js";
import { analyzeFromAST } from "../../ast-analysis.js";

export const astProvider: PrecomputeProvider = {
  id: "ast",
  name: "AST Analysis",
  phase: "precompute",
  flag: "ast",
  flagDescription: "Run solc AST structural analysis",
  defaultEnabled: true,

  async run(ctx: PrecomputeContext): Promise<PrecomputeResult> {
    console.log("  Analyzing solc AST from build artifacts...");
    const structural = analyzeFromAST(ctx.projectDir);

    if (structural) {
      const funcCount = Object.keys(structural.functionSummary).length;
      const callGraphCount = Object.keys(structural.callGraph).length;
      const stateVarCount = Object.keys(structural.stateVarMap).length;
      const inheritanceCount = Object.keys(structural.inheritance).length;
      console.log(
        `  AST analysis: ${funcCount} functions, ` +
          `${callGraphCount} call graph entries, ` +
          `${stateVarCount} state variables, ` +
          `${inheritanceCount} inheritance relations`,
      );
    } else {
      console.log("  Warning: AST analysis produced no results.");
    }

    return {
      outputPaths: [],
      agentPromptSection: "",
      sourceKey: "solc-ast",
      data: { structural: structural ?? undefined },
    };
  },
};
