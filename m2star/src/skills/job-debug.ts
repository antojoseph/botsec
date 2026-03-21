/**
 * /job-debug — Job Debugging Skill
 *
 * Shown in the diagram's "Steer the agent" section and the bottom caption:
 *   /job-debug → /fix → /issue-report
 *
 * Given a failing job (logs, error, command), diagnoses the root cause
 * and produces a concrete fix. Auto-chains to /issue-fix.
 */

import { SkillDefinition, SkillContext, SkillResult } from "../types.js";
import { runAgent } from "../agent.js";

export function jobDebugSkill(agentConfig: Parameters<typeof runAgent>[0]["config"]): SkillDefinition {
  return {
    name: "job-debug",
    command: "/job-debug",
    description: "Debug a failing job or experiment run and diagnose the root cause",
    chainTo: ["issue-fix"],
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const prompt = buildDebugPrompt(ctx.input);

      const result = await runAgent({
        prompt,
        config: ctx.agentConfig ?? agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      // Persist debug findings so /issue-fix can use them
      ctx.memory.set("last_debug_findings", result.output, "session", ["debug", "job"]);

      // Apply memory updates
      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "project", ["debug"]);
      }

      return {
        success: true,
        output: result.output,
        artifacts: { "job-debug-report.md": result.output },
      };
    },
  };
}

function buildDebugPrompt(input: string): string {
  return `You are debugging a failing ML job or experiment. Perform systematic root cause analysis.

## Failing Job / Error / Logs
${input}

## Debugging Process

### 1. Error Classification
Classify the error:
  - **Category**: infrastructure / code bug / data issue / config error / OOM / timeout / dependency
  - **Scope**: single job / systemic / intermittent
  - **Severity**: blocking / degrading / cosmetic

### 2. Evidence Analysis
From the logs/error, identify:
  - The exact failing line or operation
  - Stack trace analysis (if present)
  - Last successful state before failure
  - Any anomalous values or patterns

### 3. Root Cause Hypothesis
State the primary hypothesis: "The failure is caused by [X] because [evidence Y]"

List alternative hypotheses in order of likelihood.

### 4. Diagnostic Steps Taken
What you checked and what it revealed:
  1. [Check] → [Finding]
  2. [Check] → [Finding]
  ...

### 5. Issues for /issue-fix
Format each issue as:
  - **Issue ID**: ISS-<N>
  - **Severity**: low/medium/high
  - **Description**: [one line]
  - **Evidence**: [specific log line or code]
  - **Suggested fix**: [concrete change]

### 6. Immediate Mitigation
If there's a quick workaround to unblock the job before a proper fix:
  - Describe the workaround
  - Note its limitations

### 7. Prevention
How to prevent this class of failure in future:
  - Monitoring to add
  - Validation to add
  - Documentation to update

---
Embed key facts: <!-- MEMORY: key=value -->`;
}
