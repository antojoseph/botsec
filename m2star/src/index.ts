#!/usr/bin/env node
/**
 * M2* Model Iteration System — CLI
 *
 * Usage:
 *   m2star workflow --goal "improve reward shaping" [--mode autonomous] [--iterations 3]
 *   m2star skill /exp-plan "Experiment with PPO clipping"
 *   m2star skill /exp-submit "$(cat logs.txt)"
 *   m2star skill /issue-fix "ISS-1: reward collapse at epoch 5"
 *   m2star skill /issue-report
 *   m2star skill /job-debug "$(cat error.log)"
 *   m2star skill /job-profile "$(cat profile.txt)"
 *   m2star memory list [session|project|global]
 *   m2star memory search "reward"
 *   m2star eval summary
 *   m2star skills
 *   m2star teams
 *   m2star mcps
 *   m2star config init
 */

import { Command } from "commander";
import path from "path";
import fs from "fs";
import { AgentHarness, initConfig } from "./harness/index.js";
import { expPlanSkill } from "./skills/exp-plan.js";
import { expSubmitSkill } from "./skills/exp-submit.js";
import { issueFixSkill } from "./skills/issue-fix.js";
import { issueReportSkill } from "./skills/issue-report.js";
import { jobDebugSkill } from "./skills/job-debug.js";
import { jobProfileSkill } from "./skills/job-profile.js";
import { RLExperimentWorkflow, WorkflowMode } from "./workflow/rl-experiment.js";
import type { HarnessConfig } from "./types.js";

const program = new Command();

program
  .name("m2star")
  .description("M2* Model Iteration System — AI-powered ML experiment harness")
  .version("0.1.0");

// ─── Global Options ───────────────────────────────────────────────────────────

program
  .option("--config-dir <dir>", "Harness config directory", ".m2star")
  .option("--memory-dir <dir>", "Memory storage directory")
  .option("-o, --output-dir <dir>", "Output directory for reports", "m2star-output")
  .option("--max-turns <n>", "Max agent turns per skill", "20")
  .option("--model <model>", "Claude model to use", "claude-opus-4-6");

// ─── workflow command ─────────────────────────────────────────────────────────

program
  .command("workflow")
  .description("Run the full 5-phase RL experiment workflow")
  .requiredOption("--goal <text>", "Research goal / experiment description")
  .option("--workdir <dir>", "Working directory with experiment code", ".")
  .option("--iterations <n>", "Max iteration loops", "3")
  .option(
    "--mode <mode>",
    "human_guided (checkpoints) or autonomous (agent auto-continues)",
    "human_guided"
  )
  .action(async (opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    const workflow = new RLExperimentWorkflow(harness);
    const result = await workflow.run({
      goal: opts.goal,
      workdir: path.resolve(opts.workdir),
      maxIterations: parseInt(opts.iterations),
      mode: opts.mode as WorkflowMode,
      outputDir: globals.outputDir ?? "m2star-output",
    });

    console.log(`\n✓ Workflow finished: ${result.finalStatus}`);
    console.log(`  Iterations: ${result.totalIterations}`);
    console.log(`  Reports: ${result.reports.length}`);
    if (result.dashboardPath) {
      console.log(`  Dashboard: file://${path.resolve(result.dashboardPath)}`);
    }
  });

// ─── skill command ────────────────────────────────────────────────────────────

program
  .command("skill <command> [input]")
  .description(
    "Run a single skill:\n" +
    "  /exp-plan, /exp-submit, /issue-fix, /issue-report\n" +
    "  /job-debug, /job-profile"
  )
  .option("--stdin", "Read input from stdin")
  .action(async (command, input, opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    let skillInput = input ?? "";
    if (opts.stdin || (!skillInput && !process.stdin.isTTY)) {
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

const memoryCmd = program.command("memory").description("Inspect persistent memory");

memoryCmd
  .command("list [tier]")
  .description("List memory entries (tier: session|project|global)")
  .action((tier, _opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    const entries = harness.memory.list(
      tier as "session" | "project" | "global" | undefined
    );
    if (entries.length === 0) { console.log("No memory entries."); return; }
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
  .action((query, _opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    const entries = harness.memory.search(query);
    console.log(`Found ${entries.length} entries for "${query}":`);
    for (const entry of entries) {
      console.log(
        `  [${entry.tier}] ${entry.key}: ${JSON.stringify(entry.value).slice(0, 100)}`
      );
    }
  });

// ─── eval command ─────────────────────────────────────────────────────────────

program
  .command("eval")
  .description("Evaluation commands")
  .command("summary")
  .description("Print evaluation summary across all skill runs")
  .action((_opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    harness.eval.printSummary();
  });

// ─── skills command ───────────────────────────────────────────────────────────

program
  .command("skills")
  .description("List all registered skills")
  .action((_opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    console.log("\n── Registered Skills ───────────────────────────────");
    for (const skill of harness.skills.list()) {
      const chain = skill.chainTo?.length ? ` → ${skill.chainTo.join(" → ")}` : "";
      console.log(`  ${skill.command.padEnd(18)} ${skill.description}${chain}`);
    }
    console.log("────────────────────────────────────────────────────\n");
  });

// ─── teams command ────────────────────────────────────────────────────────────

program
  .command("teams")
  .description("List all registered teams and their skills/MCPs")
  .action((_opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    harness.teams.listAll();
  });

// ─── mcps command ─────────────────────────────────────────────────────────────

program
  .command("mcps")
  .description("List configured MCP servers")
  .option("--team <name>", "Filter by team")
  .action((opts, cmd) => {
    const globals = cmd.parent?.opts() ?? {};
    const harness = buildHarness(globals);

    const mcps = opts.team
      ? harness.mcps.forTeam(opts.team)
      : harness.mcps.all();

    console.log(`\n── MCP Servers${opts.team ? ` (team: ${opts.team})` : ""} ───────────────────────────`);
    for (const mcp of harness.mcps.list()) {
      if (opts.team && !mcp.teams.includes(opts.team) && !mcp.teams.includes("*")) continue;
      const cfg = mcp.config as Record<string, unknown>;
      const transport =
        "command" in cfg ? `stdio: ${cfg["command"]}` :
        "url" in cfg     ? `http: ${cfg["url"]}` : "unknown";
      console.log(`  ${mcp.name.padEnd(15)} ${mcp.description}`);
      console.log(`    transport: ${transport}`);
      console.log(`    teams: ${mcp.teams.join(", ")}`);
    }
    console.log("────────────────────────────────────────────────────\n");
    void mcps; // suppress unused warning
  });

// ─── config command ───────────────────────────────────────────────────────────

const configCmd = program.command("config").description("Manage harness configuration");

configCmd
  .command("init")
  .description("Create skeleton .m2star/config.json for editing")
  .action((_opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const configDir = globals.configDir ?? ".m2star";
    initConfig(configDir);
  });

configCmd
  .command("show")
  .description("Show resolved harness configuration")
  .action((_opts, cmd) => {
    const globals = cmd.parent?.parent?.opts() ?? {};
    const harness = buildHarness(globals);
    console.log(JSON.stringify(harness.config, null, 2));
  });

// ─── Harness builder ──────────────────────────────────────────────────────────

function buildHarness(globals: Record<string, unknown>): AgentHarness {
  const configDir = (globals.configDir as string | undefined) ?? ".m2star";

  const config: Partial<HarnessConfig> = {
    memoryDir:
      (globals.memoryDir as string | undefined) ?? `${configDir}/memory`,
    outputDir: (globals.outputDir as string | undefined) ?? "m2star-output",
    agent: {
      model: ((globals.model as string | undefined) ??
        "claude-opus-4-6") as HarnessConfig["agent"]["model"],
      maxTurns: parseInt((globals.maxTurns as string | undefined) ?? "20"),
      systemPrompt: "",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    },
  };

  const harness = new AgentHarness(config, configDir);

  // Register all skills
  harness.skills.register(expPlanSkill(harness.config.agent));
  harness.skills.register(expSubmitSkill(harness.config.agent));
  harness.skills.register(issueFixSkill(harness.config.agent));
  harness.skills.register(issueReportSkill(harness.config.agent, harness.config.outputDir));
  harness.skills.register(jobDebugSkill(harness.config.agent));
  harness.skills.register(jobProfileSkill(harness.config.agent));

  return harness;
}

program.parse();
