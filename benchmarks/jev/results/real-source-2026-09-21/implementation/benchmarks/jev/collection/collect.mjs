import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { generateThreatModel } from '../../../dist/threat-model/orchestrator.js';
import { allProviders } from '../../../dist/threat-model/providers/registry.js';
import { generationGateway } from './generation-gateway.mjs';
const { values } = parseArgs({ options: { preparation: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' } } });
if (!values.preparation || !values.out) throw new Error('--preparation and --out are required');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is required');
const preparation = JSON.parse(readFileSync(resolve(values.preparation)));
const out = resolve(values.out); mkdirSync(out, { recursive: true });
if (existsSync(join(out, 'collection.json'))) throw new Error('Collection already exists; preserve it and choose a new output directory');
const preflight = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
if (!preflight.ok) throw new Error(`OpenRouter credential check failed: HTTP ${preflight.status}`);
const gateway = await generationGateway({ key, limitUsd: 15, logPath: join(out, 'generation-billing.jsonl') });
// The gateway alone holds the real credential. Models only receive selected
// source through read tools; subprocess authentication uses an ephemeral token.
delete process.env.OPENROUTER_API_KEY;
Object.assign(process.env, { ANTHROPIC_BASE_URL: gateway.url, ANTHROPIC_AUTH_TOKEN: gateway.token, ANTHROPIC_API_KEY: '',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-sonnet-4.6', ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-4.6',
  CLAUDE_CODE_SUBAGENT_MODEL: 'anthropic/claude-sonnet-4.6', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
  FORGE_PROOF_CLASSIFIER_MODEL: 'anthropic/claude-haiku-4.5', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
const manifest = { version: 1, startedAt: new Date().toISOString(), preparation, generationBudgetUsd: 15, perProjectSdkBudgetUsd: 4,
  sampling: 'One consecutive generation run per prepared project; no reruns selected for favorable findings.', split: 'development', labels: 'not-adjudicated', runs: [] };
const save = () => writeFileSync(join(out, 'collection.json'), JSON.stringify(manifest, null, 2) + '\n');
save();
try {
  for (const project of preparation.projects.filter(p => !values.only || values.only === p.id)) {
    for (const file of project.inventory) {
      const actual = createHash('sha256').update(readFileSync(join(project.directory, file.path))).digest('hex');
      if (actual !== file.sha256) throw new Error('Prepared source changed');
    }
    console.log(`Collecting ${project.id}`);
    const outputDir = join(out, project.id), run = { projectId: project.id, family: project.family, status: 'running' };
    manifest.runs.push(run); save();
    try {
      await generateThreatModel({ contractPath: project.directory, outputDir, captureRaw: true, sourceOnly: true, maxBudgetUsd: 4, maxTurns: 60,
        enabledProviders: allProviders().filter(p => p.defaultEnabled && p.id !== 'etherscan') });
      const dirs = readdirSync(outputDir).filter(n => n.startsWith('threat-model-'));
      if (dirs.length !== 1) throw new Error('Ambiguous captured run');
      run.directory = join(project.id, dirs[0]);
      const result = JSON.parse(readFileSync(join(out, run.directory, 'generation-result.json')));
      const raw = JSON.parse(readFileSync(join(out, run.directory, 'raw-findings.json')));
      run.status = result.completionStatus === 'success' && result.parseSucceeded ? 'complete' : 'incomplete';
      run.rawFindingCount = raw.threats.length;
    } catch (error) { run.status = 'failed'; run.errorType = error.name; }
    save();
    if (gateway.budget.spent + gateway.budget.pending >= 14) break;
  }
} finally {
  await gateway.close();
  manifest.finishedAt = new Date().toISOString();
  manifest.generationBudgetChargedUsd = gateway.budget.spent;
  manifest.generationPendingReservationUsd = gateway.budget.pending;
  save();
}
console.log(JSON.stringify({ runs: manifest.runs, generationBudgetChargedUsd: manifest.generationBudgetChargedUsd }, null, 2));
