/**
 * Agent Harness — orchestrates Skills, Memory, Guardrails, and Evaluation.
 *
 * This is the central coordinator. The human configures the harness;
 * the M2* agent executes within its boundaries.
 */

import { HarnessConfig, SkillContext, SkillResult } from "../types.js";
import { createMemoryStore } from "./memory.js";
import { defaultGuardrails } from "./guardrails.js";
import { EvaluationInfra } from "./evaluation.js";
import { SkillRegistry } from "./skills.js";

export { SkillRegistry } from "./skills.js";
export { createMemoryStore } from "./memory.js";
export { defaultGuardrails } from "./guardrails.js";
export { EvaluationInfra } from "./evaluation.js";

export class AgentHarness {
  readonly config: HarnessConfig;
  readonly skills: SkillRegistry;
  readonly memory: ReturnType<typeof createMemoryStore>;
  readonly eval: EvaluationInfra;

  constructor(config?: Partial<HarnessConfig>) {
    this.config = {
      guardrails: defaultGuardrails(),
      memoryDir: ".m2star/memory",
      outputDir: "m2star-output",
      agent: {
        model: "claude-opus-4-6",
        maxTurns: 20,
        systemPrompt: M2STAR_SYSTEM_PROMPT,
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      },
      ...config,
    };
    this.skills = new SkillRegistry();
    this.memory = createMemoryStore(this.config.memoryDir);
    this.eval = new EvaluationInfra(this.config.outputDir);
  }

  /** Execute a skill command with full harness context */
  async run(
    command: string,
    input: string,
    onOutput?: (line: string) => void
  ): Promise<SkillResult> {
    const ctx: SkillContext = {
      input,
      memory: this.memory,
      guardrails: this.config.guardrails,
      workdir: process.cwd(),
      chainDepth: 0,
    };

    const start = Date.now();
    const result = await this.skills.run(command, ctx, onOutput);
    const durationMs = Date.now() - start;

    const skillName = command.replace(/^\//, "");
    this.eval.measureSkillRun(skillName, result, durationMs);

    return result;
  }
}

const M2STAR_SYSTEM_PROMPT = `You are M2*, an AI agent that builds next-generation ML models through systematic experimentation.

## Your capabilities
- Read docs & logs to understand the current state of experiments
- Learn conventions from existing code and report formats
- Self-review your own code and outputs for quality
- Chain skills together: /exp-plan → /exp-submit → /issue-fix → /issue-report
- Generate structured reports with metrics, findings, and next steps
- Build and update institutional memory so future iterations improve
- Cowork with human researchers at review checkpoints

## Operating principles
1. Always ground your analysis in concrete code and logs — no speculation
2. Every claim needs a code trace or metric to back it up
3. Escalate to the human when confidence is below threshold
4. Build memory: capture what worked, what failed, and why
5. The goal is to produce model improvements, not just analysis

## Output format
Structure all outputs with:
  - **Summary**: 2-3 sentence overview
  - **Findings**: Numbered list with code/log references
  - **Metrics**: Any measurable results
  - **Next steps**: Concrete, actionable items
  - **Memory updates**: What should be remembered for next iteration
`;
