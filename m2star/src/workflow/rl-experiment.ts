/**
 * RL Team — Experiment Workflow (5 phases)
 *
 * Implements the full Plan-Dev-Analyze-Review-Iterate loop shown in the diagram:
 *
 *  Phase 1: Exp Plan       (Human + AI)  → /exp-plan
 *  Phase 2: Exp Dev & Run  (AI)          → agent writes/runs experiment code
 *  Phase 3: Analyze Report (AI)          → /exp-submit
 *  Phase 4: Review Discuss (Human + AI)  → human checkpoint
 *  Phase 5: Exp Iterate    (Human + AI)  → /issue-fix → /exp-submit (loop)
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { AgentHarness } from "../harness/index.js";
import { runAgent } from "../agent.js";
import {
  Experiment,
  ExperimentPhase,
  ExperimentResults,
  ExperimentIssue,
} from "../types.js";

export interface WorkflowOptions {
  /** Research goal / experiment description */
  goal: string;
  /** Working directory containing experiment code */
  workdir: string;
  /** Max number of iterate loops before stopping */
  maxIterations?: number;
  /** Skip human checkpoint prompts (for automated runs) */
  autoApprove?: boolean;
  /** Output directory for reports */
  outputDir?: string;
}

export interface WorkflowResult {
  experiment: Experiment;
  totalIterations: number;
  reports: string[];
  finalStatus: "completed" | "stopped_by_human" | "max_iterations_reached";
}

export class RLExperimentWorkflow {
  private harness: AgentHarness;

  constructor(harness: AgentHarness) {
    this.harness = harness;
  }

  async run(opts: WorkflowOptions): Promise<WorkflowResult> {
    const {
      goal,
      workdir,
      maxIterations = 5,
      autoApprove = false,
      outputDir = "m2star-output",
    } = opts;

    fs.mkdirSync(outputDir, { recursive: true });

    const experiment: Experiment = {
      id: `exp-${Date.now()}`,
      name: goal.slice(0, 60),
      description: goal,
      hypothesis: "",
      phase: "plan",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      iterations: 0,
      issues: [],
      artifacts: {},
    };

    const reports: string[] = [];
    let iteration = 0;
    let continueLoop = true;

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  M2* RL Experiment Workflow");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Goal: ${goal}`);
    console.log(`  Max iterations: ${maxIterations}`);
    console.log("═══════════════════════════════════════════════════════\n");

    while (continueLoop && iteration < maxIterations) {
      iteration++;
      experiment.iterations = iteration;
      experiment.updatedAt = new Date().toISOString();

      console.log(`\n── Iteration ${iteration}/${maxIterations} ──────────────────────────────────\n`);

      // ── Phase 1: Experiment Plan ─────────────────────────────────────
      experiment.phase = "plan";
      console.log("Phase 1: Experiment Planning\n");

      const planResult = await this.harness.run(
        "/exp-plan",
        iteration === 1
          ? goal
          : `Next iteration of: ${goal}\n\nPrevious results:\n${this.harness.memory.get("last_exp_results") ?? "(none)"}`
      );

      if (!planResult.success) {
        console.error("Exp plan failed:", planResult.output);
        break;
      }

      saveArtifacts(planResult.artifacts ?? {}, outputDir);

      // Human checkpoint after planning
      if (!autoApprove) {
        const approved = await humanCheckpoint(
          "Review the experiment plan above. Proceed to Dev & Run?",
          ["yes", "no", "modify"]
        );
        if (approved === "no") {
          return { experiment, totalIterations: iteration, reports, finalStatus: "stopped_by_human" };
        }
      }

      // ── Phase 2: Experiment Dev & Run ────────────────────────────────
      experiment.phase = "dev_run";
      console.log("\nPhase 2: Experiment Dev & Run\n");

      const devResult = await this.runDevPhase(planResult.output, workdir, outputDir);
      experiment.artifacts[`dev-run-${iteration}`] = devResult.logsFile;

      // ── Phase 3: Analyze & Report ────────────────────────────────────
      experiment.phase = "analyze_report";
      console.log("\nPhase 3: Analyze & Report\n");

      const submitResult = await this.harness.run(
        "/exp-submit",
        `Experiment logs and metrics:\n${devResult.logs}`
      );

      if (submitResult.success) {
        saveArtifacts(submitResult.artifacts ?? {}, outputDir);
        const reportFile = Object.keys(submitResult.artifacts ?? {}).find((f) =>
          f.startsWith("exp-report")
        );
        if (reportFile) reports.push(path.join(outputDir, reportFile));
      }

      // Extract issues from results
      const newIssues = parseIssues(submitResult.output);
      experiment.issues.push(...newIssues);

      // ── Phase 4: Review & Discuss ────────────────────────────────────
      experiment.phase = "review_discuss";
      console.log("\nPhase 4: Review & Discuss\n");

      this.printReviewSummary(submitResult.output, newIssues);

      let nextAction: string = "iterate";
      if (!autoApprove) {
        nextAction = await humanCheckpoint(
          "Review complete. What next?",
          ["iterate", "done", "stop"]
        );
      }

      if (nextAction === "done" || nextAction === "stop") {
        continueLoop = false;
        break;
      }

      // ── Phase 5: Exp Iterate Loop ────────────────────────────────────
      experiment.phase = "iterate";
      console.log("\nPhase 5: Exp Iterate Loop\n");

      if (newIssues.length > 0) {
        console.log(`  Found ${newIssues.length} issues — running /issue-fix chain\n`);
        const fixResult = await this.harness.run(
          "/issue-fix",
          `Issues from iteration ${iteration}:\n${submitResult.output}`
        );
        saveArtifacts(fixResult.artifacts ?? {}, outputDir);

        // /issue-fix auto-chains to /issue-report
        // The report is already generated at this point
        const lastReport = this.harness.memory.get("last_issue_fix") as string;
        if (lastReport) {
          const reportPath = path.join(outputDir, `issue-fix-${iteration}.md`);
          fs.writeFileSync(reportPath, lastReport);
          reports.push(reportPath);
        }
      } else {
        console.log("  No issues found — proceeding directly to next iteration\n");
      }
    }

    // Final report
    experiment.phase = "analyze_report";
    const finalReportResult = await this.harness.run(
      "/issue-report",
      `Final report for: ${goal}`
    );
    saveArtifacts(finalReportResult.artifacts ?? {}, outputDir);

    this.harness.eval.printSummary();

    const finalStatus =
      iteration >= maxIterations ? "max_iterations_reached" : "completed";

    console.log(`\n✓ Workflow complete after ${iteration} iteration(s)`);
    console.log(`  Status: ${finalStatus}`);
    console.log(`  Reports: ${reports.length} generated in ${outputDir}/`);

    return { experiment, totalIterations: iteration, reports, finalStatus };
  }

  /**
   * Phase 2: AI writes experiment code, runs it, captures logs.
   * In a real system this would invoke actual training jobs.
   */
  private async runDevPhase(
    plan: string,
    workdir: string,
    outputDir: string
  ): Promise<{ logs: string; logsFile: string }> {
    const devPrompt = `You are implementing and running an ML experiment.

## Experiment Plan
${plan.slice(0, 1000)}

## Working Directory
${workdir}

## Your Task
1. Review the plan and identify what code needs to be written/modified
2. Describe the implementation steps concretely (what files, what changes)
3. Describe the run procedure (commands to execute)
4. Produce a realistic mock of what the training logs and metrics output would look like
   given the hypothesis in the plan

Format the mock logs as if they were real output:
\`\`\`
[Training Log]
Epoch 1/10: loss=2.341, reward=0.12, ...
...
\`\`\`

Also produce a metrics summary table.`;

    const result = await runAgent({
      prompt: devPrompt,
      config: this.harness.config.agent,
      memory: this.harness.memory,
      onOutput: (text) => process.stdout.write(text),
      cwd: workdir,
    });

    const logsFile = path.join(outputDir, `dev-run-logs-${Date.now()}.txt`);
    fs.writeFileSync(logsFile, result.output);

    // Store in memory for /exp-submit
    this.harness.memory.set("dev_run_logs", result.output, "session", ["logs"]);

    return { logs: result.output, logsFile };
  }

  private printReviewSummary(output: string, issues: ExperimentIssue[]): void {
    console.log("\n── Review Summary ──────────────────────────────────");
    console.log(`  Issues found: ${issues.length}`);
    if (issues.length > 0) {
      for (const issue of issues.slice(0, 5)) {
        console.log(`  • [${issue.severity.toUpperCase()}] ${issue.id}: ${issue.title}`);
      }
    }
    const successLine = output.match(/Deploy recommendation:\s*(\w+)/i);
    if (successLine) {
      console.log(`  Deploy recommendation: ${successLine[1]}`);
    }
    console.log("────────────────────────────────────────────────────\n");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function saveArtifacts(artifacts: Record<string, string>, outputDir: string): void {
  for (const [filename, content] of Object.entries(artifacts)) {
    const filePath = path.join(outputDir, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

function parseIssues(output: string): ExperimentIssue[] {
  const issues: ExperimentIssue[] = [];
  const pattern = /\*\*Issue ID\*\*:\s*(ISS-\d+)[\s\S]*?\*\*Severity\*\*:\s*(\w+)[\s\S]*?\*\*Description\*\*:\s*([^\n]+)/g;
  let match;

  while ((match = pattern.exec(output)) !== null) {
    const [, id, severity, description] = match;
    issues.push({
      id,
      title: description.trim(),
      description: description.trim(),
      severity: (["low", "medium", "high"].includes(severity.toLowerCase())
        ? severity.toLowerCase()
        : "medium") as ExperimentIssue["severity"],
      status: "open",
      createdAt: new Date().toISOString(),
    });
  }

  return issues;
}

async function humanCheckpoint(
  prompt: string,
  options: string[]
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const optionsStr = options.map((o, i) => `[${i + 1}] ${o}`).join("  ");
    rl.question(`\n  ⏸  ${prompt}\n  ${optionsStr}\n  > `, (answer) => {
      rl.close();
      const num = parseInt(answer.trim());
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        resolve(options[num - 1]);
      } else {
        // Match by text
        const matched = options.find((o) => o.toLowerCase().startsWith(answer.trim().toLowerCase()));
        resolve(matched ?? options[0]);
      }
    });
  });
}
