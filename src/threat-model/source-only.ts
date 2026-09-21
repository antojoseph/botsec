import { realpathSync, readdirSync, lstatSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/** A benchmark read boundary, applied to the orchestrator and its subagent. */
export function sourceOnlyHook(projectDir: string): HookCallback {
  const root = realpathSync(projectDir);
  function checkTree(dir: string): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Source-only workspace must not contain symlinks");
      if (stat.isDirectory()) checkTree(path);
    }
  }
  checkTree(root);
  return async input => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const args = input.tool_input as Record<string, unknown>;
    let allowed = false;
    if (input.tool_name === "StructuredOutput") allowed = true;
    else if (["Task", "Agent"].includes(input.tool_name)) {
      allowed = args.subagent_type === "threat-modeler" && args.run_in_background !== true;
    } else if (["Read", "Grep", "Glob"].includes(input.tool_name)) {
      const requested = input.tool_name === "Read" ? args.file_path : (args.path ?? root);
      try {
        if (typeof requested !== "string") throw new Error("Missing path");
        const path = realpathSync(resolve(root, requested));
        const rel = relative(root, path);
        allowed = !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../");
        // Glob patterns themselves can contain paths, independently of `path`.
        for (const key of input.tool_name === "Glob" ? ["pattern"] : input.tool_name === "Grep" ? ["glob"] : []) {
          const pattern = args[key];
          if (typeof pattern === "string" && (isAbsolute(pattern) || pattern.includes("..") || pattern.includes("\\"))) allowed = false;
        }
      } catch { allowed = false; }
    }
    return { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      permissionDecisionReason: allowed ? "Source-only workspace access" : "Collection permits only reads inside the prepared workspace and synchronous threat-modeler delegation.",
    } };
  };
}
