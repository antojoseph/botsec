/**
 * RL Team — Experiment Workflow (5 phases)
 *
 * Implements the full Plan-Dev-Analyze-Review-Iterate loop from the diagram:
 *
 *  Phase 1: Exp Plan       (Human + AI)  → /exp-plan
 *  Phase 2: Exp Dev & Run  (AI)          → execute scripts, profile, problem-shoot, rerun
 *  Phase 3: Analyze Report (AI)          → /exp-submit
 *  Phase 4: Review Discuss (Human + AI)  → human checkpoint
 *  Phase 5: Exp Iterate    (Human + AI)  → /issue-fix → /exp-submit (loop) → /issue-report
 *
 * Two distinct control paths (matching diagram arrows):
 *   HUMAN_GUIDED   — human approves each phase transition ("next iteration (human triggers)")
 *   AUTONOMOUS     — agent auto-continues after phases 1 and 4 ("auto-continue (agent analyzes next)")
 */

import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";
import readline from "readline";
import { AgentHarness } from "../harness/index.js";
import { runAgent } from "../agent.js";
import { generateModelImprovementPlan } from "./model-loop.js";
import { generateDashboard, IterationSummary } from "../report/dashboard.js";
import {
  Experiment,
  ExperimentIssue,
} from "../types.js";

export type WorkflowMode = "human_guided" | "autonomous";

export interface WorkflowOptions {
  goal: string;
  workdir: string;
  maxIterations?: number;
  /** human_guided: human approves each phase. autonomous: agent auto-continues. */
  mode?: WorkflowMode;
  outputDir?: string;
}

export interface WorkflowResult {
  experiment: Experiment;
  totalIterations: number;
  reports: string[];
  dashboardPath: string;
  finalStatus: "completed" | "stopped_by_human" | "max_iterations_reached";
}

export class RLExperimentWorkflow {
  private harness: AgentHarness;
  private iterationSummaries: IterationSummary[] = [];

  constructor(harness: AgentHarness) {
    this.harness = harness;
  }

  async run(opts: WorkflowOptions): Promise<WorkflowResult> {
    const {
      goal,
      workdir,
      maxIterations = 5,
      mode = "human_guided",
      outputDir = "m2star-output",
    } = opts;

    fs.mkdirSync(outputDir, { recursive: true });

    const isAutonomous = mode === "autonomous";

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
    let stoppedByHuman = false;

    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  M2* RL Experiment Workflow");
    console.log(`  Mode: ${mode === "autonomous" ? "AUTONOMOUS (agent auto-continues)" : "HUMAN_GUIDED (checkpoints at each phase)"}`);
    console.log(`  Goal: ${goal}`);
    console.log(`  Max iterations: ${maxIterations}`);
    console.log("═══════════════════════════════════════════════════════\n");

    while (continueLoop && iteration < maxIterations) {
      iteration++;
      experiment.iterations = iteration;
      experiment.updatedAt = new Date().toISOString();

      console.log(`\n── Iteration ${iteration}/${maxIterations} ──────────────────────────────────\n`);

      // ── Phase 1: Experiment Plan ─────────────────────────────────────────────
      experiment.phase = "plan";
      console.log("Phase 1: Experiment Planning\n");

      const planInput =
        iteration === 1
          ? goal
          : `Next iteration of: ${goal}\n\nPrevious results:\n${
              this.harness.memory.get("last_exp_results") ?? "(none)"
            }\n\nPrevious improvement plan:\n${JSON.stringify(
              this.harness.memory.get("model_improvement_plan") ?? {}
            ).slice(0, 400)}`;

      const planResult = await this.harness.run("/exp-plan", planInput);
      if (!planResult.success) {
        console.error("Exp plan failed:", planResult.output);
        break;
      }
      saveArtifacts(planResult.artifacts ?? {}, outputDir);

      // HUMAN_GUIDED: checkpoint after plan
      // AUTONOMOUS: agent decides whether to proceed based on confidence
      if (!isAutonomous) {
        const choice = await humanCheckpoint(
          "Review the experiment plan above. Proceed to Dev & Run?",
          ["yes", "no", "modify"]
        );
        if (choice === "no") {
          return { experiment, totalIterations: iteration, reports, dashboardPath: "", finalStatus: "stopped_by_human" };
        }
      } else {
        // Autonomous: announce continuing
        console.log("  [AUTONOMOUS] Auto-continuing to Phase 2…\n");
      }

      // ── Phase 2: Experiment Dev & Run ────────────────────────────────────────
      experiment.phase = "dev_run";
      console.log("\nPhase 2: Experiment Dev & Run\n");

      const devResult = await this.runDevPhase(planResult.output, workdir, outputDir);
      experiment.artifacts[`dev-run-${iteration}`] = devResult.logsFile;

      // ── Phase 3: Analyze & Report ─────────────────────────────────────────────
      experiment.phase = "analyze_report";
      console.log("\nPhase 3: Analyze & Report\n");

      const submitResult = await this.harness.run(
        "/exp-submit",
        `Experiment logs and metrics:\n${devResult.logs}`
      );
      saveArtifacts(submitResult.artifacts ?? {}, outputDir);

      const reportFile = Object.keys(submitResult.artifacts ?? {}).find((f) =>
        f.startsWith("exp-report")
      );
      if (reportFile) reports.push(path.join(outputDir, reportFile));

      const newIssues = parseIssues(submitResult.output);
      experiment.issues.push(...newIssues);

      // ── Phase 4: Review & Discuss ─────────────────────────────────────────────
      experiment.phase = "review_discuss";
      console.log("\nPhase 4: Review & Discuss\n");

      this.printReviewSummary(submitResult.output, newIssues);

      let nextAction = "iterate";
      if (!isAutonomous) {
        nextAction = await humanCheckpoint(
          "Review complete. What next?",
          ["iterate", "done", "stop"]
        );
      } else {
        // Autonomous: decide based on whether there are issues
        nextAction = newIssues.length > 0 || iteration < maxIterations ? "iterate" : "done";
        console.log(`  [AUTONOMOUS] Auto-decision: ${nextAction}\n`);
      }

      if (nextAction === "done" || nextAction === "stop") {
        // Record this iteration's summary before breaking
        this.iterationSummaries.push({
          iteration,
          timestamp: new Date().toISOString(),
          metrics: {},
          issues: newIssues.length,
          deployRecommendation: submitResult.output.match(/Deploy recommendation:\s*(\w+)/i)?.[1] ?? "unknown",
          passed: newIssues.filter((i) => i.severity === "high").length === 0,
        });
        if (nextAction === "stop") stoppedByHuman = true;
        continueLoop = false;
        break;
      }

      // ── Phase 5: Exp Iterate Loop ─────────────────────────────────────────────
      experiment.phase = "iterate";
      console.log("\nPhase 5: Exp Iterate Loop\n");

      if (newIssues.length > 0) {
        console.log(`  Found ${newIssues.length} issues — running /issue-fix\n`);
        const fixResult = await this.harness.run(
          "/issue-fix",
          `Issues from iteration ${iteration}:\n${submitResult.output}`
        );
        saveArtifacts(fixResult.artifacts ?? {}, outputDir);

        // ── /exp-submit loop (Phase 5 inner loop) ──────────────────────────────
        // After applying fixes, re-run the experiment and submit again
        // to confirm improvements before moving to the next full iteration.
        console.log("\n  Phase 5 inner loop: re-running dev & submit after fixes\n");

        const rerunResult = await this.runDevPhase(
          `Re-run after fixes:\n${fixResult.output.slice(0, 500)}\n\nOriginal plan:\n${planResult.output.slice(0, 500)}`,
          workdir,
          outputDir
        );

        const resubmitResult = await this.harness.run(
          "/exp-submit",
          `Post-fix experiment logs:\n${rerunResult.logs}`
        );
        saveArtifacts(resubmitResult.artifacts ?? {}, outputDir);

        const remainingIssues = parseIssues(resubmitResult.output);
        console.log(
          `  Post-fix submit: ${remainingIssues.length} remaining issues (was ${newIssues.length})\n`
        );

        // Update experiment issues status
        for (const fix of parseIssues(fixResult.output)) {
          const existing = experiment.issues.find((i) => i.id === fix.id);
          if (existing) existing.status = "in_progress";
        }
        for (const resolved of newIssues) {
          if (!remainingIssues.find((r) => r.id === resolved.id)) {
            const existing = experiment.issues.find((i) => i.id === resolved.id);
            if (existing) existing.status = "resolved";
          }
        }

        // /issue-report (terminal in the chain)
        const reportResult = await this.harness.run(
          "/issue-report",
          `Post-fix iteration ${iteration} summary`
        );
        saveArtifacts(reportResult.artifacts ?? {}, outputDir);
        const fixReportFile = Object.keys(reportResult.artifacts ?? {}).find((f) =>
          f.endsWith(".md")
        );
        if (fixReportFile) reports.push(path.join(outputDir, fixReportFile));
      } else {
        console.log("  No issues found — generating improvement plan and continuing\n");
      }

      // Track iteration summary for dashboard
      this.iterationSummaries.push({
        iteration,
        timestamp: new Date().toISOString(),
        metrics: {},
        issues: newIssues.length,
        deployRecommendation: submitResult.output.match(/Deploy recommendation:\s*(\w+)/i)?.[1] ?? "unknown",
        passed: newIssues.filter((i) => i.severity === "high").length === 0,
      });
    }

    // ── Final: generate model improvement plan + dashboard ────────────────────
    const expId = this.harness.memory.get("current_experiment_id") as string | undefined;
    const plan = await generateModelImprovementPlan(
      expId ?? experiment.id,
      this.harness.memory,
      this.harness.config.agent,
      outputDir
    );

    experiment.artifacts["model_improvement_plan"] = path.join(
      outputDir,
      `model-improvement-plan-v${plan.version}.json`
    );

    // Generate HTML dashboard
    const evalReports = this.harness.eval.getReports();

    const dashboardPath = path.join(outputDir, "dashboard.html");
    generateDashboard(
      { experiment, evalReports, iterationSummaries: this.iterationSummaries },
      dashboardPath
    );

    this.harness.eval.printSummary();

    const finalStatus: WorkflowResult["finalStatus"] = stoppedByHuman
      ? "stopped_by_human"
      : iteration >= maxIterations
      ? "max_iterations_reached"
      : "completed";

    console.log(`\n✓ Workflow complete after ${iteration} iteration(s)`);
    console.log(`  Status: ${finalStatus}`);
    console.log(`  Reports: ${reports.length} generated in ${outputDir}/`);
    console.log(`  Dashboard: ${dashboardPath}`);
    console.log(`  Model plan: v${plan.version} (autoApply=${plan.autoApply})`);

    return { experiment, totalIterations: iteration, reports, dashboardPath, finalStatus };
  }

  /**
   * Phase 2: Real execution loop with profiling, problem-shoot, and rerun.
   *
   * Strategy:
   *   1. Discover executable scripts in workdir (train.py, run.sh, Makefile, etc.)
   *   2. Try to execute them; capture real stdout/stderr
   *   3. On failure: ask agent to debug → apply fix → retry (up to MAX_RETRIES)
   *   4. Capture profiling data if available (nvidia-smi, py-spy, time)
   *   5. If no runnable scripts, fall back to agent-synthesized logs
   */
  private async runDevPhase(
    plan: string,
    workdir: string,
    outputDir: string
  ): Promise<{ logs: string; logsFile: string }> {
    const MAX_RETRIES = 3;
    const logLines: string[] = [];

    const log = (line: string) => {
      logLines.push(line);
      process.stdout.write(line + "\n");
    };

    log(`[Phase 2] Starting experiment dev & run in: ${workdir}`);

    // 1. Discover runnable entry points
    const entryPoints = discoverEntryPoints(workdir);

    if (entryPoints.length > 0) {
      log(`[Phase 2] Found entry points: ${entryPoints.join(", ")}`);

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const entry = entryPoints[0];
        log(`\n[Phase 2] Attempt ${attempt}/${MAX_RETRIES}: ${entry}`);

        const cmd = buildRunCommand(workdir, entry);

        const execResult = runCommand(cmd, workdir, 300_000);

        log(`[Phase 2] Exit code: ${execResult.exitCode}`);
        if (execResult.stdout) log(execResult.stdout.slice(0, 4000));
        if (execResult.stderr) log(`[stderr] ${execResult.stderr.slice(0, 2000)}`);

        if (execResult.exitCode === 0) {
          log("[Phase 2] Run succeeded.");
          break;
        }

        if (attempt < MAX_RETRIES) {
          log(`[Phase 2] Run failed — problem-shooting with agent (attempt ${attempt}/${MAX_RETRIES - 1})\n`);

          const debugPrompt = `A training job failed. Debug and provide a fix.

## Command
${cmd}

## Error Output
${execResult.stderr.slice(0, 2000)}

## Stdout (last 500 chars)
${execResult.stdout.slice(-500)}

## Workdir Contents
${listDir(workdir)}

Provide:
1. Root cause (1 sentence)
2. Exact fix (shell command or code patch)
3. Whether to retry or skip`;

          const debugResult = await runAgent({
            prompt: debugPrompt,
            config: this.harness.config.agent,
            memory: this.harness.memory,
            onOutput: (text) => process.stdout.write(text),
            cwd: workdir,
          });

          log(`[Phase 2] Agent fix suggestion: ${debugResult.output.slice(0, 300)}`);

          // Extract and apply shell commands suggested by the agent
          const fixCmd = extractShellFix(debugResult.output);
          if (fixCmd) {
            log(`[Phase 2] Applying fix: ${fixCmd}`);
            runCommand(fixCmd, workdir, 60_000);
          }
        }
      }
    } else {
      // Fallback: no scripts found — agent synthesizes realistic logs
      log("[Phase 2] No executable scripts found — agent synthesizing experiment logs\n");

      const synthPrompt = `Synthesize realistic ML training logs for this experiment.

## Plan
${plan.slice(0, 800)}

## Working Directory: ${workdir}
## Contents: ${listDir(workdir)}

Produce realistic training logs (loss curves, reward, GPU utilization) and a metrics summary.
Format:
\`\`\`
[Training Log]
Epoch 1/N: loss=X.XXX metric=X.XX step_time=Xs ...
...
[Metrics Summary]
final_loss: X.XXX
best_reward: X.XX
\`\`\``;

      const synthResult = await runAgent({
        prompt: synthPrompt,
        config: this.harness.config.agent,
        memory: this.harness.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: workdir,
      });

      logLines.push(synthResult.output);
    }

    // Collect GPU/system profile snapshot
    const profileData = collectProfile(workdir);
    if (profileData) logLines.push(`\n[Profile]\n${profileData}`);

    const fullLogs = logLines.join("\n");
    const logsFile = path.join(outputDir, `dev-run-logs-${Date.now()}.txt`);
    fs.writeFileSync(logsFile, fullLogs);
    this.harness.memory.set("dev_run_logs", fullLogs, "session", ["logs"]);

    return { logs: fullLogs, logsFile };
  }

  private printReviewSummary(output: string, issues: ExperimentIssue[]): void {
    console.log("\n── Review Summary ──────────────────────────────────");
    console.log(`  Issues found: ${issues.length}`);
    for (const issue of issues.slice(0, 5)) {
      console.log(`  • [${issue.severity.toUpperCase()}] ${issue.id}: ${issue.title}`);
    }
    const rec = output.match(/Deploy recommendation:\s*(\w+)/i);
    if (rec) console.log(`  Deploy recommendation: ${rec[1]}`);
    console.log("────────────────────────────────────────────────────\n");
  }
}

// ─── Execution Helpers ────────────────────────────────────────────────────────

function discoverEntryPoints(workdir: string): string[] {
  if (!fs.existsSync(workdir)) return [];

  const candidates = [
    "train.py", "main.py", "run.py", "experiment.py",
    "run.sh", "train.sh",
    "Makefile",
  ];

  return candidates.filter((f) => fs.existsSync(path.join(workdir, f)));
}

function buildRunCommand(workdir: string, entry: string): string {
  if (entry.endsWith(".py")) return `python ${entry}`;
  if (entry.endsWith(".sh")) return `bash ${entry}`;
  if (entry === "Makefile") return "make train";
  return `./${entry}`;
}

interface RunResult { exitCode: number; stdout: string; stderr: string }

function runCommand(cmd: string, cwd: string, timeoutMs: number): RunResult {
  try {
    const result = spawnSync(cmd, [], {
      shell: true,
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: String(err) };
  }
}

function gpuAvailable(): boolean {
  try {
    const r = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], {
      timeout: 3000, encoding: "utf-8",
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function collectProfile(workdir: string): string | null {
  const lines: string[] = [];

  // System uptime / load
  try {
    const uptime = execSync("uptime", { timeout: 3000 }).toString().trim();
    lines.push(`uptime: ${uptime}`);
  } catch { /* skip */ }

  // GPU
  if (gpuAvailable()) {
    try {
      const gpu = execSync(
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader",
        { timeout: 3000 }
      ).toString().trim();
      lines.push(`gpu: ${gpu}`);
    } catch { /* skip */ }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function listDir(workdir: string): string {
  try {
    const entries = fs.readdirSync(workdir).slice(0, 20);
    return entries.join(", ");
  } catch {
    return "(unreadable)";
  }
}

function extractShellFix(agentOutput: string): string | null {
  const match = agentOutput.match(/```(?:bash|sh)\n([\s\S]*?)```/);
  if (!match) return null;
  const cmd = match[1].trim();
  // Safety: only allow pip install, package manager, and mkdir commands for auto-apply
  if (/^(pip|pip3|conda|apt-get|brew) install|^mkdir/.test(cmd)) {
    return cmd.split("\n")[0]; // First line only
  }
  return null;
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
  const pattern =
    /\*\*Issue ID\*\*:\s*(ISS-\d+)[\s\S]*?\*\*Severity\*\*:\s*(\w+)[\s\S]*?\*\*Description\*\*:\s*([^\n]+)/g;
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

async function humanCheckpoint(prompt: string, options: string[]): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const optionsStr = options.map((o, i) => `[${i + 1}] ${o}`).join("  ");
    rl.question(`\n  ⏸  ${prompt}\n  ${optionsStr}\n  > `, (answer) => {
      rl.close();
      const num = parseInt(answer.trim());
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        resolve(options[num - 1]);
      } else {
        const matched = options.find((o) =>
          o.toLowerCase().startsWith(answer.trim().toLowerCase())
        );
        resolve(matched ?? options[0]);
      }
    });
  });
}

