import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeFromAST } from "../dist/threat-model/ast-analysis.js";
import { parseHalmosJson } from "../dist/verification/halmos-json.js";
import { dedupProvider } from "../dist/threat-model/providers/filters/dedup.js";
import { threatModelerAgent } from "../dist/agents/threat-modeler.js";

test("operation order visits nested calls before their enclosing call and inside guards", (t) => {
  const project = mkdtempSync(join(tmpdir(), "forge-proof-ast-test-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, "out/build-info"), { recursive: true });
  writeFileSync(join(project, "foundry.toml"), '[profile.default]\nsrc = "contracts"\n');
  let id = 0;
  const node = (nodeType, fields = {}) => ({ id: ++id, nodeType, ...fields });
  const call = (name, args = []) => node("FunctionCall", {
    expression: node("Identifier", { name }), arguments: args,
  });
  const stmt = (expression) => node("ExpressionStatement", { expression });
  const nested = call("outer", [call("inner")]);
  const guarded = call("require", [node("FunctionCall", {
    expression: node("MemberAccess", { memberName: "send" }), arguments: [],
  })]);
  const body = node("Block", { statements: [
    node("UncheckedBlock", { statements: [stmt(nested)] }),
    stmt(guarded),
    node("DoWhileStatement", { body: node("Block", { statements: [stmt(call("inLoop"))] }) }),
    node("TryStatement", { externalCall: call("attempt"), clauses: [
      { block: node("Block", { statements: [stmt(call("onSuccess"))] }) },
      { block: node("Block", { statements: [stmt(call("onFailure"))] }) },
    ] }),
  ] });
  const ast = node("SourceUnit", { nodes: [node("ContractDefinition", {
    name: "Target", contractKind: "contract", nodes: [node("FunctionDefinition", {
      name: "exercise", visibility: "external", body,
    })],
  })] });
  writeFileSync(join(project, "out/build-info/fixture.json"), JSON.stringify({
    output: { sources: { "contracts/Target.sol": { ast } } },
  }));
  const steps = analyzeFromAST(project).operationOrder["Target.exercise"];
  assert.deepEqual(steps.map(({ target }) => target), [
    "inner", "outer", "external.send", "loop", "inLoop", "try", "attempt", "onSuccess", "onFailure",
  ]);
  assert.equal(steps[2].type, "external-call");
  assert.match(threatModelerAgent({ projectDir: project }).prompt,
    new RegExp(`${project}/contracts/`));
});

test("deduplication includes each original description once", () => {
  const threats = ["Low", "Critical", "Critical"].map((severity, i) => ({
    severity, description: `unique-description-${i}`, category: "reentrancy",
    affectedCode: ["Target.withdraw"], suggestedProperties: [`property-${i}`],
  }));
  const result = dedupProvider.apply(threats, {});
  assert.equal(result.length, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal(result[0].description.split(`unique-description-${i}`).length - 1, 1);
  }
  assert.equal(result[0].suggestedProperties.length, 3);
});

test("Halmos handles missing path counts without inventing a proof", () => {
  const run = parseHalmosJson(JSON.stringify({ test_results: { Target: [
    { name: "check_missing", exitcode: 0 },
    { name: "check_error", exitcode: 2 },
    { name: "check_pass", exitcode: 0, num_paths: [1, 1, 0] },
    { name: "check_fail", exitcode: 1 },
  ] } }));
  assert.deepEqual(run.outcomes.map(({ verdict }) => verdict), ["vacuous", "error", "verified", "violated"]);
});
