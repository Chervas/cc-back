#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const migration = require('../../../migrations/20260905210000-prepare-unified-appointment-rescheduled-v7');
const flowEngine = require('../../services/flowEngineV2.service');
const { validateFlowPayloadForInternalUse } = require('../../controllers/automationsV2.controller');

async function evaluate(node, context) {
  return flowEngine._processNode(node, context, { simulation: true });
}

async function run() {
  const [genericSource, patientSource, activeSource] = await Promise.all([
    db.AutomationFlowTemplateV2.findOne({
      where: {
        public_id: migration._test.TARGET_PUBLIC_ID,
        version: migration._test.SOURCE_VERSION,
      },
      raw: true,
    }),
    db.AutomationFlowTemplateV2.findOne({
      where: {
        public_id: migration._test.PATIENT_SOURCE_PUBLIC_ID,
        version: migration._test.SOURCE_VERSION,
      },
      raw: true,
    }),
    db.AutomationFlowTemplateV2.findOne({
      where: {
        public_id: migration._test.TARGET_PUBLIC_ID,
        version: migration._test.ACTIVE_VERSION,
      },
      raw: true,
    }),
  ]);
  const nodes = migration._test.buildTargetNodes(genericSource, patientSource, activeSource);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  assert.equal(nodes.length, 90);
  assert.equal(byId.get('N1').outputs.on_success, 'N70');
  assert.equal(byId.get('N70').config.display_label, '¿Quién solicitó el cambio?');
  assert.deepEqual(byId.get('N70').outputs, {
    branch_patient_request: 'N72',
    branch_clinic_schedule: 'N2',
    on_else: 'N71',
  });
  assert.equal(byId.get('N72').config.template_name, 'clinicaclick_cita_reprogramada_peticion_paciente');
  assert.equal(byId.get('N3').config.template_name, 'clinicaclick_confirmacion_datos_cita_reprogramada_hoy');
  assert.equal(byId.get('N4').config.template_name, 'clinicaclick_confirmacion_datos_cita_reprogramada_24');
  assert.equal(byId.get('N5').config.template_name, 'clinicaclick_confirmacion_datos_cita_reprogramada_48');
  assert.equal(byId.get('N4').config.language_routing.enabled, true);
  assert.equal(byId.get('N2').outputs.on_else, 'N94');

  for (const node of nodes.filter((item) => item.type === 'delay/wait_response')) {
    assert.equal(node.config.response_buffer_enabled, true);
    assert.equal(node.config.response_buffer_delay_seconds, 90);
  }

  const waitCases = [
    ['N7', 2, 'N9', 'N18'],
    ['N13', 2, null, 'N14'],
    ['N23', 2, 'N27', 'N24'],
    ['N45', 12, null, 'N28'],
    ['N34', 2, 'N39', 'N35'],
    ['N44', 12, null, 'N40'],
    ['N74', 2, 'N75', 'N77'],
    ['N76', 12, null, 'N85'],
  ];
  for (const [id, timeoutDuration, timeoutTarget, responseTarget] of waitCases) {
    const node = byId.get(id);
    assert.equal(node.config.timeout_unit, 'hours');
    assert.equal(node.config.timeout_duration, timeoutDuration);
    assert.equal(node.outputs.on_timeout, timeoutTarget);
    assert.equal(node.outputs.on_response, responseTarget);
  }

  for (const id of ['N18', 'N14', 'N28', 'N24', 'N40', 'N35', 'N77', 'N85']) {
    assert.equal(byId.get(id).config.preset_key, 'confirm_appointment');
    assert.equal(byId.get(id).config.preset_contract_version, 2);
    assert.equal(byId.get(id).outputs.on_fail, 'N93');
  }

  const originCases = [
    ['patient_request', 'N72'],
    ['clinic_schedule', 'N2'],
    ['unknown', 'N71'],
  ];
  for (const [reason, expected] of originCases) {
    const result = await evaluate(byId.get('N70'), {
      trigger: { data: { reschedule_reason: reason } },
      outputs: {},
    });
    assert.equal(result.next_node_id, expected);
  }

  const decisionCases = [
    [{ confirma_asistencia: true, confianza_confirma_asistencia: 0.96, requiere_respuesta: false }, 'N79'],
    [{ confirma_asistencia: true, confianza_confirma_asistencia: 0.96, requiere_respuesta: true, confianza_requiere_respuesta: 0.96 }, 'N81'],
    [{ confirma_asistencia: false, confianza_confirma_asistencia: 0.96, requiere_respuesta: true }, 'N83'],
    [{ confirma_asistencia: true, confianza_confirma_asistencia: 0.84, requiere_respuesta: false }, 'N84'],
  ];
  for (const [output, expected] of decisionCases) {
    const result = await evaluate(byId.get('N78'), { outputs: { N77: output } });
    assert.equal(result.next_node_id, expected);
  }

  const timingCases = [
    ['2026-09-05T09:00:00Z', '2026-09-05T12:00:00Z', 'N3'],
    ['2026-09-04T09:00:00Z', '2026-09-05T12:00:00Z', 'N4'],
    ['2026-09-01T09:00:00Z', '2026-09-05T12:00:00Z', 'N5'],
  ];
  for (const [updatedAt, appointmentStart, expected] of timingCases) {
    const result = await evaluate(byId.get('N2'), {
      trigger: {
        type: 'appointment_rescheduled',
        data: { updated_at: updatedAt },
      },
      appointment: { inicio: appointmentStart, updated_at: updatedAt },
      clinic: { timezone: 'UTC' },
      outputs: {},
    });
    assert.equal(result.next_node_id, expected);
  }

  const validation = await validateFlowPayloadForInternalUse({
    entry_node_id: genericSource.entry_node_id,
    trigger_type: genericSource.trigger_type,
    trigger_config: { reschedule_reasons: [...migration._test.RESCHEDULE_REASONS] },
    nodes,
  });
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  const activeRows = await db.AutomationFlowTemplateV2.findAll({
    where: {
      public_id: [migration._test.TARGET_PUBLIC_ID, migration._test.PATIENT_SOURCE_PUBLIC_ID],
      is_active: true,
    },
    attributes: ['public_id', 'version'],
    raw: true,
  });
  assert.deepEqual(activeRows.map((row) => ({
    public_id: row.public_id,
    version: Number(row.version),
  })), [{
    public_id: migration._test.TARGET_PUBLIC_ID,
    version: migration._test.DRAFT_VERSION,
  }]);
  const activeUnified = await db.AutomationFlowTemplateV2.findOne({
    where: {
      public_id: migration._test.TARGET_PUBLIC_ID,
      version: migration._test.DRAFT_VERSION,
    },
    attributes: ['is_system'],
    raw: true,
  });
  assert.equal(Boolean(activeUnified?.is_system), true);

  const catalog = await db.AutomationFlowCatalog.findOne({
    where: { name: migration._test.CATALOG_NAME },
    attributes: ['template_key', 'template_version'],
    raw: true,
  });
  assert.equal(catalog?.template_key, migration._test.TARGET_PUBLIC_ID);
  assert.equal(Number(catalog?.template_version), migration._test.DRAFT_VERSION);

  console.log('Unified appointment rescheduled v7: ok');
}

run().then(async () => {
  await db.sequelize.close();
  process.exit(0);
}).catch(async (error) => {
  console.error(error);
  try { await db.sequelize.close(); } catch (_closeError) {}
  process.exit(1);
});
