#!/usr/bin/env bash
#
# eval-providers.sh — Benchmark threat model provider effectiveness.
#
# Runs the threat-model pipeline 8 times IN PARALLEL with progressively more
# providers enabled, from zero tools (baseline) to all tools (default).
# Each run saves its output separately for comparison.
#
# Usage:
#   ./benchmarks/eval-providers.sh <foundry-project-path> [--quick]
#
# Options:
#   --quick   Only run baseline (0 tools) and all-tools (full pipeline)
#
# Output:
#   benchmarks/eval-runs/<timestamp>/
#     run-0-baseline/threat-model.json
#     run-1-+ast/threat-model.json
#     ...
#     summary.json
#

set -euo pipefail

# ─── Validate inputs ──────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <foundry-project-path> [--quick]"
  exit 1
fi

TARGET="$1"
QUICK=false
if [[ "${2:-}" == "--quick" ]]; then
  QUICK=true
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY not set."
  exit 1
fi

if [[ ! -f "$TARGET/foundry.toml" ]]; then
  echo "Error: $TARGET is not a Foundry project (no foundry.toml)."
  exit 1
fi

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_ABS="$(cd "$TARGET" && pwd)"
TARGET_NAME="$(basename "$TARGET_ABS")"

TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"
EVAL_DIR="$SCRIPT_DIR/eval-runs/$TIMESTAMP"
mkdir -p "$EVAL_DIR"

CLI="node $PROJECT_ROOT/dist/index.js"

# Fixed budget/turns for fair comparison
MAX_TURNS=200
MAX_BUDGET=50

echo "═══════════════════════════════════════════════════════════"
echo "  Provider Effectiveness Benchmark"
echo "═══════════════════════════════════════════════════════════"
echo "  Target:    $TARGET_NAME ($TARGET_ABS)"
echo "  Output:    $EVAL_DIR"
echo "  Budget:    \$$MAX_BUDGET per run, $MAX_TURNS max turns"
echo "  Mode:      $(if $QUICK; then echo 'quick (2 runs)'; else echo 'full (8 runs)'; fi)"
echo "  Execution: PARALLEL"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Run configurations ───────────────────────────────────────────────────
#
# Each entry: "name|flags"
# Flags are the --no-X flags to pass. Providers NOT listed are enabled.

ALL_DISABLED="--no-ast --no-inspect --no-blueprint --no-anti-slop --no-self-contradiction --no-dedup --no-ranking"

RUNS=(
  "baseline|$ALL_DISABLED"
  "+ast|--no-inspect --no-blueprint --no-anti-slop --no-self-contradiction --no-dedup --no-ranking"
  "+inspect|--no-blueprint --no-anti-slop --no-self-contradiction --no-dedup --no-ranking"
  "+blueprint|--no-anti-slop --no-self-contradiction --no-dedup --no-ranking"
  "+anti-slop|--no-self-contradiction --no-dedup --no-ranking"
  "+self-contradiction|--no-dedup --no-ranking"
  "+dedup|--no-ranking"
  "all-tools|"
)

if $QUICK; then
  RUNS=(
    "baseline|$ALL_DISABLED"
    "all-tools|"
  )
fi

TOTAL=${#RUNS[@]}

# ─── Write config ─────────────────────────────────────────────────────────

cat > "$EVAL_DIR/config.json" << EOF
{
  "target": "$TARGET_NAME",
  "targetPath": "$TARGET_ABS",
  "timestamp": "$TIMESTAMP",
  "maxTurns": $MAX_TURNS,
  "maxBudgetUsd": $MAX_BUDGET,
  "totalRuns": $TOTAL,
  "mode": "$(if $QUICK; then echo 'quick'; else echo 'full'; fi)"
}
EOF

# ─── Run a single configuration (called as background job) ────────────────

run_one() {
  local RUN_NUM="$1"
  local NAME="$2"
  local FLAGS="$3"
  local RUN_DIR="$EVAL_DIR/run-$RUN_NUM-$NAME"
  local OUTPUT_DIR="$RUN_DIR/output"
  mkdir -p "$OUTPUT_DIR"

  echo "  [$RUN_NUM/$((TOTAL-1))] Starting: $NAME"

  # Save flags for reference
  echo "$FLAGS" > "$RUN_DIR/flags.txt"

  local START_TIME
  START_TIME=$(date +%s)

  # Run the CLI
  local EXIT_CODE=0
  $CLI threat-model "$TARGET_ABS" \
    --max-turns "$MAX_TURNS" \
    --max-budget "$MAX_BUDGET" \
    -o "$OUTPUT_DIR" \
    $FLAGS \
    > "$RUN_DIR/run.log" 2>&1 || EXIT_CODE=$?

  local END_TIME
  END_TIME=$(date +%s)
  local DURATION=$((END_TIME - START_TIME))

  # Find the threat-model.json in the output directory
  local TM_FILE
  TM_FILE=$(find "$OUTPUT_DIR" -name "threat-model.json" -type f 2>/dev/null | head -1)

  local THREAT_COUNT=0
  local BY_SEVERITY='{"Critical":0,"High":0,"Medium":0,"Low":0}'
  local BY_CATEGORY='{}'
  local COST="0"
  local TURNS="0"

  if [[ -n "$TM_FILE" && -f "$TM_FILE" ]]; then
    # Copy to run dir root for easy access
    cp "$TM_FILE" "$RUN_DIR/threat-model.json"

    THREAT_COUNT=$(node -e "
      const tm = JSON.parse(require('fs').readFileSync('$TM_FILE', 'utf-8'));
      console.log(tm.threats.length);
    " 2>/dev/null || echo "0")

    BY_SEVERITY=$(node -e "
      const tm = JSON.parse(require('fs').readFileSync('$TM_FILE', 'utf-8'));
      const s = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      for (const t of tm.threats) s[t.severity] = (s[t.severity] || 0) + 1;
      console.log(JSON.stringify(s));
    " 2>/dev/null || echo '{"Critical":0,"High":0,"Medium":0,"Low":0}')

    BY_CATEGORY=$(node -e "
      const tm = JSON.parse(require('fs').readFileSync('$TM_FILE', 'utf-8'));
      const c = {};
      for (const t of tm.threats) c[t.category] = (c[t.category] || 0) + 1;
      console.log(JSON.stringify(c));
    " 2>/dev/null || echo '{}')

    COST=$(grep -o '\$[0-9.]*' "$RUN_DIR/run.log" | tail -1 | tr -d '$' || echo "0")
    TURNS=$(grep -oE '[0-9]+ turns' "$RUN_DIR/run.log" | head -1 | grep -oE '[0-9]+' || echo "0")
  fi

  # Write run metadata
  cat > "$RUN_DIR/meta.json" << METAEOF
{
  "name": "$NAME",
  "runNumber": $RUN_NUM,
  "flags": "$FLAGS",
  "exitCode": $EXIT_CODE,
  "durationSec": $DURATION,
  "costUsd": ${COST:-0},
  "turns": ${TURNS:-0},
  "threats": $THREAT_COUNT,
  "bySeverity": $BY_SEVERITY,
  "byCategory": $BY_CATEGORY
}
METAEOF

  echo "  [$RUN_NUM/$((TOTAL-1))] Done: $NAME — $THREAT_COUNT threats | \$${COST:-0} | ${DURATION}s"
}

# ─── Launch all runs in parallel ──────────────────────────────────────────

PIDS=()

for i in "${!RUNS[@]}"; do
  IFS='|' read -r NAME FLAGS <<< "${RUNS[$i]}"
  run_one "$i" "$NAME" "$FLAGS" &
  PIDS+=($!)
done

echo ""
echo "  Launched $TOTAL runs in parallel. Waiting for completion..."
echo ""

# Wait for all background jobs
FAILED=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || ((FAILED++))
done

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "  Warning: $FAILED run(s) exited with errors. Check run.log files."
fi

# ─── Generate summary ─────────────────────────────────────────────────────

node -e "
  const fs = require('fs');
  const path = require('path');

  const evalDir = '$EVAL_DIR';
  const runs = [];

  // Read all meta.json files in order
  const dirs = fs.readdirSync(evalDir)
    .filter(d => d.startsWith('run-'))
    .sort((a, b) => {
      const numA = parseInt(a.split('-')[1]);
      const numB = parseInt(b.split('-')[1]);
      return numA - numB;
    });

  for (const dir of dirs) {
    const metaPath = path.join(evalDir, dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      runs.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
    }
  }

  const summary = {
    target: '$TARGET_NAME',
    timestamp: '$TIMESTAMP',
    maxTurns: $MAX_TURNS,
    maxBudgetUsd: $MAX_BUDGET,
    runs
  };

  fs.writeFileSync(
    path.join(evalDir, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );
" 2>/dev/null

# ─── Print comparison table ───────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  RESULTS SUMMARY"
echo "═══════════════════════════════════════════════════════════"
echo ""
printf "  %-22s %7s %4s %4s %4s %4s %7s %6s\n" \
  "Run" "Threats" "Crit" "High" "Med" "Low" "Cost" "Time"
echo "  ─────────────────────────────────────────────────────────"

for i in "${!RUNS[@]}"; do
  IFS='|' read -r NAME _ <<< "${RUNS[$i]}"
  META="$EVAL_DIR/run-$i-$NAME/meta.json"
  if [[ -f "$META" ]]; then
    node -e "
      const m = JSON.parse(require('fs').readFileSync('$META', 'utf-8'));
      const s = m.bySeverity;
      const pad = (v, w) => String(v).padStart(w);
      console.log(
        '  ' +
        m.name.padEnd(22) + ' ' +
        pad(m.threats, 7) + ' ' +
        pad(s.Critical || 0, 4) + ' ' +
        pad(s.High || 0, 4) + ' ' +
        pad(s.Medium || 0, 4) + ' ' +
        pad(s.Low || 0, 4) + ' ' +
        ('\$' + Number(m.costUsd || 0).toFixed(2)).padStart(7) + ' ' +
        (m.durationSec + 's').padStart(6)
      );
    " 2>/dev/null
  fi
done

echo ""
echo "  Output:  $EVAL_DIR"
echo "  Summary: $EVAL_DIR/summary.json"
echo "═══════════════════════════════════════════════════════════"
