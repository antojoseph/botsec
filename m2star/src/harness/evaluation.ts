/**
 * Evaluation Infrastructure — benchmarks, validation, and quality metrics.
 *
 * Tracks per-skill and per-experiment metrics.
 * Persists eval reports to <outputDir>/evals/.
 */

import fs from "fs";
import path from "path";
import { EvalMetric, EvalReport, SkillResult } from "../types.js";

export class EvaluationInfra {
  readonly evalsDir: string;

  constructor(outputDir: string) {
    this.evalsDir = path.join(outputDir, "evals");
    fs.mkdirSync(this.evalsDir, { recursive: true });
  }

  /** Load all persisted eval reports (or filter by skill name) */
  getReports(skillName?: string): EvalReport[] {
    return this.loadReports(skillName);
  }

  /** Measure latency, output length, success rate */
  measureSkillRun(
    skillName: string,
    result: SkillResult,
    durationMs: number
  ): EvalReport {
    const metrics: EvalMetric[] = [
      {
        name: "success",
        value: result.success ? 1 : 0,
        unit: "boolean",
        threshold: 1,
        passed: result.success,
      },
      {
        name: "latency_ms",
        value: durationMs,
        unit: "ms",
        threshold: 60000,
        passed: durationMs < 60000,
      },
      {
        name: "output_length",
        value: result.output.length,
        unit: "chars",
      },
      {
        name: "artifacts_count",
        value: Object.keys(result.artifacts ?? {}).length,
        unit: "count",
      },
      {
        name: "escalated",
        value: result.escalated ? 1 : 0,
        unit: "boolean",
        threshold: 0,
        passed: !result.escalated,
      },
    ];

    const passedCount = metrics.filter((m) => m.passed !== undefined && m.passed).length;
    const totalWithThreshold = metrics.filter((m) => m.passed !== undefined).length;
    const overallScore = totalWithThreshold > 0 ? passedCount / totalWithThreshold : 1;

    const report: EvalReport = {
      skillName,
      runId: `${skillName}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      metrics,
      overallScore,
      passed: overallScore >= 0.8,
      notes: result.escalated
        ? `Escalated: ${result.escalationReason ?? "unknown"}`
        : result.success
        ? "Completed successfully"
        : "Failed",
    };

    this.saveReport(report);
    return report;
  }

  /** Compute aggregate stats across all runs for a skill */
  aggregateSkill(skillName: string): Record<string, number> {
    const reports = this.loadReports(skillName);
    if (reports.length === 0) return {};

    const successRate = reports.filter((r) => r.passed).length / reports.length;
    const avgLatency =
      reports.reduce((sum, r) => {
        const lat = r.metrics.find((m) => m.name === "latency_ms");
        return sum + (lat?.value ?? 0);
      }, 0) / reports.length;

    return {
      total_runs: reports.length,
      success_rate: Math.round(successRate * 100) / 100,
      avg_latency_ms: Math.round(avgLatency),
    };
  }

  private saveReport(report: EvalReport): void {
    const filePath = path.join(this.evalsDir, `${report.runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  }

  private loadReports(skillName?: string): EvalReport[] {
    if (!fs.existsSync(this.evalsDir)) return [];
    return fs
      .readdirSync(this.evalsDir)
      .filter((f) => f.endsWith(".json") && (!skillName || f.startsWith(skillName)))
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(this.evalsDir, f), "utf-8")
          ) as EvalReport;
        } catch {
          return null;
        }
      })
      .filter((r): r is EvalReport => r !== null);
  }

  /** Print a summary table of all evals */
  printSummary(): void {
    const reports = this.loadReports();
    if (reports.length === 0) {
      console.log("No evaluation reports found.");
      return;
    }

    const bySkill = new Map<string, EvalReport[]>();
    for (const r of reports) {
      const arr = bySkill.get(r.skillName) ?? [];
      arr.push(r);
      bySkill.set(r.skillName, arr);
    }

    console.log("\n── Evaluation Summary ──────────────────────────────");
    for (const [skill, runs] of bySkill.entries()) {
      const passed = runs.filter((r) => r.passed).length;
      const total = runs.length;
      const avgScore = runs.reduce((s, r) => s + r.overallScore, 0) / total;
      console.log(
        `  ${skill.padEnd(20)} ${passed}/${total} passed  score=${(avgScore * 100).toFixed(0)}%`
      );
    }
    console.log("────────────────────────────────────────────────────\n");
  }
}
