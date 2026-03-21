/**
 * /issue-report — Issue Report Skill (Phase 5, AI)
 *
 * Terminal skill in the chain: /exp-plan → /exp-submit → /issue-fix → /issue-report
 *
 * Synthesizes all experiment and fix data into a final iteration report
 * ready for human review. Stores institutional memory for the next cycle.
 */

import fs from "fs";
import path from "path";
import { SkillDefinition, SkillContext, SkillResult } from "../types.js";
import { runAgent } from "../agent.js";

export function issueReportSkill(
  agentConfig: Parameters<typeof runAgent>[0]["config"],
  outputDir: string
): SkillDefinition {
  return {
    name: "issue-report",
    command: "/issue-report",
    description: "Generate final iteration report synthesizing experiment and fix data",
    chainTo: [],  // Terminal skill — human reviews
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const memory = ctx.memory.snapshot();
      const prompt = buildReportPrompt(ctx.input, memory);

      const result = await runAgent({
        prompt,
        config: agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      // Update institutional memory with what was learned
      const expId = memory["current_experiment_id"] as string | undefined;
      const iteration = ((memory["iteration_count"] as number | undefined) ?? 0) + 1;

      ctx.memory.set("iteration_count", iteration, "global", ["iteration"]);
      ctx.memory.set(
        `iteration_${iteration}_summary`,
        result.output.slice(0, 1000),
        "global",
        ["history", "summary"]
      );

      // Apply agent-embedded memory updates
      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "global", ["learned"]);
      }

      // Write report to output dir
      fs.mkdirSync(outputDir, { recursive: true });
      const reportFile = path.join(
        outputDir,
        `iteration-report-${expId ?? Date.now()}.md`
      );
      fs.writeFileSync(reportFile, result.output);

      const jsonReportFile = path.join(
        outputDir,
        `iteration-report-${expId ?? Date.now()}.json`
      );
      fs.writeFileSync(
        jsonReportFile,
        JSON.stringify(
          {
            expId,
            iteration,
            timestamp: new Date().toISOString(),
            summary: result.output.slice(0, 500),
            memoryUpdates: result.memoryUpdates,
          },
          null,
          2
        )
      );

      console.log(`\n✓ Report written to ${reportFile}`);

      return {
        success: true,
        output: result.output,
        artifacts: {
          [path.basename(reportFile)]: result.output,
          [path.basename(jsonReportFile)]: fs.readFileSync(jsonReportFile, "utf-8"),
        },
      };
    },
  };
}

function buildReportPrompt(input: string, memory: Record<string, unknown>): string {
  const iterationCount = (memory["iteration_count"] as number | undefined) ?? 0;
  const lastPlan = memory["last_exp_plan"] as string | undefined;
  const lastResults = memory["last_exp_results"] as string | undefined;
  const lastFixes = memory["last_issue_fix"] as string | undefined;
  const pendingFixes = memory["pending_fixes"];

  return `You are generating the final iteration report for a model improvement cycle.

## Current Iteration: ${iterationCount + 1}

## Additional Context
${input || "(none)"}

## Data Available

### Experiment Plan
${lastPlan?.slice(0, 400) ?? "(not found)"}

### Results
${lastResults?.slice(0, 400) ?? "(not found)"}

### Fixes
${lastFixes?.slice(0, 400) ?? "(not found)"}

### Pending Fixes
${JSON.stringify(pendingFixes ?? [], null, 2).slice(0, 200)}

---

## Required Output

### Iteration ${iterationCount + 1} Report

**Date**: ${new Date().toISOString().split("T")[0]}

**Executive Summary**
3-4 sentences covering what was tried, what was learned, and what changed.

### Results vs Hypothesis

| Hypothesis Component | Confirmed? | Evidence |
|---------------------|------------|---------|
(fill in from data)

### Key Learnings

For each learning, state:
- **Learning**: Clear statement of what was learned
- **Confidence**: high/medium/low
- **Impact on next model version**: [description]

### Changes Applied

Table of changes made:
| File | Change | Rationale |
|------|--------|-----------|
(from fixes data)

### Model Quality Delta

| Metric | Before | After | Change |
|--------|--------|-------|--------|
(fill from results)

### Open Issues

Issues still unresolved with priority.

### Next Iteration Plan

Based on what was learned, what should the next experiment focus on?
  - **Hypothesis for next iteration**:
  - **Key change to try**:
  - **Risk to watch**:

### Institutional Memory Updates

List what should be remembered for all future iterations:
  - conventions learned
  - patterns that work/don't work
  - model-specific behaviors observed

---
Embed memories: <!-- MEMORY: key=value -->`;
}
