/**
 * M2* Agent — core agent using Claude Agent SDK.
 *
 * Wraps the SDK's query() to provide streaming output, memory injection,
 * and structured result extraction.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig, MemoryStore } from "./types.js";

export interface AgentRunOptions {
  prompt: string;
  config: AgentConfig;
  memory: MemoryStore;
  onOutput?: (text: string) => void;
  cwd?: string;
}

export interface AgentRunResult {
  output: string;
  turns: number;
  memoryUpdates: Record<string, unknown>;
}

/**
 * Run the M2* agent with the given prompt.
 * Streams output tokens and returns the final consolidated text.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { prompt, config, memory, onOutput, cwd } = opts;

  // Inject relevant memory into the system prompt
  const memorySnapshot = memory.snapshot();
  const memoryContext =
    Object.keys(memorySnapshot).length > 0
      ? `\n\n## Institutional Memory\n${JSON.stringify(memorySnapshot, null, 2).slice(0, 2000)}`
      : "";

  const fullPrompt = `${config.systemPrompt}${memoryContext}\n\n---\n\n${prompt}`;

  // Map model names to SDK shortnames
  const modelMap: Record<string, string> = {
    "claude-opus-4-6": "opus",
    "claude-sonnet-4-6": "sonnet",
    "claude-haiku-4-5-20251001": "haiku",
  };
  const sdkModel = modelMap[config.model] ?? "sonnet";

  let fullOutput = "";
  let turns = 0;

  for await (const message of query({
    prompt: fullPrompt,
    options: {
      model: sdkModel as "opus" | "sonnet" | "haiku",
      allowedTools: config.tools as Array<"Read" | "Write" | "Edit" | "Bash" | "Glob" | "Grep">,
      maxTurns: config.maxTurns,
      permissionMode: "bypassPermissions",
      cwd: cwd ?? process.cwd(),
    },
  })) {
    const msg = message as Record<string, unknown>;

    if (msg["type"] === "assistant") {
      const content = (msg["message"] as Record<string, unknown>)?.["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b["type"] === "text" && typeof b["text"] === "string") {
            fullOutput += b["text"];
            onOutput?.(b["text"]);
          }
        }
      }
    }

    if (msg["type"] === "result") {
      turns = (msg["num_turns"] as number | undefined) ?? turns;
      break;
    }
  }

  // Extract memory update directives from output
  const memoryUpdates = extractMemoryUpdates(fullOutput);

  return { output: fullOutput, turns, memoryUpdates };
}

/**
 * Parse memory update directives from agent output.
 * Agent can embed: <!-- MEMORY: key=value --> in its output.
 */
function extractMemoryUpdates(output: string): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const pattern = /<!--\s*MEMORY:\s*([^=\s]+)\s*=\s*(.+?)\s*-->/g;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const [, key, value] = match;
    try {
      updates[key] = JSON.parse(value);
    } catch {
      updates[key] = value;
    }
  }
  return updates;
}
