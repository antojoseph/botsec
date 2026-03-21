/**
 * /exp-submit — Experiment Submit Skill (Phase 3, AI)
 *
 * After dev & run, analyzes logs and metrics, generates a performance
 * dashboard report, identifies issues, and submits results.
 *
 * Auto-chains to /issue-fix if critical issues are found.
 */

import { SkillDefinition, SkillContext, SkillResult, Experiment } from "../types.js";
import { runAgent } from "../agent.js";

export function expSubmitSkill(agentConfig: Parameters<typeof runAgent>[0]["config"]): SkillDefinition {
  return {
    name: "exp-submit",
    command: "/exp-submit",
    description: "Analyze experiment results and submit performance report",
    chainTo: ["issue-fix"],  // Auto-chains to issue-fix if issues detected
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const expId = ctx.memory.get("current_experiment_id") as string | undefined;
      const expPlan = ctx.memory.get("last_exp_plan") as string | undefined;

      const prompt = buildSubmitPrompt(ctx.input, expId, expPlan);

      const result = await runAgent({
        prompt,
        config: ctx.agentConfig ?? agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      // Parse results and detect issues
      const hasIssues = detectIssues(result.output);
      const report = buildExperimentRecord(expId ?? "unknown", ctx.input, result.output);

      // Persist to memory
      ctx.memory.set("last_exp_results", result.output, "project", ["experiment", "results"]);
      ctx.memory.set(`exp_report_${report.id}`, report, "project", ["report"]);

      // Apply memory updates
      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "project", ["results"]);
      }

      const reportFile = `exp-report-${report.id}.md`;

      return {
        success: true,
        output: result.output,
        artifacts: { [reportFile]: result.output },
        // Signal chain to issue-fix only if issues were found
        nextSkill: hasIssues ? "issue-fix" : undefined,
      };
    },
  };
}

function buildSubmitPrompt(
  logsAndMetrics: string,
  expId?: string,
  expPlan?: string
): string {
  const planContext = expPlan
    ? `\n\n## Original Experiment Plan\n${expPlan.slice(0, 800)}`
    : "";

  return `You are analyzing ML experiment results and generating a report.

## Experiment ID: ${expId ?? "unknown"}

## Logs, Metrics & Results
${logsAndMetrics}
${planContext}

## Required Output

### Performance Dashboard

**Key Metrics Table**
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
(fill in from logs)

**Training Curves Summary**
Describe loss/reward trends in 2-3 sentences.

**Comparison to Baseline**
How does this compare to the control / previous best?

### Analysis

**What worked**
Bullet list of successful aspects with supporting evidence from logs.

**What didn't work**
Bullet list of failures/regressions with evidence.

**Root cause hypotheses**
For each failure, a hypothesis about why it happened.

### Issues Found

List any issues that need fixing. For each:
  - **Issue ID**: ISS-<number>
  - **Severity**: low/medium/high
  - **Description**: What's wrong
  - **Evidence**: Specific log line or metric
  - **Suggested fix**: Concrete code change

If no issues found, write "NO_ISSUES_FOUND".

### Model Quality Assessment

Structured assessment:
  - **Regression risk**: none/low/medium/high
  - **Deploy recommendation**: yes/no/conditional
  - **Conditions** (if conditional): [list]

### Next Steps

Numbered list of concrete next actions.

---
Embed key facts: <!-- MEMORY: key=value -->`;
}

function detectIssues(output: string): boolean {
  return (
    !output.includes("NO_ISSUES_FOUND") &&
    (output.includes("ISS-") || output.toLowerCase().includes("issue"))
  );
}

function buildExperimentRecord(expId: string, input: string, output: string): Experiment {
  return {
    id: expId,
    name: expId,
    description: input.slice(0, 200),
    hypothesis: "",
    phase: "analyze_report",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    iterations: 1,
    results: {
      metrics: [],
      logs: input,
      summary: output.slice(0, 500),
      nextSteps: [],
    },
    issues: [],
    artifacts: {},
  };
}
