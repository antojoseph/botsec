/**
 * /job-profile — Job Profiling Skill
 *
 * Shown in the diagram's "Steer the agent" section: "Invoke /job-debug, /job-profile"
 *
 * Given a job's performance data (traces, timings, GPU utilization, memory),
 * identifies bottlenecks and recommends optimizations.
 */

import { SkillDefinition, SkillContext, SkillResult } from "../types.js";
import { runAgent } from "../agent.js";

export function jobProfileSkill(agentConfig: Parameters<typeof runAgent>[0]["config"]): SkillDefinition {
  return {
    name: "job-profile",
    command: "/job-profile",
    description: "Profile a training job and identify performance bottlenecks",
    chainTo: [],  // Informational — human decides what to act on
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const prompt = buildProfilePrompt(ctx.input);

      const result = await runAgent({
        prompt,
        config: ctx.agentConfig ?? agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      ctx.memory.set("last_profile_report", result.output, "project", ["profile", "performance"]);

      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "project", ["profile"]);
      }

      return {
        success: true,
        output: result.output,
        artifacts: { "job-profile-report.md": result.output },
      };
    },
  };
}

function buildProfilePrompt(input: string): string {
  return `You are profiling an ML training job to identify performance bottlenecks.

## Job Profile Data
${input}

## Profiling Analysis

### 1. Resource Utilization Summary

| Resource        | Measured | Target | Status |
|-----------------|----------|--------|--------|
| GPU utilization | ?%       | >85%   |        |
| GPU memory      | ?GB      |        |        |
| CPU utilization | ?%       | <50%   |        |
| I/O throughput  | ?GB/s    |        |        |
| Network         | ?GB/s    |        |        |

(Fill in from profile data)

### 2. Time Breakdown

Where is time being spent?

| Phase             | Time   | % of Total | Bottleneck? |
|-------------------|--------|------------|-------------|
| Data loading      |        |            |             |
| Forward pass      |        |            |             |
| Backward pass     |        |            |             |
| Optimizer step    |        |            |             |
| Communication     |        |            |             |
| Other             |        |            |             |

### 3. Top Bottlenecks

For each bottleneck (sorted by impact):

#### Bottleneck N: [Name]
- **Location**: [file:line or operation]
- **Impact**: [% of total time or memory]
- **Root cause**: [why it's slow]
- **Fix**: [concrete recommendation]
- **Expected speedup**: [Nx or X% improvement]

### 4. Critical Path Analysis
What is the critical path through the computation graph?
Is it compute-bound, memory-bound, or communication-bound?

### 5. Optimization Roadmap

| Priority | Change | Effort | Expected Gain |
|----------|--------|--------|---------------|
| P0       |        | S/M/L  |               |
| P1       |        | S/M/L  |               |
| P2       |        | S/M/L  |               |

### 6. Quick Wins
Changes that can be made in <1 hour:
  1. [Change]: [Expected improvement]

### 7. Regression Risks
Optimizations that could affect model quality:
  - [Optimization]: [Risk]: [How to validate safety]

### 8. Monitoring Recommendations
Metrics to track going forward:
  - [Metric]: [Tool/method to collect it]

---
Embed key facts: <!-- MEMORY: key=value -->`;
}
