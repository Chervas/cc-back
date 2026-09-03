'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const inbound = require('../../services/automationInboundMessage.service');
const flowEngine = require('../../services/flowEngineV2.service');
const {
  markCanonicalConfirmationReplySuppression,
} = require('../../lib/automation-intent-migration');

function appointmentReplyContext(patientText) {
  return {
    conversation_today: [
      '[03/09/2026, 09:00] Clínica: ¿Me confirmas tu asistencia mañana?',
      `[03/09/2026, 09:10] Paciente: ${patientText}`,
    ].join('\n'),
    last_response: patientText,
    last_response_context: {
      response_text: patientText,
      response_lines: [patientText],
      response_message_type: 'text',
    },
    trigger: {
      type: 'appointment_reminder_window',
      data: { appointment_candidate_count: 1 },
    },
    appointment: { estado: 'recordatorio_enviado' },
  };
}

async function testAtomicOutboxAndDuplicateClaim() {
  const clinic = await db.Clinica.findOne({
    attributes: ['id_clinica'],
    order: [['id_clinica', 'ASC']],
    raw: true,
  });
  assert.ok(clinic?.id_clinica, 'DEV needs at least one clinic for the transactional fixture');

  const transaction = await db.sequelize.transaction();
  try {
    const fixtureKey = `qa-automation-outbox-${Date.now()}`;
    const conversation = await db.Conversation.create({
      clinic_id: clinic.id_clinica,
      channel: 'whatsapp',
      contact_id: fixtureKey,
      patient_id: null,
      lead_id: null,
      last_message_at: new Date(),
      last_inbound_at: new Date(),
      unread_count: 1,
    }, { transaction });
    const message = await db.Message.create({
      conversation_id: conversation.id,
      direction: 'inbound',
      content: 'QA synthetic inbound message',
      message_type: 'text',
      status: 'delivered',
      metadata: { wamid: fixtureKey },
      sent_at: new Date(),
    }, { transaction });

    const input = {
      inboundMessage: message,
      conversation,
      clinicId: clinic.id_clinica,
      channel: 'whatsapp',
      providerMessageId: fixtureKey,
    };
    const first = await inbound.enqueueInboundDispatch(input, { transaction });
    const duplicate = await inbound.enqueueInboundDispatch(input, { transaction });

    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.already_dispatched, true);
    assert.equal(Number(duplicate.claim.id), Number(first.claim.id));

    const claims = await db.AutomationInboundMessageClaim.findAll({
      where: { message_id: message.id },
      transaction,
    });
    const jobs = await db.JobRequest.findAll({
      where: { type: 'automation_inbound_dispatch', origin: 'inbound_message_outbox' },
      transaction,
    });
    const fixtureJobs = jobs.filter((job) => Number(job.payload?.message_id) === Number(message.id));
    assert.equal(claims.length, 1);
    assert.equal(fixtureJobs.length, 1);
    assert.equal(claims[0].status, 'queued');
    assert.equal(Number(claims[0].owner_reference_id), Number(fixtureJobs[0].id));
    assert.deepEqual(
      Object.keys(fixtureJobs[0].payload)
        .filter((key) => !key.startsWith('_'))
        .sort(),
      ['channel', 'claim_id', 'clinic_id', 'conversation_id', 'message_id'],
    );
    assert.equal(Object.prototype.hasOwnProperty.call(fixtureJobs[0].payload, 'content'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(fixtureJobs[0].payload, 'patient'), false);
  } finally {
    await transaction.rollback();
  }
}

async function testEveryPublishedCanonicalAiNodeRunsRealPatientRegressions() {
  const published = await db.AutomationFlowTemplateV2.findAll({
    where: { published_at: { [db.Sequelize.Op.ne]: null } },
    attributes: ['id', 'public_id', 'version', 'nodes'],
    order: [['public_id', 'ASC'], ['version', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  const latest = new Map();
  for (const template of published) {
    if (!latest.has(template.public_id)) latest.set(template.public_id, template);
  }

  const canonicalNodes = [];
  for (const template of latest.values()) {
    const nodes = Array.isArray(template.nodes)
      ? template.nodes
      : JSON.parse(template.nodes || '[]');
    assert.equal(
      nodes.some((node) => ['confirm_appointment', 'appointment_unconfirmed_reply'].includes(node?.config?.preset_key)),
      false,
      `latest published template ${template.public_id} still uses a legacy appointment preset`
    );
    const templateCanonicalNodes = nodes.filter(
      (node) => node?.type === 'condition/ai_analysis' && node?.config?.preset_key === 'classify_intent'
    );
    if (templateCanonicalNodes.length) {
      assert.equal(
        markCanonicalConfirmationReplySuppression(nodes).changed,
        false,
        `latest published template ${template.public_id} can still send a generic confirmation while a reply is pending`
      );
    }
    for (const node of templateCanonicalNodes) {
      const legacyReaders = nodes.filter((candidate) => (
        candidate?.config?.left_ref?.source === 'node_output'
        && candidate?.config?.left_ref?.node_id === node.id
        && ['decision', 'confirmado'].includes(candidate?.config?.left_ref?.path)
      ));
      assert.equal(
        legacyReaders.length,
        0,
        `latest published template ${template.public_id} still reads a legacy AI output`
      );
      canonicalNodes.push({ template, node });
    }
  }
  assert.ok(canonicalNodes.length > 0, 'DEV must expose published canonical appointment AI nodes');

  const regressions = [
    'Buenos dias, si confirmo la asistencia',
    'Hola! No es molestia, gracias por el recordatorio. Mañana estaré allí. Gracias!',
  ];
  for (const { template, node } of canonicalNodes) {
    for (const text of regressions) {
      const result = await flowEngine._processNode(
        node,
        appointmentReplyContext(text),
        { simulation: true }
      );
      assert.equal(result.kind, 'success', `template ${template.public_id} did not complete its AI node`);
      assert.equal(result.next_node_id, node.outputs?.on_success || null);
      assert.equal(result.output?.intencion_principal, 'confirmar_cita');
      assert.equal(result.output?.accion_inequivoca, true);
    }
  }

  const representativesByConfig = new Map();
  for (const entry of canonicalNodes) {
    const signature = JSON.stringify(entry.node.config || {});
    if (!representativesByConfig.has(signature)) representativesByConfig.set(signature, entry);
  }
  const intentMatrix = [
    {
      name: 'confirmation with a pending question',
      text: 'Confirmado. ¿Podéis darme la dirección?',
      intent: 'confirmar_cita',
      secondary: 'pregunta',
      unambiguous: true,
      needsResponse: true,
    },
    {
      name: 'contextual thanks',
      text: 'Gracias',
      intent: 'confirmar_cita',
      secondary: '',
      unambiguous: true,
      needsResponse: false,
    },
    {
      name: 'cancellation',
      text: 'No puedo asistir, cancelad la cita por favor.',
      intent: 'cancelar_cita',
      secondary: '',
      unambiguous: true,
      needsResponse: false,
    },
    {
      name: 'reschedule request',
      text: 'No puedo asistir, ¿podemos cambiarla al martes?',
      intent: 'solicitar_cambio_cita',
      secondary: 'pregunta',
      unambiguous: true,
      needsResponse: true,
    },
    {
      name: 'possible urgency',
      text: 'Tengo un sangrado intenso y quiero cancelar la cita.',
      intent: 'urgencia_posible',
      secondary: '',
      unambiguous: false,
      needsResponse: true,
    },
    {
      name: 'question without appointment action',
      text: '¿Podéis darme la dirección?',
      intent: 'pregunta',
      secondary: '',
      unambiguous: false,
      needsResponse: true,
    },
  ];
  for (const { template, node } of representativesByConfig.values()) {
    for (const scenario of intentMatrix) {
      const result = await flowEngine._processNode(
        node,
        appointmentReplyContext(scenario.text),
        { simulation: true }
      );
      assert.equal(result.kind, 'success', `${template.public_id}: ${scenario.name}`);
      assert.equal(result.next_node_id, node.outputs?.on_success || null, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.intencion_principal, scenario.intent, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.intencion_secundaria, scenario.secondary, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.accion_inequivoca, scenario.unambiguous, `${template.public_id}: ${scenario.name}`);
      assert.equal(result.output?.necesita_respuesta, scenario.needsResponse, `${template.public_id}: ${scenario.name}`);
    }
  }

  return {
    canonicalNodeCount: canonicalNodes.length,
    canonicalConfigCount: representativesByConfig.size,
    matrixScenarioCount: intentMatrix.length,
  };
}

Promise.all([
  testAtomicOutboxAndDuplicateClaim(),
  testEveryPublishedCanonicalAiNodeRunsRealPatientRegressions(),
])
  .then(async ([, coverage]) => {
    console.log(
      'inbound_appointment_intent_integration.test.js OK '
      + `(${coverage.canonicalNodeCount} canonical nodes, `
      + `${coverage.canonicalConfigCount} configurations x ${coverage.matrixScenarioCount} matrix scenarios)`
    );
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_closeError) {}
    process.exit(1);
  });
