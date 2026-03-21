/**
 * Agent Harness — orchestrates Skills, Memory, Guardrails, Evaluation,
 * MCPs, and Teams.
 *
 * Human "configure the harness" flows:
 *   1. Write skills & guardrails → CLI: m2star config init
 *   2. Edit .m2star/config.json  → JSON file picked up at startup
 *   3. CLI flags override file config
 */

import { HarnessConfig, SkillContext, SkillResult } from "../types.js";
import { createMemoryStore } from "./memory.js";
import { defaultGuardrails } from "./guardrails.js";
import { EvaluationInfra } from "./evaluation.js";
import { SkillRegistry } from "./skills.js";
import { McpRegistry, McpServerConfig, buildMcpRegistry, registerCanonicalMcps } from "./mcps.js";
import { TeamRegistry, CANONICAL_TEAMS } from "./teams.js";
import {
  loadRuntimeConfig,
  mergeWithRuntimeConfig,
  RuntimeConfig,
} from "./config.js";

export { SkillRegistry }      from "./skills.js";
export { createMemoryStore }  from "./memory.js";
export { defaultGuardrails }  from "./guardrails.js";
export { EvaluationInfra }    from "./evaluation.js";
export { McpRegistry }        from "./mcps.js";
export { TeamRegistry }       from "./teams.js";
export type { RuntimeConfig } from "./config.js";

// Re-export builder helpers
export { buildMcpRegistry, registerCanonicalMcps } from "./mcps.js";
export { loadRuntimeConfig, saveRuntimeConfig, initConfig, mergeWithRuntimeConfig } from "./config.js";
export type { McpRuntimeConfig } from "./config.js";

export class AgentHarness {
  readonly config: HarnessConfig;
  readonly skills: SkillRegistry;
  readonly memory: ReturnType<typeof createMemoryStore>;
  readonly eval: EvaluationInfra;
  readonly mcps: McpRegistry;
  readonly teams: TeamRegistry;

  constructor(config?: Partial<HarnessConfig>, configDir?: string) {
    // Load runtime config from file, then merge with programmatic config
    const runtimeCfg: RuntimeConfig = configDir ? loadRuntimeConfig(configDir) : {};
    const merged = mergeWithRuntimeConfig(config ?? {}, runtimeCfg);

    // Build base config, then overlay merged (runtime + programmatic) on top.
    // systemPrompt is always sourced from M2STAR_SYSTEM_PROMPT — never from
    // the runtime JSON config, which doesn't define it.
    this.config = {
      guardrails: defaultGuardrails(),
      memoryDir: ".m2star/memory",
      outputDir: "m2star-output",
      ...merged,
      agent: {
        model: "claude-opus-4-6",
        maxTurns: 20,
        tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        ...(merged.agent ?? {}),
        // Always restore system prompt — runtime config must not blank it out
        systemPrompt: M2STAR_SYSTEM_PROMPT,
      },
    };

    this.skills = new SkillRegistry();
    this.memory = createMemoryStore(this.config.memoryDir);
    this.eval = new EvaluationInfra(this.config.outputDir);

    // MCP registry: load from runtime config + register canonicals
    this.mcps = runtimeCfg.mcps
      ? buildMcpRegistry(runtimeCfg.mcps)
      : new McpRegistry();
    registerCanonicalMcps(this.mcps, process.cwd());

    // Team registry: register all canonical teams
    this.teams = new TeamRegistry(this.skills);
    for (const team of CANONICAL_TEAMS) {
      this.teams.registerTeam(team);
    }
  }

  /** Execute a skill command with full harness context */
  async run(
    command: string,
    input: string,
    onOutput?: (line: string) => void,
    /** Optional: restrict MCP servers to a specific team's subset */
    team?: string
  ): Promise<SkillResult> {
    const mcpServers = team
      ? this.mcps.forTeam(team)
      : this.mcps.all();

    const ctx: SkillContext = {
      input,
      memory: this.memory,
      guardrails: this.config.guardrails,
      workdir: process.cwd(),
      chainDepth: 0,
      // Inject MCPs into agent config for this run
      agentConfig: { ...this.config.agent, mcpServers },
    };

    const start = Date.now();
    const result = await this.skills.run(command, ctx, onOutput);
    const durationMs = Date.now() - start;

    const skillName = command.replace(/^\//, "");
    this.eval.measureSkillRun(skillName, result, durationMs);

    return result;
  }

  /** Get MCP configs for a specific team (for passing to SDK query options) */
  mcpsForTeam(teamName: string): Record<string, unknown> {
    return this.mcps.forTeam(teamName);
  }

  /** Get MCP configs for all teams (for general agent use) */
  allMcps(): Record<string, unknown> {
    return this.mcps.all();
  }
}

const M2STAR_SYSTEM_PROMPT = `You are M2*, an AI agent that builds next-generation ML models through systematic experimentation.

## Your capabilities
- Read docs & logs to understand the current state of experiments
- Learn conventions from existing code and report formats
- Self-review your own code and outputs for quality
- Chain skills together: /exp-plan → /exp-submit → /issue-fix → /issue-report
- Invoke debugging: /job-debug, /job-profile for job-level investigations
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
