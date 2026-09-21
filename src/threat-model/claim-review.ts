import { readFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import type { ClaimReview } from "./types.js";

export const CLAIM_CHECKS = ["reachability", "guards-and-rollback", "callback-state", "profit-and-loss"] as const;
const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(text);
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

export const sourceCitationSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, path: { type: "string" },
    startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 }, quote: { type: "string" },
  },
  required: ["id", "path", "startLine", "endLine", "quote"],
};
export const claimAssessmentSchema = {
  type: "object",
  properties: {
    conclusion: { type: "string", enum: ["supported", "unresolved", "contradicted"] },
    executionContext: { type: "string" },
    sourceReferences: { type: "array", items: sourceCitationSchema },
    steps: { type: "array", items: {
      type: "object", properties: { action: { type: "string" }, expectedResult: { type: "string" }, citationIds: { type: "array", items: { type: "string" } } },
      required: ["action", "expectedResult", "citationIds"],
    } },
    checks: { type: "array", items: {
      type: "object", properties: {
        kind: { type: "string", enum: [...CLAIM_CHECKS] }, result: { type: "string", enum: ["supported", "unresolved", "blocked", "not-applicable"] },
        reason: { type: "string" }, citationIds: { type: "array", items: { type: "string" } },
      }, required: ["kind", "result", "reason", "citationIds"],
    } },
    missingEvidence: { type: "array", items: { type: "string" } },
  },
  required: ["conclusion", "executionContext", "sourceReferences", "steps", "checks", "missingEvidence"],
};

/** Read citations only within the project, including resolving symlinks before reading. */
export function reviewClaim(projectDir: string, assessment: unknown): ClaimReview {
  const review: ClaimReview = { status: "needs-review", executionVerified: false, issues: [], sourceReferences: [] };
  if (!object(assessment)) return { ...review, status: "not-assessed", issues: ["No structured claim assessment supplied"] };
  const root = realpathSync(projectDir), ids = new Set<string>();
  const issue = (message: string) => review.issues.push(message);
  if (!["supported", "unresolved", "contradicted"].includes(assessment.conclusion)) issue("Invalid claim conclusion");
  if (assessment.conclusion !== "supported") issue("Generator did not conclude the current-code attack is supported");
  if (!text(assessment.executionContext)) issue("Missing execution context");
  if (!strings(assessment.missingEvidence)) issue("Invalid missing-evidence list");
  else if (assessment.missingEvidence.length) issue("Generator recorded missing evidence");
  const citations = Array.isArray(assessment.sourceReferences) ? assessment.sourceReferences : [];
  if (!citations.length) issue("No source citations");
  for (const c of citations) {
    if (!object(c) || !text(c.id) || !text(c.path)) { issue("Malformed source citation"); continue; }
    const result: ClaimReview["sourceReferences"][number] = { id: c.id, path: c.path, quoteMatches: false };
    review.sourceReferences.push(result);
    if (ids.has(c.id)) issue(`Duplicate citation ID: ${c.id}`);
    ids.add(c.id);
    try {
      if (isAbsolute(c.path) || c.path.split(/[\\/]/).includes("..") || !c.path.endsWith(".sol")) throw new Error();
      const file = realpathSync(resolve(root, c.path)), rel = relative(root, file);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error();
      const bytes = readFileSync(file), lines = bytes.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      result.fileSha256 = createHash("sha256").update(bytes).digest("hex");
      if (!Number.isInteger(c.startLine) || !Number.isInteger(c.endLine) || c.startLine < 1 || c.endLine < c.startLine || c.endLine > lines.length || c.endLine - c.startLine >= 40 || !text(c.quote)) throw new Error();
      result.quoteMatches = lines.slice(c.startLine - 1, c.endLine).join("\n").trim() === c.quote.replace(/\r\n/g, "\n").trim();
      if (!result.quoteMatches) issue(`Source quote does not match its line range: ${c.id}`);
    } catch { issue(`Invalid or unavailable source citation: ${c.id}`); }
  }
  const validRefs = (refs: unknown, required: boolean) => strings(refs) && (!required || refs.length > 0) && refs.every(id => ids.has(id));
  const steps = Array.isArray(assessment.steps) ? assessment.steps : [];
  if (!steps.length) issue("No attack steps");
  for (const step of steps) if (!object(step) || !text(step.action) || !text(step.expectedResult) || !validRefs(step.citationIds, true)) issue("Attack step lacks text or valid source references");
  const checks = Array.isArray(assessment.checks) ? assessment.checks : [];
  for (const kind of CLAIM_CHECKS) {
    const matches = checks.filter((c: unknown) => object(c) && c.kind === kind);
    if (matches.length !== 1) { issue(`Expected exactly one ${kind} check`); continue; }
    const c = matches[0];
    if (!["supported", "unresolved", "blocked", "not-applicable"].includes(c.result) || !text(c.reason) || !validRefs(c.citationIds, c.result !== "not-applicable")) issue(`Incomplete ${kind} check`);
    if (["reachability", "guards-and-rollback"].includes(kind) && c.result === "not-applicable") issue(`${kind} cannot be skipped`);
    if (["unresolved", "blocked"].includes(c.result)) issue(`${kind} is ${c.result}`);
  }
  if (checks.some((c: unknown) => !object(c) || !CLAIM_CHECKS.includes(c.kind))) issue("Unknown claim check");
  if (!review.issues.length) review.status = "citations-checked";
  return review;
}
