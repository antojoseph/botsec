/**
 * Teams Structure — per-team skill registries and MCP scoping.
 *
 * From the diagram: "Teams: Data · Pretrain · RL · Infra · Engineering
 *                   — each builds own skills & MCPs"
 *
 * Each team has:
 *   - Its own SkillRegistry (namespaced: /rl:exp-plan, /data:query, etc.)
 *   - Its own MCP set (filtered from the global McpRegistry)
 *   - Its own AgentHarness instance (shared memory, isolated skills)
 */

import { SkillRegistry } from "./skills.js";
import { McpRegistry, McpServerConfig } from "./mcps.js";
import { MemoryStore, SkillDefinition } from "../types.js";

export type TeamName = "rl" | "pretrain" | "data" | "infra" | "engineering" | string;

export interface TeamDefinition {
  name: TeamName;
  description: string;
  /** Skills specific to this team */
  skills: SkillDefinition[];
  /** MCP names this team uses */
  mcpNames: string[];
}

export class TeamRegistry {
  private teams = new Map<TeamName, TeamDefinition>();
  private skillRegistries = new Map<TeamName, SkillRegistry>();
  private globalRegistry: SkillRegistry;

  constructor(globalRegistry: SkillRegistry) {
    this.globalRegistry = globalRegistry;
  }

  registerTeam(team: TeamDefinition): void {
    this.teams.set(team.name, team);

    const registry = new SkillRegistry();
    // Register global skills first (all teams inherit them)
    for (const skill of this.globalRegistry.list()) {
      registry.register(skill);
    }
    // Register team-specific skills (can override global ones)
    for (const skill of team.skills) {
      // Namespace the command: /exp-plan → /rl:exp-plan (but keep original for global use)
      registry.register(skill);
      registry.register({
        ...skill,
        name: `${team.name}:${skill.name}`,
        command: `/${team.name}:${skill.name.replace(/^\//, "")}`,
      });
    }

    this.skillRegistries.set(team.name, registry);
  }

  getRegistry(teamName: TeamName): SkillRegistry {
    return this.skillRegistries.get(teamName) ?? this.globalRegistry;
  }

  getTeam(teamName: TeamName): TeamDefinition | undefined {
    return this.teams.get(teamName);
  }

  getMcps(teamName: TeamName, mcpRegistry: McpRegistry): Record<string, McpServerConfig> {
    return mcpRegistry.forTeam(teamName);
  }

  list(): TeamDefinition[] {
    return Array.from(this.teams.values());
  }

  listAll(): void {
    console.log("\n── Teams ───────────────────────────────────────────");
    for (const team of this.teams.values()) {
      const skillNames = team.skills.map((s) => s.command).join(", ");
      console.log(`  ${team.name.padEnd(15)} ${team.description}`);
      if (skillNames) console.log(`    skills: ${skillNames}`);
      if (team.mcpNames.length) console.log(`    mcps:   ${team.mcpNames.join(", ")}`);
    }
    console.log("────────────────────────────────────────────────────\n");
  }
}

// ─── Built-in Team Definitions ────────────────────────────────────────────────

/** The RL team runs reward modeling and policy optimization experiments */
export function rlTeam(): TeamDefinition {
  return {
    name: "rl",
    description: "Reward modeling and policy optimization experiments",
    skills: [],  // Skills injected at runtime (exp-plan, exp-submit, etc.)
    mcpNames: ["filesystem", "gitlab", "mini-olap", "canoe", "feishu"],
  };
}

/** The Pretrain team runs large-scale pretraining experiments */
export function pretrainTeam(): TeamDefinition {
  return {
    name: "pretrain",
    description: "Large-scale pretraining and data mixture experiments",
    skills: [],
    mcpNames: ["filesystem", "mini-olap", "canoe", "feishu"],
  };
}

/** The Data team manages datasets, preprocessing, and quality */
export function dataTeam(): TeamDefinition {
  return {
    name: "data",
    description: "Dataset curation, preprocessing, and quality evaluation",
    skills: [],
    mcpNames: ["filesystem", "mini-olap", "canoe"],
  };
}

/** The Infra team manages compute, pipelines, and deployment */
export function infraTeam(): TeamDefinition {
  return {
    name: "infra",
    description: "Compute infrastructure, CI/CD pipelines, and model deployment",
    skills: [],
    mcpNames: ["filesystem", "gitlab", "canoe", "feishu"],
  };
}

/** The Engineering team builds the harness, tools, and integrations */
export function engineeringTeam(): TeamDefinition {
  return {
    name: "engineering",
    description: "Agent harness, tools, evaluations, and MCP integrations",
    skills: [],
    mcpNames: ["filesystem", "gitlab", "feishu"],
  };
}

export const CANONICAL_TEAMS: TeamDefinition[] = [
  rlTeam(),
  pretrainTeam(),
  dataTeam(),
  infraTeam(),
  engineeringTeam(),
];
