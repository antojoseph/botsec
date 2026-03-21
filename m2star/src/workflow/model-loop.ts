/**
 * Model Improvement Loop — recursive feedback artifact.
 *
 * The diagram shows "→ produces next-gen model (recursive loop)".
 * This module generates a structured ModelImprovementPlan that captures:
 *   - What changed this iteration
 *   - What to try next
 *   - Which hyperparameters/configs to update
 *   - Estimated impact on model quality
 *
 * The plan JSON is the concrete artifact that "feeds back" into the next
 * training run, closing the recursive loop.
 */

import fs from "fs";
import path from "path";
import { runAgent } from "../agent.js";
import type { AgentConfig, MemoryStore } from "../types.js";

export interface ModelImprovementPlan {
  version: number;
  timestamp: string;
  /** What experiment/iteration produced this plan */
  sourceIterationId: string;
  /** Changes applied this iteration */
  appliedChanges: ModelChange[];
  /** Changes recommended for next iteration */
  nextChanges: ModelChange[];
  /** Hyperparameter updates to apply */
  configUpdates: Record<string, unknown>;
  /** Estimated impact */
  estimatedGain: {
    metric: string;
    currentValue: number;
    projectedValue: number;
    confidence: "low" | "medium" | "high";
  }[];
  /** Whether this plan should be auto-applied or needs human review */
  autoApply: boolean;
  /** Human-readable rationale */
  rationale: string;
}

export interface ModelChange {
  type: "architecture" | "training" | "data" | "hyperparameter" | "regularization" | "other";
  description: string;
  files?: string[];
  diff?: string;
  appliedAt?: string;
}

export async function generateModelImprovementPlan(
  iterationId: string,
  memory: MemoryStore,
  agentConfig: AgentConfig,
  outputDir: string
): Promise<ModelImprovementPlan> {
  const memSnapshot = memory.snapshot();
  const iterationCount = (memSnapshot["iteration_count"] as number | undefined) ?? 0;

  const prompt = buildPlanPrompt(iterationId, iterationCount, memSnapshot);

  const result = await runAgent({
    prompt,
    config: agentConfig,
    memory,
    onOutput: (text) => process.stdout.write(text),
  });

  // Parse the structured JSON block from the agent's output
  const plan = extractPlan(result.output, iterationId, iterationCount);

  // Persist the plan
  fs.mkdirSync(outputDir, { recursive: true });
  const planPath = path.join(outputDir, `model-improvement-plan-v${plan.version}.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  // Store in memory for the next iteration to reference
  memory.set("model_improvement_plan", plan, "global", ["model", "plan", "recursive-loop"]);
  memory.set(`plan_v${plan.version}`, planPath, "global", ["plan", "history"]);

  console.log(`\n✓ Model improvement plan v${plan.version} written to ${planPath}`);

  return plan;
}

function buildPlanPrompt(
  iterationId: string,
  iterationCount: number,
  memory: Record<string, unknown>
): string {
  const lastResults = memory["last_exp_results"] as string | undefined;
  const lastFixes = memory["last_issue_fix"] as string | undefined;
  const prevPlan = memory["model_improvement_plan"] as ModelImprovementPlan | undefined;

  return `You are generating a Model Improvement Plan — a structured artifact that feeds back into
the next training run to close the recursive improvement loop.

## Context
- Iteration: ${iterationCount}
- Experiment ID: ${iterationId}
${prevPlan ? `- Previous plan version: v${prevPlan.version}` : "- No previous plan (first iteration)"}

## Experiment Results
${lastResults?.slice(0, 800) ?? "(none)"}

## Applied Fixes
${lastFixes?.slice(0, 500) ?? "(none)"}

${prevPlan ? `## Previous Plan (for continuity)
${JSON.stringify(prevPlan.nextChanges ?? [], null, 2).slice(0, 400)}` : ""}

---
## Your Output

Produce a JSON block enclosed in \`\`\`json ... \`\`\` with this exact schema:

\`\`\`json
{
  "appliedChanges": [
    {
      "type": "training|architecture|data|hyperparameter|regularization|other",
      "description": "...",
      "files": ["path/to/file.py"]
    }
  ],
  "nextChanges": [
    {
      "type": "training|architecture|data|hyperparameter|regularization|other",
      "description": "...",
      "files": ["path/to/file.py"]
    }
  ],
  "configUpdates": {
    "learning_rate": 0.0001,
    "batch_size": 128
  },
  "estimatedGain": [
    {
      "metric": "reward",
      "currentValue": 0.42,
      "projectedValue": 0.51,
      "confidence": "medium"
    }
  ],
  "autoApply": false,
  "rationale": "2-3 sentence explanation of why these changes are recommended"
}
\`\`\`

After the JSON, write a brief narrative (2-3 paragraphs) explaining:
1. What was learned this iteration
2. Why the next changes are chosen
3. What would constitute success in the next iteration

---
Embed key facts: <!-- MEMORY: key=value -->`;
}

function extractPlan(
  output: string,
  iterationId: string,
  iterationCount: number
): ModelImprovementPlan {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);

  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Partial<ModelImprovementPlan>;
      return {
        version: iterationCount + 1,
        timestamp: new Date().toISOString(),
        sourceIterationId: iterationId,
        appliedChanges: parsed.appliedChanges ?? [],
        nextChanges: parsed.nextChanges ?? [],
        configUpdates: parsed.configUpdates ?? {},
        estimatedGain: parsed.estimatedGain ?? [],
        autoApply: parsed.autoApply ?? false,
        rationale: parsed.rationale ?? output.slice(0, 300),
      };
    } catch {
      // Fall through to default
    }
  }

  // Fallback: construct a minimal plan from the text
  return {
    version: iterationCount + 1,
    timestamp: new Date().toISOString(),
    sourceIterationId: iterationId,
    appliedChanges: [],
    nextChanges: [],
    configUpdates: {},
    estimatedGain: [],
    autoApply: false,
    rationale: output.slice(0, 500),
  };
}

/** Apply a model improvement plan — updates config files in workdir */
export async function applyPlan(
  plan: ModelImprovementPlan,
  workdir: string,
  dryRun: boolean = true
): Promise<string[]> {
  const applied: string[] = [];

  if (!plan.autoApply && !dryRun) {
    console.log("  Plan requires human review before auto-apply. Set autoApply=true to enable.");
    return applied;
  }

  // Write config updates to a config file
  if (Object.keys(plan.configUpdates).length > 0) {
    const configPath = path.join(workdir, "m2star-next-config.json");
    const action = dryRun ? "(dry-run) would write" : "writing";
    console.log(`  ${action} ${configPath}`);

    if (!dryRun) {
      fs.writeFileSync(configPath, JSON.stringify(plan.configUpdates, null, 2));
    }
    applied.push(configPath);
  }

  return applied;
}
