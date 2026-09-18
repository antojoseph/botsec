/**
 * Mutation testing runner — scores how much the generated spec actually proves.
 *
 * Procedure:
 *   1. Establish a baseline: run the generated check_ suite against the pristine
 *      contract and record which properties hold.
 *   2. For each mutant: inject the bug, rebuild, re-run the suite.
 *        - some baseline-passing property now fails  -> mutant KILLED
 *        - every property still passes               -> mutant SURVIVED
 *   3. Score = killed / (killed + survived).
 *
 * A surviving mutant is a concrete, reproducible demonstration that the spec
 * does not constrain the behaviour it claims to. That is far stronger evidence
 * than any confidence score a model can assign to its own work.
 *
 * This phase costs no model tokens — it is forge and halmos only.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyMutation,
  enumerateMutations,
  type Mutation,
  type MutationOperator,
} from "./operators.js";
import { runHalmos, type HalmosRun } from "../verification/halmos-json.js";

export interface MutationRunOptions {
  projectDir: string;
  env: Record<string, string>;
  loopBound?: number;
  solverTimeoutMs?: number;
  /** Cap on mutants actually executed. Each costs a rebuild plus a halmos run. */
  maxMutants?: number;
  /** Per-mutant halmos timeout. */
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

export type MutantStatus = "killed" | "survived" | "build-failed" | "skipped";

export interface MutantResult {
  mutation: Mutation;
  status: MutantStatus;
  /** Properties that caught this mutant. */
  killedBy: string[];
  seconds: number;
}

export interface MutationReport {
  /** Properties that held on the pristine contract — the ones under test here. */
  baselineVerified: string[];
  results: MutantResult[];
  killed: number;
  survived: number;
  buildFailed: number;
  /** killed / (killed + survived); undefined when nothing ran. */
  score?: number;
  /** Properties that killed no mutant at all. */
  ineffectiveProperties: string[];
}

/** Halmos verdicts that count as "the property is holding". */
function holdingProperties(run: HalmosRun): Set<string> {
  return new Set(
    run.outcomes.filter((o) => o.verdict === "verified").map((o) => o.name)
  );
}

/**
 * Rebuild for a Halmos run.
 *
 * `--ast` is required: Halmos reads the `ast` field out of each artifact JSON,
 * and a plain `forge build` omits it. Building without it leaves artifacts that
 * Halmos skips with "KeyError: 'ast'", after which it reports "No tests" and
 * writes no JSON report — which looks like a mutant killing every property
 * rather than a broken build.
 *
 * (Distinct from build-info AST, which mutation enumeration needs and which
 * comes from `--build-info`. The two flags populate different files.)
 */
function build(projectDir: string, env: Record<string, string>): void {
  execFileSync("forge", ["build", "--ast"], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Produce build-info containing solc ASTs, which mutation enumeration needs.
 *
 * `--build-info` alone is correct here. Counterintuitively, adding `--ast`
 * yields build-info with NO ast field at all (verified on Foundry 1.8.3:
 * `--build-info` -> 28 sources with AST, `--build-info --ast` -> 0), so do not
 * "fix" this by adding the flag that sounds right.
 */
function buildWithAst(projectDir: string, env: Record<string, string>): void {
  execFileSync("forge", ["build", "--build-info", "--force"], {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Prefer mutants that exercise different operators and different functions, so
 * a small budget still produces a representative score rather than ten variants
 * of the same comparison.
 */
function diversify(mutations: Mutation[], limit: number): Mutation[] {
  const byOperator = new Map<MutationOperator, Mutation[]>();
  for (const m of mutations) {
    const list = byOperator.get(m.operator) ?? [];
    list.push(m);
    byOperator.set(m.operator, list);
  }
  const queues = [...byOperator.values()];
  const picked: Mutation[] = [];
  let i = 0;
  while (picked.length < limit && queues.some((q) => q.length > 0)) {
    const q = queues[i % queues.length];
    const next = q.shift();
    if (next) picked.push(next);
    i++;
  }
  return picked;
}

export function runMutationTesting(opts: MutationRunOptions): MutationReport {
  const { projectDir, env } = opts;
  const log = opts.onProgress ?? (() => {});
  const maxMutants = opts.maxMutants ?? 10;

  // --- Baseline -----------------------------------------------------------
  log("  Establishing baseline (pristine contract)...");
  const baseline = runHalmos({
    projectDir,
    env,
    loopBound: opts.loopBound,
    solverTimeoutMs: opts.solverTimeoutMs,
    timeoutMs: opts.timeoutMs,
  });
  const baselineHolding = holdingProperties(baseline);

  const report: MutationReport = {
    baselineVerified: [...baselineHolding],
    results: [],
    killed: 0,
    survived: 0,
    buildFailed: 0,
    ineffectiveProperties: [],
  };

  if (baselineHolding.size === 0) {
    log(
      "  No property holds on the pristine contract — nothing to mutation-test.\n" +
        "  (Mutation testing measures whether PASSING properties are meaningful.)"
    );
    return report;
  }
  log(`  Baseline: ${baselineHolding.size} verified propert(ies) under test.`);

  // Mutation enumeration reads solc ASTs out of out/build-info, which a plain
  // `forge build` does not emit.
  try {
    buildWithAst(projectDir, env);
  } catch {
    log("  Could not produce build-info for AST enumeration — skipping mutation testing.");
    return report;
  }

  const all = enumerateMutations({ projectDir });
  if (all.length === 0) {
    log("  No mutable constructs found in src/ — skipping.");
    return report;
  }
  const chosen = diversify(all, maxMutants);
  log(`  ${all.length} candidate mutation(s); running ${chosen.length}.`);

  // Track which properties ever catch anything.
  const killers = new Set<string>();

  // --- Mutants ------------------------------------------------------------
  for (const [i, mutation] of chosen.entries()) {
    const absPath = join(projectDir, mutation.file);
    const pristine = readFileSync(absPath); // Buffer: solc offsets are byte offsets
    const started = Date.now();
    let status: MutantStatus = "skipped";
    let killedBy: string[] = [];

    try {
      writeFileSync(absPath, applyMutation(pristine, mutation));

      try {
        build(projectDir, env);
      } catch {
        // An uncompilable mutant is not evidence about the spec.
        status = "build-failed";
        report.buildFailed++;
        log(`  [${i + 1}/${chosen.length}] ${mutation.id} build-failed (${mutation.operator})`);
        continue;
      }

      let mutated;
      try {
        mutated = runHalmos({
          projectDir,
          env,
          loopBound: opts.loopBound,
          solverTimeoutMs: opts.solverTimeoutMs,
          timeoutMs: opts.timeoutMs,
        });
      } catch (err: any) {
        // One unruly mutant must not abort the whole campaign; the finally
        // block below still restores the source either way.
        status = "skipped";
        log(
          `  [${i + 1}/${chosen.length}] ${mutation.id} skipped — ` +
            `${err.message?.split("\n")[0] ?? err}`
        );
        continue;
      }
      const stillHolding = holdingProperties(mutated);

      // Killed when any property that held on the pristine contract stops holding.
      killedBy = [...baselineHolding].filter((name) => !stillHolding.has(name));

      if (killedBy.length > 0) {
        status = "killed";
        report.killed++;
        for (const k of killedBy) killers.add(k);
        log(
          `  [${i + 1}/${chosen.length}] ${mutation.id} KILLED by ${killedBy.length} propert(ies)` +
            ` — ${mutation.operator} @ ${mutation.file}:${mutation.line}`
        );
      } else {
        status = "survived";
        report.survived++;
        log(
          `  [${i + 1}/${chosen.length}] ${mutation.id} SURVIVED` +
            ` — ${mutation.operator} @ ${mutation.file}:${mutation.line}: ${mutation.description}`
        );
      }
    } finally {
      // Always restore, even if halmos threw or the process is interrupted
      // mid-run; leaving a mutated contract on disk would be far worse than a
      // failed run.
      writeFileSync(absPath, pristine);
    }

    report.results.push({
      mutation,
      status,
      killedBy,
      seconds: (Date.now() - started) / 1000,
    });
  }

  // Restore build artifacts to match the pristine sources.
  try {
    build(projectDir, env);
  } catch {
    /* the caller's next step will surface any build problem */
  }

  const scored = report.killed + report.survived;
  if (scored > 0) report.score = report.killed / scored;
  report.ineffectiveProperties = [...baselineHolding].filter((p) => !killers.has(p));

  return report;
}

/** Render the report as Markdown for inclusion in the audit output. */
export function formatMutationReport(r: MutationReport): string {
  if (r.results.length === 0 && r.baselineVerified.length === 0) {
    return "## SPEC STRENGTH\n\nNot run — no properties held on the pristine contract.\n";
  }

  const pct = r.score === undefined ? "n/a" : `${Math.round(r.score * 100)}%`;
  const lines = [
    "## SPEC STRENGTH (mutation testing)",
    "",
    `**Mutation score: ${pct}** — ${r.killed} killed, ${r.survived} survived` +
      (r.buildFailed ? `, ${r.buildFailed} uncompilable (excluded)` : ""),
    "",
    "Injected bugs into the contract and re-ran the verified properties. A",
    "surviving mutant is a bug the spec does not detect.",
    "",
  ];

  const survivors = r.results.filter((x) => x.status === "survived");
  if (survivors.length > 0) {
    lines.push("### Survived — gaps in the spec", "");
    for (const s of survivors) {
      lines.push(
        `- **${s.mutation.id}** \`${s.mutation.file}:${s.mutation.line}\` ` +
          `(${s.mutation.operator}) — ${s.mutation.description}`
      );
    }
    lines.push("");
  }

  const killed = r.results.filter((x) => x.status === "killed");
  if (killed.length > 0) {
    lines.push("### Killed — genuinely constrained", "");
    for (const k of killed) {
      lines.push(
        `- **${k.mutation.id}** \`${k.mutation.file}:${k.mutation.line}\` ` +
          `(${k.mutation.operator}) — caught by ${k.killedBy.join(", ")}`
      );
    }
    lines.push("");
  }

  if (r.ineffectiveProperties.length > 0) {
    lines.push(
      "### Properties that caught nothing",
      "",
      "These passed on the pristine contract but detected none of the injected",
      "bugs. They may be vacuous, or simply unrelated to the mutations tried:",
      ""
    );
    for (const p of r.ineffectiveProperties) lines.push(`- \`${p}\``);
    lines.push("");
  }

  return lines.join("\n");
}
