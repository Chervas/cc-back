'use strict';

const assert = require('node:assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const inbound = require('../../services/automationInboundMessage.service');

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

testAtomicOutboxAndDuplicateClaim()
  .then(async () => {
    console.log('inbound_appointment_intent_integration.test.js OK');
    await db.sequelize.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    try { await db.sequelize.close(); } catch (_closeError) {}
    process.exit(1);
  });
