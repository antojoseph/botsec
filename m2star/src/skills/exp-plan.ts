/**
 * /exp-plan — Experiment Planning Skill (Phase 1, Human + AI)
 *
 * Given a research goal, produces a structured experiment plan:
 *   - Hypothesis
 *   - Metrics to track
 *   - Code changes required
 *   - Expected outcomes
 *   - Success criteria
 */

import fs from "fs";
import path from "path";
import { SkillDefinition, SkillContext, SkillResult } from "../types.js";
import { runAgent } from "../agent.js";

export function expPlanSkill(agentConfig: Parameters<typeof runAgent>[0]["config"]): SkillDefinition {
  return {
    name: "exp-plan",
    command: "/exp-plan",
    description: "Generate a structured experiment plan for ML model iteration",
    chainTo: [],  // Human reviews before dev starts — no auto-chain
    requiresHumanApproval: false,
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const prompt = buildPrompt(ctx.input, ctx.memory.snapshot());

      const result = await runAgent({
        prompt,
        config: agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      // Persist plan to memory and file
      ctx.memory.set("last_exp_plan", result.output, "project", ["experiment", "plan"]);

      // Extract experiment ID from output or generate one
      const expId = extractExpId(result.output) ?? `exp-${Date.now()}`;
      ctx.memory.set("current_experiment_id", expId, "session");

      const planFile = `exp-plan-${expId}.md`;
      const artifacts: Record<string, string> = {
        [planFile]: result.output,
      };

      // Also apply memory updates the agent embedded
      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "project", ["experiment"]);
      }

      return {
        success: true,
        output: result.output,
        artifacts,
      };
    },
  };
}

function buildPrompt(input: string, memorySnapshot: Record<string, unknown>): string {
  const pastPlans = memorySnapshot["last_exp_plan"]
    ? `\n\n## Previous Experiment Plan\n${String(memorySnapshot["last_exp_plan"]).slice(0, 500)}...`
    : "";

  return `You are planning an ML model experiment. Produce a complete, actionable experiment plan.

## Research Goal
${input}
${pastPlans}

## Required Output Format

### Experiment ID
Generate a short ID like "exp-YYYYMMDD-<topic>" (e.g., exp-20260321-reward-shaping)

### Hypothesis
State the hypothesis clearly: "We believe that [change] will [effect] because [reason]"

### Experiment Design
- **Independent variable**: What you're changing
- **Dependent variables**: What you're measuring
- **Control**: Baseline to compare against
- **Sample size / budget**: Compute/data budget

### Implementation Plan
Step-by-step code changes needed. For each step:
  1. File/module to modify
  2. Change description
  3. Expected behavior

### Metrics
List each metric with:
  - Name and unit
  - How to compute it
  - Success threshold
  - Failure threshold

### Expected Outcomes
- **If hypothesis is correct**: [describe]
- **If hypothesis is wrong**: [describe what you'll learn]

### Risks & Mitigations
List top 3 risks and how to handle them.

### Success Criteria
Define exactly what "this experiment succeeded" means.

---
Embed any key facts for future reference as: <!-- MEMORY: key=value -->`;
}

function extractExpId(output: string): string | undefined {
  const match = output.match(/exp-\d{8}-[a-z0-9-]+/i);
  return match?.[0];
}
