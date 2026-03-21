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
import { SkillDefinition } from "../types.js";

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
  /**
   * Per-team overrides: only team-specific skills are stored here.
   * Global skills are resolved live from globalRegistry so skills registered
   * after teams are still visible (avoids snapshot-at-construction bug).
   */
  private teamOverrides = new Map<TeamName, SkillRegistry>();
  private globalRegistry: SkillRegistry;

  constructor(globalRegistry: SkillRegistry) {
    this.globalRegistry = globalRegistry;
  }

  registerTeam(team: TeamDefinition): void {
    this.teams.set(team.name, team);

    // Only store team-specific skill overrides, not a full copy of global skills.
    const overrides = new SkillRegistry();
    for (const skill of team.skills) {
      overrides.register(skill);
      // Also register under namespaced command: /rl:exp-plan
      overrides.register({
        ...skill,
        name: `${team.name}:${skill.name}`,
        command: `/${team.name}:${skill.name.replace(/^\//, "")}`,
      });
    }
    this.teamOverrides.set(team.name, overrides);
  }

  /**
   * Returns a SkillRegistry view for the team that resolves:
   *   1. Team-specific skill overrides first
   *   2. Global registry as fallback (live reference — picks up later registrations)
   */
  getRegistry(teamName: TeamName): SkillRegistry {
    const overrides = this.teamOverrides.get(teamName);
    if (!overrides) return this.globalRegistry;

    // Return a proxy registry that checks overrides then falls back to global
    return new TeamScopedRegistry(overrides, this.globalRegistry);
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
    const globalSkillNames = this.globalRegistry.list().map((s) => s.command).join(", ");
    console.log("\n── Teams ───────────────────────────────────────────");
    console.log(`  ${"(all teams)".padEnd(15)} inherits: ${globalSkillNames || "(none yet)"}`);
    for (const team of this.teams.values()) {
      const teamSkillNames = team.skills.map((s) => s.command).join(", ");
      console.log(`  ${team.name.padEnd(15)} ${team.description}`);
      if (teamSkillNames) console.log(`    +skills: ${teamSkillNames}`);
      if (team.mcpNames.length) console.log(`    mcps:    ${team.mcpNames.join(", ")}`);
    }
    console.log("────────────────────────────────────────────────────\n");
  }
}

/**
 * A SkillRegistry view that checks team-specific overrides first,
 * then falls back to the global registry. Uses live references so
 * skills added after team registration are still visible.
 */
class TeamScopedRegistry extends SkillRegistry {
  private overrides: SkillRegistry;
  private global: SkillRegistry;

  constructor(overrides: SkillRegistry, global: SkillRegistry) {
    super();
    this.overrides = overrides;
    this.global = global;
  }

  override get(nameOrCommand: string): SkillDefinition | undefined {
    return this.overrides.get(nameOrCommand) ?? this.global.get(nameOrCommand);
  }

  override list(): SkillDefinition[] {
    const seen = new Set<string>();
    const result: SkillDefinition[] = [];
    for (const skill of [...this.overrides.list(), ...this.global.list()]) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push(skill);
      }
    }
    return result;
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
