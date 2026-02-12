import { execSync } from "child_process";
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

/**
 * Create a temporary Foundry project with the target contract(s) copied in,
 * halmos-cheatcodes installed, and proper remappings configured.
 */
export async function scaffoldFoundryProject(
  contractPath: string
): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-proof-"));

  console.log(`  Scaffolding Foundry project in ${projectDir}`);

  // Initialize Foundry project
  execSync("forge init --no-commit .", {
    cwd: projectDir,
    stdio: "pipe",
  });

  // Remove the default Counter.sol and Counter.t.sol
  const defaultSrc = join(projectDir, "src", "Counter.sol");
  const defaultTest = join(projectDir, "test", "Counter.t.sol");
  const defaultScript = join(projectDir, "script", "Counter.s.sol");
  for (const f of [defaultSrc, defaultTest, defaultScript]) {
    if (existsSync(f)) {
      execSync(`rm ${f}`);
    }
  }

  // Install halmos-cheatcodes
  try {
    execSync("forge install a16z/halmos-cheatcodes --no-commit", {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch {
    console.warn(
      "  Warning: Could not install halmos-cheatcodes. Tests may need manual setup."
    );
  }

  // Copy target contract(s) into src/
  const srcDir = join(projectDir, "src");
  if (contractPath.endsWith(".sol")) {
    // Single file
    copyFileSync(contractPath, join(srcDir, basename(contractPath)));
  } else if (existsSync(contractPath) && statSync(contractPath).isDirectory()) {
    // Directory — recursively copy all .sol files preserving structure
    copyDirRecursive(contractPath, srcDir);
  } else {
    throw new Error(
      `Target path does not exist or is not a .sol file/directory: ${contractPath}`
    );
  }

  // Write remappings.txt
  const remappings = [
    "halmos-cheatcodes/=lib/halmos-cheatcodes/src/",
    "forge-std/=lib/forge-std/src/",
  ].join("\n") + "\n";
  writeFileSync(join(projectDir, "remappings.txt"), remappings);

  // Update foundry.toml to support Halmos
  const foundryToml = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.28"

# Allow FFI for advanced tests
ffi = false

[profile.default.fuzz]
runs = 256
`;
  writeFileSync(join(projectDir, "foundry.toml"), foundryToml);

  // Verify it compiles
  try {
    execSync("forge build", { cwd: projectDir, stdio: "pipe" });
    console.log("  Foundry project compiles successfully.");
  } catch (e: any) {
    console.warn(
      "  Warning: Initial forge build failed. Agents will fix compilation issues."
    );
  }

  return projectDir;
}

/**
 * Recursively copy .sol files from src to dst, preserving directory structure.
 */
function copyDirRecursive(src: string, dst: string): void {
  if (!existsSync(dst)) {
    mkdirSync(dst, { recursive: true });
  }
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      // Skip common non-source directories
      if (["node_modules", ".git", "cache", "out", "artifacts"].includes(entry)) {
        continue;
      }
      copyDirRecursive(srcPath, dstPath);
    } else if (entry.endsWith(".sol")) {
      copyFileSync(srcPath, dstPath);
    }
  }
}
