import { createHash } from "node:crypto";
import { writeFileSync, appendFileSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function sourceInventory(root: string): Array<{ path: string; sha256: string }> {
  const files: Array<{ path: string; sha256: string }> = [];
  function walk(dir = ""): void {
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (["out", "cache", "node_modules", ".git", ".forge-proof"].includes(name)) continue;
      const path = join(dir, name), full = join(root, path), stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path);
      else if (path.endsWith(".sol") || ["foundry.toml", "remappings.txt"].includes(path)) files.push({ path, sha256: digest(readFileSync(full)) });
    }
  }
  walk();
  return files;
}

export function captureJson(directory: string, name: string, value: unknown): void {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

export function captureStage(directory: string, stage: string, before: unknown, after: unknown, durationMs: number): void {
  appendFileSync(join(directory, "synthesis-stages.jsonl"), JSON.stringify({ stage, before, after, durationMs }) + "\n");
}
