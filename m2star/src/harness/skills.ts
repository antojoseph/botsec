/**
 * Hierarchical Skills Registry — composable, auto-chaining skills.
 *
 * Skills are registered by name and invoked via command strings (e.g. "/exp-plan").
 * Chaining: a skill can declare chainTo to automatically invoke the next skill.
 * Max depth is enforced by guardrails.
 */

import { SkillContext, SkillDefinition, SkillResult } from "../types.js";
import { checkGuardrails, formatEscalation } from "./guardrails.js";

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill);
    // Also register by command without leading slash
    const cmd = skill.command.startsWith("/") ? skill.command.slice(1) : skill.command;
    if (cmd !== skill.name) {
      this.skills.set(cmd, skill);
    }
  }

  get(nameOrCommand: string): SkillDefinition | undefined {
    const key = nameOrCommand.startsWith("/") ? nameOrCommand.slice(1) : nameOrCommand;
    return this.skills.get(key);
  }

  list(): SkillDefinition[] {
    // Deduplicate (registered under both name and command)
    const seen = new Set<string>();
    const result: SkillDefinition[] = [];
    for (const skill of this.skills.values()) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        result.push(skill);
      }
    }
    return result;
  }

  /** Execute a skill by name/command, handling chaining and guardrails */
  async run(
    nameOrCommand: string,
    ctx: SkillContext,
    onOutput?: (line: string) => void
  ): Promise<SkillResult> {
    const skill = this.get(nameOrCommand);
    if (!skill) {
      return {
        success: false,
        output: `Unknown skill: ${nameOrCommand}. Available: ${this.list()
          .map((s) => s.command)
          .join(", ")}`,
      };
    }

    const log = onOutput ?? ((line: string) => process.stdout.write(line + "\n"));
    log(`\n→ [${skill.command}] ${skill.description}`);

    // Guardrail: chain depth
    if (ctx.chainDepth >= ctx.guardrails.maxChainDepth) {
      const msg = `Chain depth limit (${ctx.guardrails.maxChainDepth}) reached. Stopping auto-chain.`;
      log(`  ⚠️  ${msg}`);
      return {
        success: false,
        output: msg,
        escalated: true,
        escalationReason: "Chain depth limit",
      };
    }

    // Human approval gate
    if (skill.requiresHumanApproval) {
      log(`  ⏸  This skill requires human approval. Set --auto-approve to bypass.`);
      // In a real interactive environment we'd prompt; here we block and surface the need
      return {
        success: false,
        output: "Human approval required",
        escalated: true,
        escalationReason: `Skill ${skill.name} requires human approval`,
      };
    }

    // Execute the skill
    let result: SkillResult;
    try {
      result = await skill.handler(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, output: `Skill ${skill.name} threw: ${msg}` };
    }

    // Post-execution guardrail check
    const check = checkGuardrails(result.output, ctx.guardrails, ctx.chainDepth);
    if (!check.passed) {
      const escalationMsg = formatEscalation(check, skill.name);
      log(escalationMsg);
      return {
        ...result,
        escalated: true,
        escalationReason: check.violations.join("; "),
      };
    }

    // Auto-chain to next skill
    const nextSkillName = result.nextSkill ?? skill.chainTo?.[0];
    if (nextSkillName && result.success) {
      log(`  ↪  Auto-chaining to ${nextSkillName}`);
      const chainedCtx: SkillContext = {
        ...ctx,
        input: result.output,
        chainDepth: ctx.chainDepth + 1,
        calledBy: skill.name,
      };
      const chainedResult = await this.run(nextSkillName, chainedCtx, onOutput);
      // Merge artifacts
      return {
        ...chainedResult,
        artifacts: { ...(result.artifacts ?? {}), ...(chainedResult.artifacts ?? {}) },
      };
    }

    return result;
  }
}
