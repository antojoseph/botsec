/**
 * Structured ingestion of Halmos results via `--json-output`.
 *
 * Parsing Halmos' human-readable stdout is brittle (ANSI codes, counterexample
 * blocks that precede their [FAIL] line, wrapped warnings). `--json-output`
 * gives us the same information as data, so results become machine-checkable
 * instead of something an agent narrates in prose.
 *
 * Exit codes and path counts below were established empirically against
 * Halmos 0.3.3; see classify() for what each combination means.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Raw JSON shape
// ---------------------------------------------------------------------------

interface RawModelEntry {
  full_name: string;
  variable_name: string;
  solidity_type: string;
  size_bits: number;
  value: number | string;
}

interface RawTestResult {
  name: string;
  exitcode: number;
  num_models: number;
  models: Array<{ model: Record<string, RawModelEntry>; is_valid: boolean }>;
  /** [total, normal (non-reverting), failed] */
  num_paths?: [number, number, number];
  time: number[];
  num_bounded_loops: number;
}

interface RawHalmosOutput {
  exitcode: number;
  test_results: Record<string, RawTestResult[]>;
}

// ---------------------------------------------------------------------------
// Classified results
// ---------------------------------------------------------------------------

/**
 * `verified`  — property holds on every reachable path. A real (bounded) proof.
 * `violated`  — counterexample found.
 * `vacuous`   — reported no violation, but proved nothing: every path reverted,
 *               so the assertion was never reached. Over-constrained
 *               `vm.assume`s and failing `setUp()` both land here. Counting this
 *               as "verified" is a false assurance, which is the whole reason
 *               this module exists.
 * `error`     — Halmos could not evaluate the test (timeout, solver failure).
 */
export type Verdict = "verified" | "violated" | "vacuous" | "error";

export interface Counterexample {
  variable: string;
  type: string;
  value: string;
}

export interface TestOutcome {
  /** Fully qualified "path:Contract" of the suite. */
  suite: string;
  /** Function signature, e.g. "check_solvency(uint256)". */
  name: string;
  verdict: Verdict;
  totalPaths: number;
  normalPaths: number;
  failedPaths: number;
  boundedLoops: number;
  seconds: number;
  counterexamples: Counterexample[];
  /** Populated for `vacuous` — why we do not trust this as a proof. */
  vacuityReason?: string;
}

export interface HalmosRun {
  outcomes: TestOutcome[];
  verified: number;
  violated: number;
  vacuous: number;
  errored: number;
}

/**
 * Halmos exit codes observed on 0.3.3:
 *   0 — no counterexample found
 *   1 — counterexample found
 *   2 — CLI/usage error (never reaches per-test results)
 *   4 — every path reverted; nothing was actually checked
 */
const EXIT_COUNTEREXAMPLE = 1;
const EXIT_ALL_PATHS_REVERTED = 4;

function classify(t: RawTestResult): { verdict: Verdict; reason?: string } {
  const normalPaths = t.num_paths?.[1] ?? 0;

  if (t.exitcode === EXIT_ALL_PATHS_REVERTED) {
    return {
      verdict: "vacuous",
      reason:
        "every path reverted — the assertion was never reached. Usually " +
        "contradictory vm.assume() constraints or a reverting setUp().",
    };
  }
  if (t.exitcode === EXIT_COUNTEREXAMPLE || t.num_models > 0) {
    return { verdict: "violated" };
  }
  if (t.exitcode === 0) {
    // A clean pass with zero non-reverting paths proved nothing either.
    if (normalPaths === 0) {
      return {
        verdict: "vacuous",
        reason: "no non-reverting path reached the assertion.",
      };
    }
    return { verdict: "verified" };
  }
  return { verdict: "error", reason: `halmos exit code ${t.exitcode}` };
}

/**
 * Quote numeric `value` fields before parsing.
 *
 * Counterexamples are uint256/address values that routinely exceed
 * Number.MAX_SAFE_INTEGER. JSON.parse turns those into floats, so a concrete
 * attack input comes back as 1.8268770466636286e+47 — the wrong digits, which
 * makes the counterexample useless. Quoting them first preserves every digit.
 */
function preserveBigIntegers(raw: string): string {
  return raw.replace(/("value"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g, '$1"$2"');
}

export function parseHalmosJson(raw: string): HalmosRun {
  const data = JSON.parse(preserveBigIntegers(raw)) as RawHalmosOutput;
  const outcomes: TestOutcome[] = [];

  for (const [suite, tests] of Object.entries(data.test_results ?? {})) {
    for (const t of tests) {
      const { verdict, reason } = classify(t);
      const counterexamples: Counterexample[] = [];
      for (const m of t.models ?? []) {
        for (const entry of Object.values(m.model ?? {})) {
          counterexamples.push({
            variable: entry.variable_name,
            type: entry.solidity_type,
            value: String(entry.value),
          });
        }
      }
      outcomes.push({
        suite,
        name: t.name,
        verdict,
        totalPaths: t.num_paths?.[0] ?? 0,
        normalPaths: t.num_paths?.[1] ?? 0,
        failedPaths: t.num_paths?.[2] ?? 0,
        boundedLoops: t.num_bounded_loops ?? 0,
        seconds: Array.isArray(t.time) ? t.time[0] ?? 0 : 0,
        counterexamples,
        vacuityReason: reason,
      });
    }
  }

  return {
    outcomes,
    verified: outcomes.filter((o) => o.verdict === "verified").length,
    violated: outcomes.filter((o) => o.verdict === "violated").length,
    vacuous: outcomes.filter((o) => o.verdict === "vacuous").length,
    errored: outcomes.filter((o) => o.verdict === "error").length,
  };
}

export interface RunHalmosOptions {
  projectDir: string;
  /** Extra environment (FOUNDRY_TEST, FOUNDRY_DYNAMIC_TEST_LINKING, ...). */
  env: Record<string, string>;
  loopBound?: number;
  solverTimeoutMs?: number;
  /** Restrict to one contract, e.g. "^VaultVerification$". */
  matchContract?: string;
  timeoutMs?: number;
}

/**
 * Run Halmos and return classified results.
 *
 * Halmos exits non-zero whenever any test fails, so a non-zero status is not an
 * error here — only the absence of a JSON report is.
 */
export function runHalmos(opts: RunHalmosOptions): HalmosRun {
  const scratch = mkdtempSync(join(tmpdir(), "forge-proof-halmos-"));
  const jsonPath = join(scratch, "halmos.json");

  const args = [
    "--function",
    "check_",
    "--loop",
    String(opts.loopBound ?? 3),
    "--solver-timeout-assertion",
    String(opts.solverTimeoutMs ?? 10_000),
    "--json-output",
    jsonPath,
  ];
  if (opts.matchContract) args.push("--match-contract", opts.matchContract);

  let stdout = "";
  let stderr = "";

  try {
    try {
      stdout = execFileSync("halmos", args, {
        cwd: opts.projectDir,
        env: { ...process.env, ...opts.env },
        stdio: "pipe",
        timeout: opts.timeoutMs ?? 900_000,
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
    } catch (err: any) {
      // Non-zero exit is expected when tests fail; the JSON report is the
      // source of truth. Only a missing report is fatal — but keep the output
      // so we can explain why if it is missing.
      stdout = err?.stdout?.toString?.() ?? "";
      stderr = err?.stderr?.toString?.() ?? "";
    }

    if (!existsSync(jsonPath)) {
      const combined = `${stdout}\n${stderr}`;

      // "No tests matched" is a legitimate outcome, not a failure: a suite may
      // contain only fuzz tests, or every check_ function may have been renamed.
      // Throwing here would abort a spec audit over an empty test set.
      if (/No tests with/i.test(combined)) {
        return {
          outcomes: [],
          verified: 0,
          violated: 0,
          vacuous: 0,
          errored: 0,
        };
      }

      // Otherwise surface what halmos actually said; the usual cause (artifacts
      // missing their `ast` field) is only visible in its output.
      const detail = combined.trim().split("\n").slice(-6).join("\n");
      throw new Error(
        "halmos produced no JSON report — it failed before running any test.\n" +
          (detail ? detail : "(no output captured)")
      );
    }
    return parseHalmosJson(readFileSync(jsonPath, "utf-8"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Human-readable one-line summary. */
export function summarize(run: HalmosRun): string {
  return (
    `${run.verified} verified, ${run.violated} violated, ` +
    `${run.vacuous} vacuous, ${run.errored} errored`
  );
}
