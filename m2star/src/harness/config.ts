/**
 * Runtime Harness Configuration — JSON file-based guardrail and harness config.
 *
 * Humans can write/edit .m2star/config.json to configure the harness
 * without touching TypeScript. Loaded on every harness instantiation.
 *
 * Example .m2star/config.json:
 * {
 *   "guardrails": {
 *     "maxChainDepth": 8,
 *     "escalateBelow": 0.5,
 *     "escalationKeywords": ["i'm not sure", "unclear"],
 *     "allowDestructive": false
 *   },
 *   "agent": {
 *     "model": "claude-sonnet-4-6",
 *     "maxTurns": 30
 *   },
 *   "teams": ["rl", "pretrain", "data", "infra", "engineering"]
 * }
 */

import fs from "fs";
import path from "path";
import { GuardrailsConfig, HarnessConfig } from "../types.js";
import { defaultGuardrails } from "./guardrails.js";

export interface RuntimeConfig {
  guardrails?: Partial<GuardrailsConfig>;
  agent?: Partial<HarnessConfig["agent"]>;
  teams?: string[];
  mcps?: McpRuntimeConfig[];
}

export interface McpRuntimeConfig {
  name: string;
  type: "stdio" | "http" | "sse";
  /** For stdio MCPs */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For http/sse MCPs */
  url?: string;
  headers?: Record<string, string>;
  /** Human-readable description */
  description?: string;
  /** Which teams can use this MCP */
  teams?: string[];
}

const CONFIG_FILENAME = "config.json";

export function loadRuntimeConfig(configDir: string): RuntimeConfig {
  const configPath = path.join(configDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) return {};

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as RuntimeConfig;
  } catch (err) {
    console.warn(`[m2star] Warning: could not parse ${configPath}: ${err}`);
    return {};
  }
}

export function saveRuntimeConfig(configDir: string, config: RuntimeConfig): void {
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, CONFIG_FILENAME);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function mergeWithRuntimeConfig(
  base: Partial<HarnessConfig>,
  runtime: RuntimeConfig
): Partial<HarnessConfig> {
  const merged: Partial<HarnessConfig> = { ...base };

  if (runtime.guardrails) {
    merged.guardrails = {
      ...defaultGuardrails(),
      ...(base.guardrails ?? {}),
      ...runtime.guardrails,
    };
  }

  if (runtime.agent) {
    merged.agent = {
      model: "claude-opus-4-6",
      maxTurns: 20,
      systemPrompt: "",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
      ...(base.agent ?? {}),
      ...runtime.agent,
    };
  }

  return merged;
}

/** Write a skeleton config file for humans to edit */
export function initConfig(configDir: string): void {
  const existing = loadRuntimeConfig(configDir);
  if (Object.keys(existing).length > 0) {
    console.log(`Config already exists at ${configDir}/config.json`);
    return;
  }

  const skeleton: RuntimeConfig = {
    guardrails: {
      maxChainDepth: 5,
      escalateBelow: 0.4,
      escalationKeywords: [
        "i'm not sure",
        "uncertain",
        "unclear",
        "cannot determine",
        "need clarification",
      ],
      allowDestructive: false,
    },
    agent: {
      model: "claude-opus-4-6",
      maxTurns: 20,
    },
    teams: ["rl", "pretrain", "data", "infra", "engineering"],
    mcps: [
      {
        name: "filesystem",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        description: "Local filesystem access for reading experiment artifacts",
        teams: ["rl", "data"],
      },
      {
        name: "gitlab",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-gitlab"],
        env: { GITLAB_TOKEN: "${GITLAB_TOKEN}", GITLAB_URL: "${GITLAB_URL}" },
        description: "GitLab MR/issue integration",
        teams: ["rl", "infra", "engineering"],
      },
    ],
  };

  saveRuntimeConfig(configDir, skeleton);
  console.log(`✓ Created ${configDir}/config.json — edit to configure harness`);
}
