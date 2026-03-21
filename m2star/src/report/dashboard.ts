/**
 * Dashboard Generator — HTML report with inline charts.
 *
 * Generates a self-contained HTML file that humans can open in a browser
 * to review experiment results, metrics, and iteration history.
 * No external dependencies — uses Chart.js via CDN.
 */

import fs from "fs";
import path from "path";
import { EvalReport, Experiment } from "../types.js";

export interface DashboardData {
  experiment: Experiment;
  evalReports: EvalReport[];
  iterationSummaries: IterationSummary[];
}

export interface IterationSummary {
  iteration: number;
  timestamp: string;
  metrics: Record<string, number>;
  issues: number;
  deployRecommendation: string;
  passed: boolean;
}

export function generateDashboard(data: DashboardData, outputPath: string): void {
  const html = buildHtml(data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html);
}

function buildHtml(data: DashboardData): string {
  const { experiment, evalReports, iterationSummaries } = data;

  const skillNames = [...new Set(evalReports.map((r) => r.skillName))];
  const successRates = skillNames.map((name) => {
    const runs = evalReports.filter((r) => r.skillName === name);
    return runs.filter((r) => r.passed).length / Math.max(runs.length, 1);
  });

  const avgLatencies = skillNames.map((name) => {
    const runs = evalReports.filter((r) => r.skillName === name);
    const lats = runs.map((r) => r.metrics.find((m) => m.name === "latency_ms")?.value ?? 0);
    return lats.reduce((a, b) => a + b, 0) / Math.max(lats.length, 1);
  });

  const iterLabels = iterationSummaries.map((s) => `Iter ${s.iteration}`);
  const iterIssues = iterationSummaries.map((s) => s.issues);
  const iterPassed = iterationSummaries.map((s) => (s.passed ? 1 : 0));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>M2* Dashboard — ${escHtml(experiment.name)}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0f1117; color: #e2e8f0; line-height: 1.6; }
    .header { background: linear-gradient(135deg, #1a1f2e 0%, #0d1117 100%);
              border-bottom: 1px solid #2d3748; padding: 24px 32px; }
    .header h1 { font-size: 1.5rem; font-weight: 700; color: #f7fafc; }
    .header p  { color: #718096; margin-top: 4px; font-size: 0.875rem; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px;
             font-size: 0.75rem; font-weight: 600; margin-left: 8px; }
    .badge-green  { background: #1a4731; color: #68d391; }
    .badge-yellow { background: #44371a; color: #f6e05e; }
    .badge-red    { background: #44201a; color: #fc8181; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px; padding: 24px 32px; }
    .card { background: #1a1f2e; border: 1px solid #2d3748; border-radius: 12px;
            padding: 20px; }
    .card h2 { font-size: 0.875rem; font-weight: 600; color: #718096;
               text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; }
    .stat { font-size: 2rem; font-weight: 700; color: #f7fafc; }
    .stat-sub { font-size: 0.8rem; color: #718096; margin-top: 2px; }
    .chart-card { grid-column: span 2; }
    canvas { max-height: 260px; }
    .table-card { grid-column: span 3; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { text-align: left; padding: 8px 12px; background: #0d1117;
         color: #718096; font-weight: 600; border-bottom: 1px solid #2d3748; }
    td { padding: 8px 12px; border-bottom: 1px solid #1a2035; }
    tr:hover td { background: #1e2538; }
    .status-pass { color: #68d391; }
    .status-fail { color: #fc8181; }
    .footer { text-align: center; color: #4a5568; font-size: 0.75rem;
              padding: 16px; border-top: 1px solid #1a2035; margin-top: 8px; }
  </style>
</head>
<body>

<div class="header">
  <h1>M2* Experiment Dashboard
    <span class="badge ${experiment.phase === "iterate" ? "badge-yellow" : "badge-green"}">
      ${escHtml(experiment.phase)}
    </span>
  </h1>
  <p>${escHtml(experiment.name)} &nbsp;·&nbsp; ${escHtml(experiment.id)}
     &nbsp;·&nbsp; ${escHtml(new Date(experiment.updatedAt).toLocaleString())}</p>
</div>

<div class="grid">

  <!-- KPI cards -->
  <div class="card">
    <h2>Iterations</h2>
    <div class="stat">${experiment.iterations}</div>
    <div class="stat-sub">total experiment loops</div>
  </div>

  <div class="card">
    <h2>Open Issues</h2>
    <div class="stat">${experiment.issues.filter((i) => i.status === "open").length}</div>
    <div class="stat-sub">of ${experiment.issues.length} total</div>
  </div>

  <div class="card">
    <h2>Skill Runs</h2>
    <div class="stat">${evalReports.length}</div>
    <div class="stat-sub">${evalReports.filter((r) => r.passed).length} passed</div>
  </div>

  <div class="card">
    <h2>Avg Latency</h2>
    <div class="stat">${
      evalReports.length
        ? (evalReports.reduce((s, r) => s + (r.metrics.find((m) => m.name === "latency_ms")?.value ?? 0), 0) / evalReports.length / 1000).toFixed(1)
        : "—"
    }s</div>
    <div class="stat-sub">per skill execution</div>
  </div>

  <!-- Skill success rate chart -->
  <div class="card chart-card">
    <h2>Skill Success Rate</h2>
    <canvas id="skillChart"></canvas>
  </div>

  <!-- Iteration issues chart -->
  <div class="card chart-card">
    <h2>Issues per Iteration</h2>
    <canvas id="iterChart"></canvas>
  </div>

  <!-- Eval reports table -->
  <div class="card table-card">
    <h2>Skill Evaluation Log</h2>
    <table>
      <thead>
        <tr>
          <th>Skill</th><th>Run ID</th><th>Timestamp</th>
          <th>Score</th><th>Latency</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${evalReports.slice(-30).reverse().map((r) => {
          const lat = r.metrics.find((m) => m.name === "latency_ms");
          return `<tr>
            <td>${escHtml(r.skillName)}</td>
            <td style="font-family:monospace;font-size:0.75rem">${escHtml(r.runId.slice(-12))}</td>
            <td>${escHtml(new Date(r.timestamp).toLocaleTimeString())}</td>
            <td>${(r.overallScore * 100).toFixed(0)}%</td>
            <td>${lat ? (lat.value / 1000).toFixed(1) + "s" : "—"}</td>
            <td class="${r.passed ? "status-pass" : "status-fail"}">${r.passed ? "PASS" : "FAIL"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>

  <!-- Issues table -->
  ${experiment.issues.length > 0 ? `
  <div class="card table-card">
    <h2>Issues</h2>
    <table>
      <thead>
        <tr><th>ID</th><th>Severity</th><th>Title</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${experiment.issues.map((issue) => `<tr>
          <td style="font-family:monospace">${escHtml(issue.id)}</td>
          <td><span class="badge ${issue.severity === "high" ? "badge-red" : issue.severity === "medium" ? "badge-yellow" : "badge-green"}">${escHtml(issue.severity)}</span></td>
          <td>${escHtml(issue.title)}</td>
          <td>${escHtml(issue.status)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>
  ` : ""}

</div>

<div class="footer">Generated by M2* · ${new Date().toISOString()}</div>

<script>
const chartDefaults = {
  plugins: { legend: { labels: { color: '#a0aec0' } } },
  scales: {
    x: { ticks: { color: '#718096' }, grid: { color: '#1a2035' } },
    y: { ticks: { color: '#718096' }, grid: { color: '#1a2035' } }
  }
};

// Skill success rate bar chart
new Chart(document.getElementById('skillChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(skillNames)},
    datasets: [{
      label: 'Success Rate',
      data: ${JSON.stringify(successRates.map((r) => Math.round(r * 100)))},
      backgroundColor: ${JSON.stringify(successRates.map((r) => r >= 0.8 ? '#2f855a' : r >= 0.5 ? '#b7791f' : '#c53030'))},
      borderRadius: 6,
    }, {
      label: 'Avg Latency (s)',
      data: ${JSON.stringify(avgLatencies.map((l) => Math.round(l / 1000)))},
      backgroundColor: '#2b6cb0',
      borderRadius: 6,
      yAxisID: 'y2',
    }]
  },
  options: {
    ...chartDefaults,
    scales: {
      ...chartDefaults.scales,
      y:  { ...chartDefaults.scales.y, title: { display: true, text: 'Success %', color: '#718096' } },
      y2: { position: 'right', ticks: { color: '#718096' }, grid: { drawOnChartArea: false },
            title: { display: true, text: 'Latency (s)', color: '#718096' } }
    }
  }
});

// Iteration issues chart
new Chart(document.getElementById('iterChart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(iterLabels)},
    datasets: [{
      label: 'Issues',
      data: ${JSON.stringify(iterIssues)},
      borderColor: '#fc8181',
      backgroundColor: 'rgba(252,129,129,0.1)',
      fill: true, tension: 0.4,
    }, {
      label: 'Passed',
      data: ${JSON.stringify(iterPassed)},
      borderColor: '#68d391',
      backgroundColor: 'rgba(104,211,145,0.1)',
      fill: true, tension: 0.4,
    }]
  },
  options: chartDefaults,
});
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
