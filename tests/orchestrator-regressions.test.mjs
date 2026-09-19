import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

let resultText = "";
let mutationRuns = 0;
const halmos = await import("../dist/verification/halmos-json.js");
const runner = await import("../dist/mutation/runner.js");
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  query: async function* () {
    yield { type: "result", subtype: "success", result: resultText };
  },
} });
mock.module("../dist/verification/halmos-json.js", { namedExports: {
  ...halmos,
  runHalmos: () => ({ outcomes: [{ name: "check_property", verdict: "verified",
    suite: "Property", seconds: 0, normalPaths: 1, totalPaths: 1, failedPaths: 0,
    boundedLoops: 0, counterexamples: [] }],
    verified: 1, violated: 0, vacuous: 0, errored: 0 }),
} });
mock.module("../dist/mutation/runner.js", { namedExports: {
  ...runner,
  cleanBuild: () => {},
  runMutationTesting: () => { mutationRuns++; return {}; },
  formatMutationReport: () => "Mutation audit results",
} });
const { analyze } = await import("../dist/orchestrator.js");

function fixture(t) {
  const project = mkdtempSync(join(tmpdir(), "forge-proof-orchestrator-test-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  writeFileSync(join(project, "foundry.toml"), "[profile.default]\n");
  mkdirSync(join(project, ".forge-proof/test"), { recursive: true });
  writeFileSync(join(project, ".forge-proof/test/Property.t.sol"), "contract Property {}\n");
  return { contractPath: project, outputDir: join(project, "reports") };
}

for (const options of [
  { auditSpec: true },
  { auditSpec: false },
  { auditSpec: false, mutationTest: true },
]) {
  test(`empty agent report is rejected with ${JSON.stringify(options)}`, async (t) => {
    const opts = fixture(t);
    resultText = "";
    await assert.rejects(analyze({ ...opts, ...options }), /Verification produced no report/);
    assert.equal(existsSync(opts.outputDir), false);
  });
}

test("mutation testing runs with the spec audit disabled and preserves the report", async (t) => {
  const opts = fixture(t);
  resultText = "Agent verification report";
  mutationRuns = 0;
  await analyze({ ...opts, auditSpec: false, mutationTest: true });
  assert.equal(mutationRuns, 1);
  const [run] = readdirSync(opts.outputDir);
  const report = readFileSync(join(opts.outputDir, run, "forge-proof-report.md"), "utf8");
  assert.match(report, /Agent verification report/);
  assert.match(report, /Mutation audit results/);
});
