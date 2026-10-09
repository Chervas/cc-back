'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const candidatePaths = ['src/services/flowEngineV2.service.js', 'src/lib/automation-intent-contract.js',
  'src/lib/automation-conversation-context.js', 'src/lib/same-day-canonical-flow.js'];

function runFixture(change = () => {}) {
  const directory = fs.mkdtempSync('/home/ubuntu/secure-imports/care-fresh-fixture-');
  fs.chmodSync(directory, 0o700);
  const nodes = [{ id: 'AI', type: 'condition/ai_analysis', outputs: { on_success: null } }];
  const evidence = { graphHash: hash(JSON.stringify(nodes)), nodeId: 'AI' };
  const fixture = {
    cases: { cases: [{ id: 1, nodes, node: nodes[0], currentPathEvidence: evidence,
      context: { conversation: { id: 1 } } }] },
    replay: { complete: true, sourceLogs: 1, cutoff: '2026-10-09T00:00:00Z', clinicalWrites: false, sends: false,
      candidate: Object.fromEntries(candidatePaths.map(name => [name, hash(fs.readFileSync(path.join(root, name)))])),
      results: [{ id: 1, inferenceCalls: 1, currentPathEvidence: evidence,
        output: { _ai_provider: 'bedrock', _ai_fallback_used: false } }] },
    validation: { cases: 1, realCalls: 1, cutoff: '2026-10-09T00:00:00Z', failures: [], expectedSafetyHolds: [] },
  };
  change(fixture);
  fixture.validation.casesSha256 = hash(JSON.stringify(fixture.cases));
  try {
    for (const name of ['cases', 'replay', 'validation']) fs.writeFileSync(path.join(directory, name + '.json'),
      JSON.stringify(fixture[name]), { flag: 'wx', mode: 0o600 });
    const report = path.join(directory, 'result.json');
    const result = spawnSync(process.execPath, [path.join(root, 'src/scripts/qa/replay-appointment-care-local.js'),
      '--cases', path.join(directory, 'cases.json'), '--inference-report', path.join(directory, 'replay.json'),
      '--inference-validation', path.join(directory, 'validation.json'), '--report', report],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
    return { status: result.status, error: result.error,
      report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report)) : null };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('fresh-output guard stage performs no extra inference or clinical write', () => {
  const result = runFixture();
  assert.equal(result.status, 0);
  assert.equal(result.report.mode, 'local_fresh_outputs_current_graphs');
  assert.equal(result.report.newInference, false);
  assert.equal(result.report.freshEvidence.sourceRealCalls, 1);
  assert.equal(result.report.phaseSendGuards, 3);
  assert.equal(result.report.clinicalWrites, 0);
  assert.equal(result.report.sends, 0);
});

test('partial, failed, simulated and fallback replays cannot validate care guards', () => {
  for (const change of [
    x => { x.replay.complete = false; },
    x => { x.validation.failures = [{ reason: 'wrong_clinical_state' }]; },
    x => { x.replay.results[0].output._ai_simulated = true; },
    x => { x.replay.results[0].output._ai_fallback_used = true; },
    x => { x.replay.results[0].inferenceCalls = 0; },
  ]) {
    const result = runFixture(change);
    assert.equal(result.status, 1);
    assert.equal(result.report, null);
  }
});

test('missing cases, changed graphs and changed engine evidence are rejected', () => {
  for (const change of [
    x => { x.replay.results[0].id = 2; },
    x => { x.replay.results[0].currentPathEvidence = { graphHash: 'changed', nodeId: 'AI' }; },
    x => { x.replay.candidate[candidatePaths[0]] = 'changed'; },
    x => { x.replay.candidate = {}; },
  ]) {
    const result = runFixture(change);
    assert.equal(result.status, 1);
    assert.equal(result.report, null);
  }
});
