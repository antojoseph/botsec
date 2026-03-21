# M2* Model Iteration System

An AI agent harness for iterative ML model improvement, implementing the architecture from the M2* diagram.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent Harness                         │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ Hierarchical │  │  Persistent  │  │    Guardrails     │ │
│  │   Skills     │  │   Memory     │  │  (escalation,     │ │
│  │ /exp-plan    │  │ session /    │  │   depth limits)   │ │
│  │ /exp-submit  │  │ project /    │  └───────────────────┘ │
│  │ /issue-fix   │  │ global tiers │  ┌───────────────────┐ │
│  │ /issue-report│  └──────────────┘  │  Evaluation Infra │ │
│  └──────────────┘                    │  (metrics, evals) │ │
│                                      └───────────────────┘ │
│                          Agent (M2*)                        │
│           Claude Opus 4.6 via Claude Agent SDK              │
└─────────────────────────────────────────────────────────────┘
```

## RL Experiment Workflow (5 phases)

```
Phase 1: Exp Plan       (Human + AI)  /exp-plan
Phase 2: Exp Dev & Run  (AI)          agent writes/runs code
Phase 3: Analyze Report (AI)          /exp-submit
Phase 4: Review Discuss (Human + AI)  human checkpoint
Phase 5: Exp Iterate    (Human + AI)  /issue-fix → /issue-report → loop
```

## Setup

```bash
npm install
npm run build
export ANTHROPIC_API_KEY=your-key
```

## Usage

### Full workflow
```bash
node dist/index.js workflow --goal "Improve PPO reward shaping to reduce variance" --iterations 3
```

### Individual skills
```bash
# Plan an experiment
node dist/index.js skill /exp-plan "Test curriculum learning for faster convergence"

# Submit results from a training run
node dist/index.js skill /exp-submit "$(cat training_logs.txt)"

# Fix issues found in analysis
node dist/index.js skill /issue-fix "ISS-1: reward collapse at epoch 12"

# Generate final iteration report
node dist/index.js skill /issue-report
```

### Memory inspection
```bash
node dist/index.js memory list
node dist/index.js memory list global
node dist/index.js memory search "reward"
```

### Evaluation summary
```bash
node dist/index.js eval summary
```

## Skill Chaining

Skills auto-chain:
```
/exp-submit → /issue-fix → /issue-report
```

Chain depth is capped at 5 (configurable). Guardrails escalate to human when:
- Confidence score drops below 0.4
- Escalation keywords detected ("uncertain", "need clarification", etc.)
- Destructive operations detected

## Memory Tiers

| Tier    | Scope       | Persistence        | Auto-promote at  |
|---------|-------------|--------------------|-----------------:|
| session | current run | in-memory only     | 3 accesses       |
| project | codebase    | `.m2star/memory/project.json` | 10 accesses |
| global  | all time    | `.m2star/memory/global.json`  | never       |

## Options

```
--memory-dir <dir>     Memory storage directory (default: .m2star/memory)
-o, --output-dir <dir> Output directory for reports (default: m2star-output)
--max-turns <n>        Max agent turns per skill (default: 20)
--model <model>        Claude model (default: claude-opus-4-6)
--auto-approve         Skip human checkpoint prompts
```
