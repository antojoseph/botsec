/**
 * /issue-fix — Issue Fix Skill (Phase 5, AI)
 *
 * Given issue descriptions from /exp-submit, generates concrete code
 * fixes with explanations. Auto-chains to /issue-report.
 */

import path from "path";
import { SkillDefinition, SkillContext, SkillResult, ExperimentIssue } from "../types.js";
import { runAgent } from "../agent.js";

export function issueFixSkill(agentConfig: Parameters<typeof runAgent>[0]["config"]): SkillDefinition {
  return {
    name: "issue-fix",
    command: "/issue-fix",
    description: "Generate code fixes for issues found during experiment analysis",
    chainTo: ["issue-report"],
    handler: async (ctx: SkillContext): Promise<SkillResult> => {
      const expResults = ctx.memory.get("last_exp_results") as string | undefined;
      const prompt = buildFixPrompt(ctx.input, expResults);

      const result = await runAgent({
        prompt,
        config: ctx.agentConfig ?? agentConfig,
        memory: ctx.memory,
        onOutput: (text) => process.stdout.write(text),
        cwd: ctx.workdir,
      });

      // Parse and persist fixes
      const fixes = parseFixes(result.output);
      ctx.memory.set("pending_fixes", fixes, "project", ["fixes", "issues"]);
      ctx.memory.set("last_issue_fix", result.output, "project", ["fixes"]);

      for (const [key, value] of Object.entries(result.memoryUpdates)) {
        ctx.memory.set(key, value, "project", ["fixes"]);
      }

      const artifacts: Record<string, string> = {
        "issue-fixes.md": result.output,
      };

      // Extract inline code patches as separate artifact files
      const patches = extractCodeBlocks(result.output);
      for (const [filename, code] of Object.entries(patches)) {
        artifacts[filename] = code;
      }

      return {
        success: true,
        output: result.output,
        artifacts,
      };
    },
  };
}

function buildFixPrompt(issuesInput: string, expResults?: string): string {
  const context = expResults
    ? `\n\n## Experiment Results Context\n${expResults.slice(0, 600)}`
    : "";

  return `You are an ML engineer fixing issues found during experiment analysis.

## Issues to Fix
${issuesInput}
${context}

## Required Output

For each issue, provide:

### Issue: [ISS-ID] — [Title]

**Root Cause Analysis**
Explain precisely why this is happening. Reference specific code patterns or training dynamics.

**Fix Strategy**
Describe the approach at a high level.

**Code Fix**
Provide the exact code change in a fenced code block:

\`\`\`python
# File: path/to/file.py
# Change: description

[actual code]
\`\`\`

**Verification**
How to verify the fix works:
  - Test command or check to run
  - Expected output after fix

**Estimated Impact**
Brief description of expected improvement.

---

After all issues, provide:

### Fix Summary
- Issues addressed: N
- Estimated time to implement: X hours
- Risk level: low/medium/high
- Recommended order: [issue IDs in order]

### What to Watch After Fixes
List 3-5 metrics/behaviors to monitor after applying these fixes.

---
Embed key facts: <!-- MEMORY: key=value -->`;
}

function parseFixes(output: string): ExperimentIssue[] {
  const issues: ExperimentIssue[] = [];
  const issuePattern = /### Issue:\s*(ISS-\d+)\s*[—-]\s*(.+)/g;
  let match;

  while ((match = issuePattern.exec(output)) !== null) {
    const [, id, title] = match;
    issues.push({
      id,
      title: title.trim(),
      description: "",
      severity: "medium",
      status: "in_progress",
      createdAt: new Date().toISOString(),
    });
  }

  return issues;
}

function extractCodeBlocks(output: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  const pattern = /```(?:python|typescript|javascript|bash)\n([\s\S]*?)```/g;
  let match;
  let index = 0;

  while ((match = pattern.exec(output)) !== null) {
    const [, code] = match;
    // Try to extract filename from comment
    const fileComment = code.match(/^#\s*File:\s*(.+)/m);
    const filename = fileComment
      ? `fix-${path.basename(fileComment[1].trim())}`
      : `fix-patch-${index++}.py`;
    blocks[filename] = code;
  }

  return blocks;
}

