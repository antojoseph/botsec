/**
 * MCP Registry — Model Context Protocol server management.
 *
 * Maps the diagram's MCPs (Canoe, mini-olap, Feishu, GitLab) to concrete
 * SDK-compatible configurations.
 *
 * The SDK supports three MCP transport types:
 *   stdio  — subprocess with stdin/stdout (e.g. npx @modelcontextprotocol/server-gitlab)
 *   http   — HTTP endpoint (e.g. hosted mini-olap service)
 *   sse    — Server-Sent Events endpoint
 *
 * MCPs are per-team: each team registers what it needs.
 */

import type { McpRuntimeConfig } from "./config.js";

// SDK MCP config types mirrored from sdk.d.ts
export type McpStdioConfig = { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> };
export type McpHttpConfig  = { type: "http";  url: string; headers?: Record<string, string> };
export type McpSseConfig   = { type: "sse";   url: string; headers?: Record<string, string> };
export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig;

export interface RegisteredMcp {
  name: string;
  description: string;
  config: McpServerConfig;
  teams: string[];
}

export class McpRegistry {
  private servers = new Map<string, RegisteredMcp>();

  register(mcp: RegisteredMcp): void {
    this.servers.set(mcp.name, mcp);
  }

  /** Get MCP configs for a given team, formatted for the SDK's mcpServers option */
  forTeam(team: string): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    for (const mcp of this.servers.values()) {
      if (mcp.teams.includes(team) || mcp.teams.includes("*")) {
        result[mcp.name] = mcp.config;
      }
    }
    return result;
  }

  /** Get all MCP configs regardless of team */
  all(): Record<string, McpServerConfig> {
    const result: Record<string, McpServerConfig> = {};
    for (const [name, mcp] of this.servers.entries()) {
      result[name] = mcp.config;
    }
    return result;
  }

  list(): RegisteredMcp[] {
    return Array.from(this.servers.values());
  }
}

// ─── Built-in MCP Definitions ─────────────────────────────────────────────────

/**
 * Filesystem MCP — read experiment artifacts, logs, code
 * Uses @modelcontextprotocol/server-filesystem
 */
export function filesystemMcp(rootDir: string = "."): RegisteredMcp {
  return {
    name: "filesystem",
    description: "Read experiment logs, artifacts, and source code",
    teams: ["*"],
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", rootDir],
    },
  };
}

/**
 * GitLab MCP — read/create MRs, issues, pipelines
 * Uses @modelcontextprotocol/server-gitlab
 * Requires: GITLAB_TOKEN, GITLAB_URL env vars
 */
export function gitlabMcp(token?: string, url?: string): RegisteredMcp {
  return {
    name: "gitlab",
    description: "GitLab MR/issue/pipeline integration",
    teams: ["rl", "infra", "engineering"],
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: {
        GITLAB_TOKEN: token ?? process.env["GITLAB_TOKEN"] ?? "",
        GITLAB_URL: url ?? process.env["GITLAB_URL"] ?? "https://gitlab.com",
      },
    },
  };
}

/**
 * Mini-OLAP MCP — analytics and metric querying over experiment results.
 * Backed by a local SQLite database of experiment runs.
 * HTTP endpoint: can be started with `m2star mcp start mini-olap`
 */
export function miniOlapMcp(endpoint: string = "http://localhost:7432"): RegisteredMcp {
  return {
    name: "mini-olap",
    description: "Query experiment metrics and historical runs",
    teams: ["rl", "pretrain", "data"],
    config: {
      type: "http",
      url: `${endpoint}/mcp`,
      headers: { "Content-Type": "application/json" },
    },
  };
}

/**
 * Feishu (Lark) MCP — send notifications, post to channels, read docs.
 * HTTP-based via Feishu Bot webhook.
 * Requires: FEISHU_WEBHOOK env var
 */
export function feishuMcp(webhook?: string): RegisteredMcp {
  const webhookUrl = webhook ?? process.env["FEISHU_WEBHOOK"] ?? "";
  return {
    name: "feishu",
    description: "Send notifications and reports to Feishu (Lark) channels",
    teams: ["*"],
    config: {
      type: "http",
      url: webhookUrl || "http://localhost:7433/mcp",  // fallback to local stub
      headers: { "Content-Type": "application/json" },
    },
  };
}

/**
 * Canoe MCP — internal experiment tracking platform.
 * Stub: replace url with actual Canoe endpoint.
 * Requires: CANOE_API_KEY env var
 */
export function canoeMcp(endpoint?: string): RegisteredMcp {
  return {
    name: "canoe",
    description: "Canoe experiment tracking: log runs, compare metrics, tag models",
    teams: ["rl", "pretrain", "data", "infra"],
    config: {
      type: "http",
      url: endpoint ?? process.env["CANOE_ENDPOINT"] ?? "http://localhost:7434/mcp",
      headers: {
        Authorization: `Bearer ${process.env["CANOE_API_KEY"] ?? ""}`,
        "Content-Type": "application/json",
      },
    },
  };
}

/** Build an McpRegistry from runtime config entries */
export function buildMcpRegistry(mcpConfigs: McpRuntimeConfig[]): McpRegistry {
  const registry = new McpRegistry();

  for (const cfg of mcpConfigs) {
    let config: McpServerConfig;

    if (cfg.type === "stdio") {
      if (!cfg.command) continue;
      config = { command: cfg.command, args: cfg.args, env: cfg.env };
    } else if (cfg.type === "http") {
      if (!cfg.url) continue;
      config = { type: "http", url: cfg.url, headers: cfg.headers };
    } else if (cfg.type === "sse") {
      if (!cfg.url) continue;
      config = { type: "sse", url: cfg.url, headers: cfg.headers };
    } else {
      continue;
    }

    registry.register({
      name: cfg.name,
      description: cfg.description ?? cfg.name,
      teams: cfg.teams ?? ["*"],
      config,
    });
  }

  return registry;
}

/** Add the five canonical M2* MCPs to a registry */
export function registerCanonicalMcps(
  registry: McpRegistry,
  workdir: string = "."
): void {
  registry.register(filesystemMcp(workdir));
  registry.register(gitlabMcp());
  registry.register(miniOlapMcp());
  registry.register(feishuMcp());
  registry.register(canoeMcp());
}
