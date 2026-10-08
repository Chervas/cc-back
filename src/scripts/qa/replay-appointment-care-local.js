'use strict';

// Reuse historical analysis outputs, not a new inference. Current field-check
// nodes and the actual final state writer run with in-memory appointment rows;
// provider, SQL and queue sockets are forbidden by the offline fixture.
const fs = require('node:fs'), assert = require('node:assert/strict'), crypto = require('node:crypto');
require('../tests/fixtures/campaign_offline_runtime.cjs');
const { loadSource } = require('../tests/fixtures/business_profile_flow_runtime.fixture');
const args = process.argv.slice(2), arg = name => args[args.indexOf(name) + 1];
const input = arg('--cases'), output = arg('--report');
if (!input?.startsWith('/home/ubuntu/secure-imports/') || !output?.startsWith('/home/ubuntu/secure-imports/')
  || fs.existsSync(output)) throw Error('NEW_PRIVATE_CARE_QA_REPORT_REQUIRED');
const cases = JSON.parse(fs.readFileSync(input)).cases;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  const result = { mode: 'local_historical_outputs_current_graphs', newInference: false,
    limitations: 'Does not measure new model decisions. Uses stored historical output only to traverse current field checks and test care-state protection.',
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
