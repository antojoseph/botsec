/**
 * Pre-computation module — runs static analysis tools and optionally fetches
 * on-chain data before the threat modeler agent starts.
 *
 * Operates directly on the user's Foundry project (no temp scaffolding).
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import type { PrecomputedAnalysis } from "./types.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function precomputeAnalysis(
  projectDir: string,
  allowNpmInstall = false,
): Promise<PrecomputedAnalysis> {
  projectDir = resolve(projectDir);
  validateFoundryProject(projectDir);

  // Build with --build-info --force to get a single build-info file with all
  // solc ASTs. Without --force, incremental builds produce fragmented build-info
  // files that lack the AST data we need.
  console.log("  Building Foundry project (with build-info for AST)...");
  const biDir = join(projectDir, "out", "build-info");
  try {
    // Remove stale build artifacts to get clean build-info with AST data.
    // Multi-solc incremental builds produce fragmented files without output.sources.
    const outDir = join(projectDir, "out");
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true });
      console.log("  Cleared stale build artifacts.");
    }
    // Install npm dependencies — OPT-IN ONLY.
    //
    // `npm install` executes the target's lifecycle scripts (preinstall/
    // postinstall), which is arbitrary code execution. The whole point of this
    // tool is to be pointed at code you do not trust, so this cannot be the
    // default. Callers opt in with --allow-npm-install.
    const needsNpm =
      existsSync(join(projectDir, "package.json")) &&
      !existsSync(join(projectDir, "node_modules"));

    if (needsNpm && allowNpmInstall) {
      console.log("  Installing npm dependencies (--allow-npm-install)...");
      try {
        execSync("npm install --silent --ignore-scripts", {
          cwd: projectDir,
          timeout: 120_000,
          stdio: "pipe",
        });
      } catch {
        // Non-fatal — forge may still work with lib/ deps
      }
    } else if (needsNpm) {
      console.warn(
        "  Note: target has package.json but no node_modules. Skipping npm install\n" +
          "        (it would run the target's lifecycle scripts). Pass --allow-npm-install\n" +
          "        if you trust this target and the build needs npm dependencies."
      );
    }
    // Capture stderr rather than discarding it — when this fails, the compiler
    // diagnostics are the only useful thing we have.
    execSync("forge build --build-info --force", {
      cwd: projectDir,
      timeout: 600_000,
      maxBuffer: 50 * 1024 * 1024,
      stdio: "pipe",
    });
    const biCount = existsSync(biDir) ? readdirSync(biDir).length : 0;
    console.log(`  Build complete. ${biCount} build-info file(s).`);
  } catch (e: any) {
    // Retry skipping test and script dirs — errors there shouldn't block AST analysis.
    // Read test/script dir names from foundry.toml since they may be non-standard.
    console.warn("  Warning: full build failed, retrying without test/script dirs...");
    let skipDirs = "script test";
    try {
      const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
      const testMatch = toml.match(/^\s*test\s*=\s*['"]([^'"]+)['"]/m);
      const scriptMatch = toml.match(/^\s*script\s*=\s*['"]([^'"]+)['"]/m);
      const dirs = new Set(["script", "test"]);
      if (testMatch) dirs.add(testMatch[1]);
      if (scriptMatch) dirs.add(scriptMatch[1]);
      skipDirs = [...dirs].join(" ");
    } catch { /* use defaults */ }
    try {
      if (existsSync(biDir)) {
        rmSync(biDir, { recursive: true, force: true });
      }
      execSync(
        `forge build --build-info --force --skip ${skipDirs}`,
        { cwd: projectDir, timeout: 600_000, maxBuffer: 50 * 1024 * 1024, stdio: "pipe" }
      );
      const biCount = existsSync(biDir) ? readdirSync(biDir).length : 0;
      console.log(`  Build complete (src only). ${biCount} build-info file(s).`);
    } catch (e2: any) {
      console.warn(`  Warning: forge build failed. Compiler output:`);
      console.warn(indent(buildDiagnostics(e2)));
    }
  }

  // AST analysis, forge inspect, blueprint, and etherscan are now
  // PrecomputeProviders that run after this function returns.
  // They populate the PrecomputedAnalysis via the data field.
  return {
    projectDir,
    abi: {},
    storageLayout: {},
    methodIds: {},
  };
}

// ---------------------------------------------------------------------------
// Build diagnostics
// ---------------------------------------------------------------------------

/**
 * execSync attaches captured output to the thrown error as stdout/stderr
 * buffers. `err.message` alone is just "Command failed", which is useless for
 * diagnosing a Solidity compile error.
 */
function buildDiagnostics(err: any, maxChars = 2000): string {
  const parts = [err?.stderr?.toString?.() ?? "", err?.stdout?.toString?.() ?? ""]
    .map((s: string) => s.trim())
    .filter(Boolean);
  const text = parts.join("\n") || err?.message || "(no output captured)";
  return text.length > maxChars ? text.slice(0, maxChars) + "\n  ...(truncated)" : text;
}

function indent(text: string, pad = "    "): string {
  return text.split("\n").map((l) => pad + l).join("\n");
}

// ---------------------------------------------------------------------------
// Foundry project validation
// ---------------------------------------------------------------------------

function validateFoundryProject(projectDir: string): void {
  if (!existsSync(join(projectDir, "foundry.toml"))) {
    throw new Error(
      `Not a Foundry project: ${projectDir}\n` +
        `  Expected foundry.toml at project root.\n` +
        `  Usage: forge-proof threat-model <path-to-foundry-project>`
    );
  }
}

// ---------------------------------------------------------------------------
// Contract discovery via forge build output
// ---------------------------------------------------------------------------

export function listContracts(projectDir: string): string[] {
  // Prefer scanning the out/ directory so we can filter by source path.
  // Only include contracts whose .sol file is under src/ (not lib/, test/, script/).
  const fromOut = listContractsFromOut(projectDir);
  if (fromOut.length > 0) return fromOut;

  // Fallback: parse forge build --names (includes everything)
  try {
    const output = execSync("forge build --names 2>/dev/null", {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .filter((l) => l.trimStart().startsWith("- "))
      .map((l) => l.trimStart().replace(/^- /, "").trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function listContractsFromOut(projectDir: string): string[] {
  const outDir = join(projectDir, "out");
  if (!existsSync(outDir)) return [];

  // Read foundry.toml to find the source directory (defaults to "src")
  let srcDir = "src";
  try {
    const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
    const srcMatch = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
    if (srcMatch) srcDir = srcMatch[1];
  } catch { /* use default */ }

  // Collect all .sol files under src/ (not lib/, test/, script/)
  const srcSolFiles = new Set<string>();
  collectSolFiles(join(projectDir, srcDir), srcSolFiles);

  const names: string[] = [];
  let skippedCount = 0;
  for (const entry of readdirSync(outDir)) {
    if (entry.endsWith(".sol") && srcSolFiles.has(entry)) {
      const subDir = join(outDir, entry);
      try {
        for (const file of readdirSync(subDir)) {
          if (file.endsWith(".json")) {
            // Skip interfaces and libraries — no executable logic to threat-model
            if (isInterfaceOrLibrary(join(subDir, file))) {
              skippedCount++;
              continue;
            }
            names.push(file.replace(".json", ""));
          }
        }
      } catch { /* skip */ }
    }
  }
  if (skippedCount > 0) {
    console.log(`  Skipped ${skippedCount} interface/library artifact(s).`);
  }
  return names;
}

/**
 * Detect interfaces and libraries from compiled artifacts.
 * - Interfaces: bytecode "0x" (len ≤ 2), no storage entries
 * - Libraries: tiny bytecode (< 500 chars), no storage entries
 * - Abstract storage contracts are KEPT (bytecode "0x" but have storage)
 */
function isInterfaceOrLibrary(artifactPath: string): boolean {
  try {
    const data = JSON.parse(readFileSync(artifactPath, "utf-8"));
    const bytecode: string = data.bytecode?.object || "";
    const storageEntries: number = data.storageLayout?.storage?.length || 0;
    if (storageEntries > 0) return false; // has storage → keep (e.g. abstract storage contracts)
    if (bytecode.length <= 2) return true;  // interface (bytecode "0x" or empty)
    if (bytecode.length < 500) return true; // library (tiny bytecode, no storage)
    return false;
  } catch {
    return false;
  }
}

function collectSolFiles(dir: string, result: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectSolFiles(fullPath, result);
      } else if (entry.endsWith(".sol")) {
        result.add(entry);
      }
    } catch { /* skip */ }
  }
}

