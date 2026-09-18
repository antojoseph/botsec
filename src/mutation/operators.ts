/**
 * Mutation operators — deliberate, targeted bug injection.
 *
 * Why this exists: a Halmos `[PASS]` only tells you that no counterexample was
 * found for the property *as written*. A property that asserts nothing, or that
 * constrains something other than what a threat claims, passes exactly the same
 * way a real proof does — the JSON output is byte-identical. No static signal
 * distinguishes them.
 *
 * Mutation testing answers the question empirically: break the contract in a way
 * the spec claims to defend against, and see whether the spec notices. A mutant
 * that survives is proof that the property is decorative.
 *
 * Mutations are located through the solc AST's `src` field ("offset:length:file")
 * so edits are exact, rather than regex-guessing at Solidity syntax.
 *
 * IMPORTANT: solc `src` offsets are BYTE offsets. Solidity sources routinely
 * contain multi-byte UTF-8 (an em-dash in a comment is enough), and JavaScript
 * string indices are UTF-16 code units, so slicing a string by these offsets
 * silently misaligns every edit after the first non-ASCII character. All source
 * handling here is therefore done on Buffers.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type MutationOperator =
  | "require-removal"
  | "comparison-boundary"
  | "arithmetic-swap"
  | "state-write-removal";

export interface Mutation {
  id: string;
  operator: MutationOperator;
  /** Source path relative to the project root, as solc reports it. */
  file: string;
  /** Byte offset into the source file. */
  offset: number;
  length: number;
  original: string;
  replacement: string;
  /** 1-indexed line, for reporting. */
  line: number;
  description: string;
}

interface ASTNode {
  nodeType?: string;
  src?: string;
  [k: string]: any;
}

function walk(node: any, visit: (n: ASTNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node.nodeType) visit(node);
  for (const key of Object.keys(node)) {
    if (key === "nodeType") continue;
    walk(node[key], visit);
  }
}

/** solc `src` is "byteOffset:byteLength:sourceIndex". */
function parseSrc(src?: string): { offset: number; length: number } | undefined {
  if (!src) return undefined;
  const [o, l] = src.split(":");
  const offset = Number(o);
  const length = Number(l);
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return undefined;
  return { offset, length };
}

const NEWLINE = 0x0a;

/** 1-indexed line for a BYTE offset. */
function lineOf(buf: Buffer, offset: number): number {
  let line = 1;
  const end = Math.min(offset, buf.length);
  for (let i = 0; i < end; i++) {
    if (buf[i] === NEWLINE) line++;
  }
  return line;
}

const SEMICOLON = 0x3b;

/**
 * solc reports an ExpressionStatement's range WITHOUT its trailing semicolon.
 * Replacing just that range leaves a stray `;`, which Solidity rejects. Extend
 * the range over trailing whitespace and the semicolon so the statement can be
 * swapped wholesale for an empty block.
 */
function extendOverSemicolon(buf: Buffer, offset: number, length: number): number {
  let end = offset + length;
  while (end < buf.length && (buf[end] === 0x20 || buf[end] === 0x09)) end++;
  if (end < buf.length && buf[end] === SEMICOLON) return end + 1 - offset;
  return length;
}

/** Decode a byte range to text, for display only. */
function sliceText(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString("utf8");
}

/**
 * Comparison boundary shifts. These are the classic off-by-one bugs and they are
 * exactly what a solvency or accounting property should catch.
 */
const COMPARISON_FLIPS: Record<string, string> = {
  ">=": ">",
  "<=": "<",
  ">": ">=",
  "<": "<=",
  "==": "!=",
  "!=": "==",
};

/** Arithmetic inversions — turns a credit into a debit and vice versa. */
const ARITHMETIC_FLIPS: Record<string, string> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
};

export interface EnumerateOptions {
  projectDir: string;
  /** Only mutate sources under this directory (defaults to foundry.toml `src`). */
  srcDir?: string;
}

/**
 * Enumerate candidate mutations for every source contract in the project.
 *
 * Reads the solc AST out of `out/build-info`, so the project must have been
 * built with `forge build --build-info` first.
 */
export function enumerateMutations(opts: EnumerateOptions): Mutation[] {
  const { projectDir } = opts;

  let srcDir = opts.srcDir;
  if (!srcDir) {
    srcDir = "src";
    try {
      const toml = readFileSync(join(projectDir, "foundry.toml"), "utf-8");
      const m = toml.match(/^\s*src\s*=\s*['"]([^'"]+)['"]/m);
      if (m) srcDir = m[1];
    } catch {
      /* default */
    }
  }

  const buildInfoDir = join(projectDir, "out", "build-info");
  if (!existsSync(buildInfoDir)) return [];

  const mutations: Mutation[] = [];
  const seen = new Set<string>();
  const sourceCache = new Map<string, Buffer>();

  // Declaration ids of every state variable across ALL sources. Inherited state
  // lives in a different file from the assignment that writes it, so this must
  // span the whole build, not just the file being walked.
  const stateVarIds = new Set<number>();
  const collectStateVars = (ast: any): void =>
    walk(ast, (n) => {
      if (n.nodeType === "VariableDeclaration" && n.stateVariable && typeof n.id === "number") {
        stateVarIds.add(n.id);
      }
    });

  const readSource = (relPath: string): Buffer | undefined => {
    if (sourceCache.has(relPath)) return sourceCache.get(relPath);
    const abs = join(projectDir, relPath);
    if (!existsSync(abs)) return undefined;
    const buf = readFileSync(abs);
    sourceCache.set(relPath, buf);
    return buf;
  };

  for (const biFile of readdirSync(buildInfoDir)) {
    if (!biFile.endsWith(".json")) continue;
    let buildInfo: any;
    try {
      buildInfo = JSON.parse(readFileSync(join(buildInfoDir, biFile), "utf-8"));
    } catch {
      continue;
    }

    const sources = buildInfo.output?.sources;
    if (!sources) continue;

    // Pass 1: collect state-variable declarations from every source, including
    // libraries and base contracts outside srcDir.
    for (const sourceData of Object.values(sources) as any[]) {
      if (sourceData?.ast) collectStateVars(sourceData.ast);
    }

    for (const [sourcePath, sourceData] of Object.entries(sources) as [string, any][]) {
      // Only mutate first-party sources. Mutating a library or a test would
      // measure nothing about the generated spec.
      if (!sourcePath.startsWith(`${srcDir}/`)) continue;
      const ast = sourceData?.ast;
      if (!ast) continue;

      const buf = readSource(sourcePath);
      if (buf === undefined) continue;

      const add = (m: Omit<Mutation, "id" | "line">): void => {
        // The same construct can appear in several build-info files.
        const key = `${m.file}:${m.offset}:${m.length}:${m.replacement}`;
        if (seen.has(key)) return;
        seen.add(key);
        mutations.push({
          ...m,
          id: `M${String(mutations.length + 1).padStart(3, "0")}`,
          line: lineOf(buf, m.offset),
        });
      };

      walk(ast, (node) => {
        const loc = parseSrc(node.src);
        if (!loc) return;
        const snippet = sliceText(buf, loc.offset, loc.length);

        // 1. require(...) removal — deletes a guard entirely.
        if (
          node.nodeType === "ExpressionStatement" &&
          node.expression?.nodeType === "FunctionCall" &&
          node.expression?.expression?.nodeType === "Identifier" &&
          node.expression.expression.name === "require"
        ) {
          const reqLen = extendOverSemicolon(buf, loc.offset, loc.length);
          add({
            operator: "require-removal",
            file: sourcePath,
            offset: loc.offset,
            length: reqLen,
            original: sliceText(buf, loc.offset, reqLen),
            // An empty block is a valid statement anywhere a statement is
            // allowed. A bare `true;` is NOT valid Solidity and makes every
            // mutant uncompilable.
            replacement: "{}",
            description: `remove guard: ${collapse(snippet)}`,
          });
          return;
        }

        if (node.nodeType === "BinaryOperation" && typeof node.operator === "string") {
          const op: string = node.operator;

          // 2. Comparison boundary shift (off-by-one).
          if (op in COMPARISON_FLIPS) {
            const opLoc = findOperator(buf, node, op);
            if (opLoc !== undefined) {
              add({
                operator: "comparison-boundary",
                file: sourcePath,
                offset: opLoc,
                length: op.length,
                original: op,
                replacement: COMPARISON_FLIPS[op],
                description: `${op} -> ${COMPARISON_FLIPS[op]} in ${collapse(snippet)}`,
              });
            }
            return;
          }

          // 3. Arithmetic inversion.
          if (op in ARITHMETIC_FLIPS) {
            const opLoc = findOperator(buf, node, op);
            if (opLoc !== undefined) {
              add({
                operator: "arithmetic-swap",
                file: sourcePath,
                offset: opLoc,
                length: op.length,
                original: op,
                replacement: ARITHMETIC_FLIPS[op],
                description: `${op} -> ${ARITHMETIC_FLIPS[op]} in ${collapse(snippet)}`,
              });
            }
          }
          return;
        }

        // 4. Drop a state update, simulating a missed accounting write.
        //
        // Covers both compound updates (`x += v`) and plain assignment
        // (`total = total + x`, `owner = msg.sender`). Plain assignments are
        // only mutated when the target resolves to a STATE variable — dropping
        // a local write usually just fails to compile and says nothing about
        // the spec.
        if (
          node.nodeType === "ExpressionStatement" &&
          node.expression?.nodeType === "Assignment" &&
          typeof node.expression.operator === "string" &&
          (node.expression.operator !== "=" ||
            writesStateVariable(node.expression.leftHandSide, stateVarIds))
        ) {
          const stmtLen = extendOverSemicolon(buf, loc.offset, loc.length);
          add({
            operator: "state-write-removal",
            file: sourcePath,
            offset: loc.offset,
            length: stmtLen,
            original: sliceText(buf, loc.offset, stmtLen),
            replacement: "{}",
            description: `drop update: ${collapse(snippet)}`,
          });
        }
      });
    }
  }

  return mutations;
}

/**
 * Blank out comments and string literals, preserving length.
 *
 * The span between two operands can legally contain comments, and a comment may
 * contain the very operator we are searching for:
 *
 *     if (x > /* > *\/ 1)
 *
 * Searching the raw span there lands the edit inside the comment, producing a
 * semantically identical "mutant" that always survives and is then reported as
 * a gap in the spec — a false finding that drags the score down. Masking first
 * leaves only real code for the search.
 */
function maskNonCode(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < out.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "*") {
      out[i] = out[i + 1] = " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < text.length) {
        out[i] = " ";
        if (i + 1 < out.length) out[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      out[i] = " ";
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") {
          out[i] = " ";
          i++;
        }
        if (i < out.length && text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < out.length) out[i] = " ";
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Locate a binary operator's byte offset between its two operands.
 *
 * The AST gives ranges for the operands and the whole expression but not the
 * operator token itself, so search the gap between them. Restricting the search
 * to that gap keeps us from matching an operator inside either operand.
 */
function findOperator(buf: Buffer, node: any, op: string): number | undefined {
  const left = parseSrc(node.leftExpression?.src);
  const right = parseSrc(node.rightExpression?.src);
  if (!left || !right) return undefined;

  const gapStart = left.offset + left.length;
  const gapEnd = right.offset;
  if (gapEnd <= gapStart) return undefined;

  // latin1 keeps one char per byte, so indices into `gap` are byte offsets even
  // when a comment in the span contains multi-byte UTF-8. Comments and strings
  // are masked so an operator appearing inside one is never selected.
  const gap = maskNonCode(buf.subarray(gapStart, gapEnd).toString("latin1"));
  // Prefer the last occurrence: for `a >= b` the gap is " >= ", and for
  // compound tokens searching forward could match a prefix of a longer operator.
  const idx = gap.lastIndexOf(op);
  if (idx === -1) return undefined;

  // Reject a match that is part of a longer operator (e.g. `>` inside `>=`).
  const after = gap[idx + op.length];
  if (after === "=" && !op.endsWith("=")) return undefined;

  return gapStart + idx;
}

/**
 * Does this assignment target resolve to a state variable?
 *
 * Unwraps index and member access so `balances[msg.sender]` and `s.total` both
 * resolve back to the underlying declaration.
 */
function writesStateVariable(lhs: any, stateVarIds: Set<number>): boolean {
  let node = lhs;
  for (let depth = 0; node && depth < 16; depth++) {
    switch (node.nodeType) {
      case "Identifier":
        return (
          typeof node.referencedDeclaration === "number" &&
          stateVarIds.has(node.referencedDeclaration)
        );
      case "IndexAccess":
        node = node.baseExpression;
        break;
      case "IndexRangeAccess":
        node = node.baseExpression;
        break;
      case "MemberAccess":
        node = node.expression;
        break;
      case "TupleExpression":
        node = node.components?.[0];
        break;
      default:
        return false;
    }
  }
  return false;
}

function collapse(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? flat.slice(0, 67) + "..." : flat;
}

/**
 * Apply a mutation to source bytes.
 * Pure: returns the mutated buffer, leaving the caller to write and restore.
 */
export function applyMutation(source: Buffer, m: Mutation): Buffer {
  return Buffer.concat([
    source.subarray(0, m.offset),
    Buffer.from(m.replacement, "utf8"),
    source.subarray(m.offset + m.length),
  ]);
}
