'use strict';

// Traverse supplied analysis outputs with in-memory appointment rows. Provider,
// SQL and queue sockets are forbidden; fresh outputs need a validated replay.
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
require('../tests/fixtures/campaign_offline_runtime.cjs');
const { loadSource } = require('../tests/fixtures/business_profile_flow_runtime.fixture');
const args = process.argv.slice(2), arg = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const input = arg('--cases'), output = arg('--report');
if (!input?.startsWith('/home/ubuntu/secure-imports/') || !output?.startsWith('/home/ubuntu/secure-imports/')
  || fs.existsSync(output)) throw Error('NEW_PRIVATE_CARE_QA_REPORT_REQUIRED');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceCases = JSON.parse(fs.readFileSync(input)).cases;
const inferenceReport = arg('--inference-report');
const inferenceValidation = arg('--inference-validation');
let cases = sourceCases, freshEvidence = null;
if (inferenceReport || inferenceValidation) {
  assert(inferenceReport && inferenceValidation, 'FRESH_REPLAY_AND_VALIDATION_REQUIRED');
  const replay = JSON.parse(fs.readFileSync(inferenceReport));
  const validation = JSON.parse(fs.readFileSync(inferenceValidation));
  assert.equal(replay.complete, true);
  assert.equal(replay.clinicalWrites, false); assert.equal(replay.sends, false);
  assert.equal(validation.failures.length, 0, 'FRESH_REPLAY_NOT_VALIDATED');
  assert.equal(validation.cases, sourceCases.length);
  assert.equal(validation.casesSha256, crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'));
  assert.equal(validation.cutoff, replay.cutoff);
  assert.equal(replay.sourceLogs, sourceCases.length);
  assert.equal(replay.results.length, sourceCases.length);
  const byId = new Map(replay.results.map(item => [item.id, item]));
  assert.equal(byId.size, sourceCases.length);
  const holds = new Set(validation.expectedSafetyHolds);
  cases = sourceCases.flatMap(item => {
    const result = byId.get(item.id); assert(result, 'FRESH_REPLAY_CASE_MISSING');
    if (result.error) {
      assert(holds.has(item.id) && result.inferenceCalls === 0, 'UNEXPECTED_FRESH_REPLAY_ERROR');
      return [];
    }
    assert.equal(result.inferenceCalls, 1);
    assert.equal(result.output?._ai_provider, 'bedrock');
    assert.equal(result.output?._ai_simulated, undefined);
    assert.equal(result.output?._ai_fallback_used, false);
    assert.equal(result.currentPathEvidence?.graphHash, hash(item.nodes));
    assert.equal(result.currentPathEvidence?.nodeId, item.node.id);
    assert.equal(result.response, item.context.last_response_context?.response_text);
    assert.equal(result.reference, item.context.last_prompt);
    return [{ ...item, original_output: result.output }];
  });
  assert.equal(holds.size, sourceCases.length - cases.length);
  assert.equal(validation.realCalls, cases.length);
  const candidatePaths = ['src/services/flowEngineV2.service.js', 'src/lib/automation-intent-contract.js',
    'src/lib/automation-conversation-context.js', 'src/lib/same-day-canonical-flow.js'];
  assert.deepEqual(Object.keys(replay.candidate).sort(), candidatePaths.sort());
  for (const [name, expected] of Object.entries(replay.candidate)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require('node:path').resolve(__dirname, '../../..', name))).digest('hex'), expected);
  }
  freshEvidence = { sourceCases: sourceCases.length, expectedSafetyHolds: holds.size,
    sourceRealCalls: validation.realCalls, inferenceReport,
    reportSha256: crypto.createHash('sha256').update(fs.readFileSync(inferenceReport)).digest('hex') };
}
let appointment, clinicalWrites = 0, providerCalls = 0;
const db = { CitaPaciente: { findByPk: async () => appointment }, Sequelize: require('sequelize'),
  sequelize: { transaction: async (_, work) => work({ LOCK: { UPDATE: 'UPDATE' } }) } };
const filename = require.resolve('../../../models');
assert(!require.cache[filename]);
require.cache[filename] = { id: filename, filename, loaded: true, exports: db };
const forbidden = () => { providerCalls++; throw Error('LOCAL_CARE_QA_EFFECT_FORBIDDEN'); };
const engine = loadSource('flowEngineV2.service', { '../../models': db,
  './socket.service': { getIO: () => null }, './queue.service': {},
  './jobRequests.service': { getCurrentRuntimeNamespace: () => 'qa' },
  './appointmentPatientLinks.service': require('../../services/appointmentPatientLinks.service'),
  './appointmentActivity.service': { recordAppointmentStatusChange: forbidden },
  './aiOrchestrator.service': { analyzeStructured: forbidden },
  './whatsapp.service': { sendTemplate: forbidden },
}, { JOB_RUNTIME_NAMESPACE: 'qa', RUNTIME_ROLE: 'gateway', JOBS_AUTO_START: 'false' });

(async () => {
  const result = { mode: freshEvidence ? 'local_fresh_outputs_current_graphs' : 'local_historical_outputs_current_graphs',
    newInference: false, freshEvidence,
    limitations: freshEvidence
      ? 'Reuses newly inferred and validated outputs to test care guards offline. This stage makes no additional inference or delivery.'
      : 'Does not measure new model decisions. Uses stored historical output only to traverse current field checks and test care-state protection.',
    cases: cases.length, conversations: new Set(cases.map(c => c.context.conversation.id)).size,
    graphs: new Set(cases.map(c => c.currentPathEvidence.graphHash)).size,
    routedCases: 0, stateActions: 0, protectedTransitions: 0, phaseSendGuards: 0,
    graphOrPromptEdits: false, clinicalWrites: 0, sends: 0, failures: [] };
  for (const [index, item] of cases.entries()) {
    try {
      assert.equal(hash(item.nodes), item.currentPathEvidence.graphHash);
      assert(!item.currentPathError);
      const context = structuredClone(item.context);
      context.outputs = { [item.node.id]: structuredClone(item.original_output || {}) };
      let next = item.node.outputs?.on_success, steps = 0;
      const actions = [];
      while (next && steps++ < 100) {
        const node = item.nodes.find(n => n.id === next); assert(node);
        if (node.type === 'condition/field_check') {
          const r = await engine._processNode(node, context, { simulation: true });
          context.outputs[node.id] = r.output; next = r.next_node_id;
        } else if (node.type.startsWith('action/')) {
          if (node.type === 'action/change_status' && node.config?.target_entity !== 'lead') actions.push(node);
          next = node.outputs?.on_success;
        } else break;
      }
      assert(steps < 100);
      result.routedCases++;
      for (const node of actions) {
        result.stateActions++;
        for (const estado of ['ha_acudido', 'en_atencion', 'completada']) {
          appointment = { id_cita: 1, clinica_id: 100, paciente_id: 2, estado,
            inicio: new Date('2026-10-08T09:00:00Z'), fin: new Date('2026-10-08T10:00:00Z'),
            toJSON() { return { ...this }; }, update() { clinicalWrites++; throw Error('LOCAL_CARE_QA_CLINICAL_WRITE_FORBIDDEN'); } };
          const synthetic = { appointment: { id_cita: 1, estado, clinica_id: 100, paciente_id: 2 }, outputs: {} };
          const r = await engine._handleChangeStatus(node, synthetic, {});
          assert.equal(appointment.estado, estado);
          assert.equal(r.output.skipped, true);
          assert.equal(r.output.reason, 'appointment_status_protected');
          result.protectedTransitions++;
        }
      }
      for (const estado of ['ha_acudido', 'en_atencion', 'completada']) {
        const row = { id_cita: 1, clinica_id: 100, paciente_id: 2, estado,
          inicio: '2026-10-08T09:00:00Z', fin: '2026-10-08T10:00:00Z' };
        assert.throws(() => require('../../lib/whatsappAppointmentEligibility').assertAppointmentEligibility({
          appointment: row, clinicId: 100, patientId: 2, now: Date.parse('2026-10-08T08:00:00Z'),
          execution: { trigger_type: 'appointment_reminder_window', trigger_entity_id: 1,
            context: { appointment: { inicio: row.inicio } } },
        }), { code: 'whatsapp_appointment_care_stage_ineligible' });
        result.phaseSendGuards++;
      }
    } catch (error) { result.failures.push({ caseOrdinal: index + 1, code: error.code || error.message }); }
  }
  assert.equal(clinicalWrites, 0); assert.equal(providerCalls, 0);
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result));
  if (result.failures.length) process.exitCode = 1;
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
