'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const inbound = require('../../services/automationInboundMessage.service');
const flowEngine = require('../../services/flowEngineV2.service');

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
    nodes
      .filter((node) => node?.type === 'condition/ai_analysis' && node?.config?.preset_key === 'classify_intent')
      .forEach((node) => canonicalNodes.push({ template, node }));
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
  return canonicalNodes.length;
}

Promise.all([
  testAtomicOutboxAndDuplicateClaim(),
  testEveryPublishedCanonicalAiNodeRunsRealPatientRegressions(),
])
  .then(async ([, canonicalNodeCount]) => {
    console.log(`inbound_appointment_intent_integration.test.js OK (${canonicalNodeCount} canonical nodes)`);
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_closeError) {}
    process.exit(1);
  });
