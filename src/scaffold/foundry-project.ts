import { execSync } from "child_process";
import {
  mkdtempSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

/** Directory, relative to the project root, where generated Halmos tests live. */
export const FORGE_PROOF_TEST_DIR = ".forge-proof/test";

/**
 * Environment every forge/halmos invocation needs.
 *
 * - FOUNDRY_TEST: forge only compiles files under src/test/script. Generated
 *   tests live in .forge-proof/test/ so they never touch the user's own test
 *   suite, which means the test path has to be pointed at them explicitly or
 *   neither forge nor halmos ever sees the files.
 * - FOUNDRY_DYNAMIC_TEST_LINKING: Foundry >= 1.3 defaults this to true, which
 *   rewrites `new Contract()` inside tests into a `vm.deployCode(string)`
 *   cheatcode. Halmos cannot execute that cheatcode, so setUp() fails with
 *   "No successful path found in setUp()" and every symbolic test errors out.
 */
export const HALMOS_ENV: Record<string, string> = {
  FOUNDRY_TEST: FORGE_PROOF_TEST_DIR,
  FOUNDRY_DYNAMIC_TEST_LINKING: "false",
};

/**
 * Create a temporary Foundry project with the target contract(s) copied in,
 * halmos-cheatcodes installed, and proper remappings configured.
 */
export async function scaffoldFoundryProject(
  contractPath: string
): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), "forge-proof-"));

  console.log(`  Scaffolding Foundry project in ${projectDir}`);

  // Initialize Foundry project. `--no-commit` is a hidden deprecated alias in
  // current Foundry; not committing is now the default, so pass nothing.
  execSync("forge init .", {
    cwd: projectDir,
    stdio: "pipe",
  });

  // Remove the default Counter.sol and Counter.t.sol.
  // Use rmSync rather than shelling out to `rm` — no quoting hazards.
  for (const f of [
    join(projectDir, "src", "Counter.sol"),
    join(projectDir, "test", "Counter.t.sol"),
    join(projectDir, "script", "Counter.s.sol"),
  ]) {
    rmSync(f, { force: true });
  }

  // Install halmos-cheatcodes. Without this every generated test fails to
  // compile, so a failure here must be loud.
  try {
    execSync("forge install a16z/halmos-cheatcodes", {
      cwd: projectDir,
      stdio: "pipe",
    });
  } catch (e: any) {
    throw new Error(
      "Could not install halmos-cheatcodes — every symbolic test would fail to " +
        "compile without it. Check network access to github.com.\n" +
        (e?.stderr?.toString?.().trim() || e?.message || "")
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

  // Create the directory generated Halmos tests go into, so the configured
  // test path always exists even before the verifier writes anything.
  mkdirSync(join(projectDir, FORGE_PROOF_TEST_DIR), { recursive: true });

  // Update foundry.toml to support Halmos.
  //
  // Deliberately NOT pinning solc_version: a hardcoded pin makes every contract
  // with a newer pragma un-analyzable ("No compiler version exists that matches
  // the version requirement"). Foundry resolves the right compiler from the
  // pragma on its own.
  const foundryToml = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "${FORGE_PROOF_TEST_DIR}"

# Halmos cannot execute the vm.deployCode(string) cheatcode that Foundry's
# dynamic test linking rewrites \`new Contract()\` into. Leaving this on makes
# every symbolic test fail in setUp().
dynamic_test_linking = false

# Allow FFI for advanced tests
ffi = false

[profile.default.fuzz]
runs = 256
`;
  writeFileSync(join(projectDir, "foundry.toml"), foundryToml);

  // Verify it compiles
  try {
    execSync("forge build", { cwd: projectDir, stdio: "pipe", env: { ...process.env, ...HALMOS_ENV } });
    console.log("  Foundry project compiles successfully.");
  } catch (e: any) {
    const detail = (e?.stderr?.toString?.() || e?.stdout?.toString?.() || "").trim();
    console.warn(
      "  Warning: Initial forge build failed. Agents will fix compilation issues."
    );
    if (detail) {
      console.warn(detail.split("\n").slice(0, 12).map((l: string) => "    " + l).join("\n"));
    }
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
