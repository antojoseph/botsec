#!/usr/bin/env node
/**
 * M2* Model Iteration System — CLI
 *
 * Usage:
 *   m2star workflow --goal "improve reward shaping" [--workdir .] [--iterations 3]
 *   m2star skill /exp-plan "Experiment with PPO clipping"
 *   m2star skill /exp-submit "$(cat logs.txt)"
 *   m2star skill /issue-fix "ISS-1: reward collapse at epoch 5"
 *   m2star skill /issue-report
 *   m2star memory list
 *   m2star eval summary
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { AgentHarness } from "./harness/index.js";
import { expPlanSkill } from "./skills/exp-plan.js";
import { expSubmitSkill } from "./skills/exp-submit.js";
import { issueFixSkill } from "./skills/issue-fix.js";
import { issueReportSkill } from "./skills/issue-report.js";
import { RLExperimentWorkflow } from "./workflow/rl-experiment.js";
import type { HarnessConfig } from "./types.js";

const program = new Command();

program
  .name("m2star")
  .description("M2* Model Iteration System — AI-powered ML experiment harness")
  .version("0.1.0");

// ─── Global Options ───────────────────────────────────────────────────────────

program
  .option("--memory-dir <dir>", "Memory storage directory", ".m2star/memory")
  .option("-o, --output-dir <dir>", "Output directory for reports", "m2star-output")
  .option("--max-turns <n>", "Max agent turns per skill", "20")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6")
  .option("--auto-approve", "Skip human checkpoint prompts");

// ─── workflow command ─────────────────────────────────────────────────────────

program
  .command("workflow")
  .description("Run the full 5-phase RL experiment workflow")
  .requiredOption("--goal <text>", "Research goal / experiment description")
  .option("--workdir <dir>", "Working directory with experiment code", ".")
  .option("--iterations <n>", "Max iteration loops", "3")
  .action(async (opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    const workflow = new RLExperimentWorkflow(harness);
    const result = await workflow.run({
      goal: opts.goal,
      workdir: path.resolve(opts.workdir),
      maxIterations: parseInt(opts.iterations),
      autoApprove: globals.autoApprove ?? false,
      outputDir: globals.outputDir ?? "m2star-output",
    });

    console.log(`\n✓ Workflow finished: ${result.finalStatus}`);
    console.log(`  Iterations: ${result.totalIterations}`);
    console.log(`  Reports: ${result.reports.length}`);
  });

// ─── skill command ────────────────────────────────────────────────────────────

program
  .command("skill <command> [input]")
  .description("Run a single skill (e.g. /exp-plan, /exp-submit, /issue-fix, /issue-report)")
  .option("--stdin", "Read input from stdin")
  .action(async (command, input, opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    let skillInput = input ?? "";
    if (opts.stdin) {
      skillInput = fs.readFileSync("/dev/stdin", "utf-8");
    }

    const result = await harness.run(command, skillInput, (text) =>
      process.stdout.write(text)
    );

    if (result.artifacts && Object.keys(result.artifacts).length > 0) {
      const outputDir = globals.outputDir ?? "m2star-output";
      fs.mkdirSync(outputDir, { recursive: true });
      for (const [filename, content] of Object.entries(result.artifacts)) {
        const filePath = path.join(outputDir, filename);
        fs.writeFileSync(filePath, content);
        console.log(`  Saved: ${filePath}`);
      }
    }

    process.exit(result.success ? 0 : 1);
  });

// ─── memory command ───────────────────────────────────────────────────────────

const memoryCmd = program
  .command("memory")
  .description("Inspect persistent memory");

memoryCmd
  .command("list [tier]")
  .description("List all memory entries (tier: session|project|global)")
  .action((tier, opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    const entries = harness.memory.list(tier as "session" | "project" | "global" | undefined);

    if (entries.length === 0) {
      console.log("No memory entries.");
      return;
    }

    console.log(`\n── Memory (${tier ?? "all tiers"}) ──────────────────────────`);
    for (const entry of entries) {
      const val =
        typeof entry.value === "string"
          ? entry.value.slice(0, 80)
          : JSON.stringify(entry.value).slice(0, 80);
      console.log(`  [${entry.tier}] ${entry.key.padEnd(30)} ${val}`);
    }
  });

memoryCmd
  .command("search <query>")
  .description("Search memory entries")
  .action((query, opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    const entries = harness.memory.search(query);
    console.log(`Found ${entries.length} entries for "${query}":`);
    for (const entry of entries) {
      console.log(`  [${entry.tier}] ${entry.key}: ${JSON.stringify(entry.value).slice(0, 100)}`);
    }
  });

// ─── eval command ─────────────────────────────────────────────────────────────

program
  .command("eval")
  .command("summary")
  .description("Print evaluation summary across all skill runs")
  .action((opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    harness.eval.printSummary();
  });

// ─── skills command ───────────────────────────────────────────────────────────

program
  .command("skills")
  .description("List all registered skills")
  .action((opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    console.log("\n── Registered Skills ───────────────────────────────");
    for (const skill of harness.skills.list()) {
      const chain = skill.chainTo?.length
        ? ` → ${skill.chainTo.join(" → ")}`
        : "";
      console.log(`  ${skill.command.padEnd(18)} ${skill.description}${chain}`);
    }
    console.log("────────────────────────────────────────────────────\n");
  });

// ─── Harness builder ──────────────────────────────────────────────────────────

function buildHarness(globals: Record<string, unknown>): AgentHarness {
  const config: Partial<HarnessConfig> = {
    memoryDir: (globals.memoryDir as string | undefined) ?? ".m2star/memory",
    outputDir: (globals.outputDir as string | undefined) ?? "m2star-output",
    agent: {
      model: ((globals.model as string | undefined) ?? "claude-opus-4-6") as HarnessConfig["agent"]["model"],
      maxTurns: parseInt((globals.maxTurns as string | undefined) ?? "20"),
      systemPrompt: "",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    },
  };

  const harness = new AgentHarness(config);

  // Register all skills
  harness.skills.register(expPlanSkill(harness.config.agent));
  harness.skills.register(expSubmitSkill(harness.config.agent));
  harness.skills.register(issueFixSkill(harness.config.agent));
  harness.skills.register(
    issueReportSkill(harness.config.agent, harness.config.outputDir)
  );

  return harness;
}

program.parse();
