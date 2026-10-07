'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createTemporaryPatientDirectionService } = require('../../services/temporaryPatientDirection.service');
const { temporaryQuickChatEligibilitySql, attachTemporaryQuickChatEligibility } = require('../../lib/temporary-quickchat-focus');

test('temporary attention: actual models, SQL locks, commit/rollback and list projection without provider access', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Clinicas', timestamps: false });
  sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } }, { tableName: 'Pacientes', timestamps: false });
  for (const file of ['usuario', 'leadintake', 'leadcontactattempt', 'citapaciente', 'conversation', 'message', 'patientoperationalevent']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = 'temporary_attention_poe_' + i; });
  await sql.sync();
  await sql.models.Clinica.bulkCreate([66, 72, 77, 35].map(id_clinica => ({ id_clinica })));
  await sql.models.Paciente.bulkCreate([100, 101, 102].map(id_paciente => ({ id_paciente })));
  await db.Usuario.create({ id_usuario: 44, nombre: 'Graci', email_usuario: 'maria.gonzalez@modmarketing.net' });
  const lead = await db.LeadIntake.create({ clinica_id: 72 });
  const conversation = await db.Conversation.create({ clinic_id: 72, channel: 'whatsapp', lead_id: lead.id });
  const notifications = [], warnings = [];
  const service = createTemporaryPatientDirectionService(db, { notify: event => notifications.push(event.id), warn: code => warnings.push(code) });
  await Promise.all(Array.from({ length: 10 }, () => service.observeConversation(conversation)));
  assert.equal((await lead.reload()).asignado_a, 44);
  assert.equal(await db.Message.count(), 1, 'row lock plus unique identity deduplicates concurrent observations');
  const [active] = await service.enrich([conversation]);
  assert.equal(active.patient_direction.mode, 'temporary_clinic_phone');
  assert.equal(active.patient_direction.director_name, 'Graci', 'real Usuario uses email_usuario, not email');
  await conversation.update({ patient_id: 100 });
  const tomorrow = new Date(Date.now() + 86400000);
  const appointment = await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 100, lead_intake_id: lead.id,
    created_by: 99, inicio: tomorrow, fin: new Date(+tomorrow + 1800000), estado: 'info_confirmada' });
  await service.observeAppointment(appointment);
  assert.equal((await service.enrich([conversation]))[0].patient_direction.status, 'active');
  await db.CitaPaciente.create({ clinica_id: 72, paciente_id: 101, lead_intake_id: lead.id,
    inicio: new Date(+tomorrow - 1000), fin: tomorrow, estado: 'completada' });
  await service.observeAppointment(appointment);
  assert.equal(await db.Message.count(), 1, 'same lead does not override the exact patient identity');
  const predicate = temporaryQuickChatEligibilitySql();
  const [[before]] = await sql.query('SELECT ' + predicate + ' AS eligible FROM Conversations AS Conversation WHERE id=:id',
    { replacements: { id: conversation.id } });
  assert.equal(before.eligible, 1);
  const marker = await db.Message.findOne();
  assert.equal(marker.sender_id, null);
  assert.equal(marker.message_type, 'event');
  assert.equal(marker.status, 'sent');
  assert.equal(marker.metadata.source, 'temporary_patient_direction');
  report.checks.push('Real core model schema, one marker under ten concurrent SQL transactions, lead assignment and conversion preserve ownership without creating a WhatsApp job.');

  const rollbackConversation = await db.Conversation.create({ clinic_id: 66, patient_id: 102, channel: 'whatsapp' });
  const transaction = await sql.transaction();
  await service.observeConversation(rollbackConversation, { transaction, actorUserId: 44 });
  await transaction.rollback();
  assert.equal(await db.Message.count({ where: { conversation_id: rollbackConversation.id } }), 0);
  await sql.transaction(async transaction => {
    await appointment.update({ estado: 'completada' }, { transaction });
    await service.observeAppointment(appointment, { transaction });
  });
  assert.equal(await db.Message.count(), 2);
  assert.equal((await service.enrich([conversation]))[0].patient_direction, null);
  const [eligibility] = await attachTemporaryQuickChatEligibility([conversation.toJSON()],
    { userId: 44, email: 'maria.gonzalez@modmarketing.net' }, db.CitaPaciente);
  assert.equal(eligibility.quickchat_list_eligible, false);
  await service.observeAppointment(appointment);
  assert.equal(await db.Message.count(), 2);
  assert.equal(notifications.length, 2);
  report.checks.push('After-commit only, rollback leaves no marker; first actual completion writes one handoff and removes the conversation from Graci habitual list, not clinic ACLs.');

  const unrelated = await db.Conversation.create({ clinic_id: 77, patient_id: 102, channel: 'whatsapp' });
  await service.observeConversation(unrelated);
  assert.equal(await db.Message.count({ where: { conversation_id: unrelated.id } }), 0, 'reading does not claim an unrelated patient');
  await db.PatientOperationalEvent.drop();
  await sql.transaction(async transaction => {
    await appointment.update({ nota: 'Synthetic clinical operation committed' }, { transaction });
    await service.observeConversation(unrelated, { transaction });
  });
  assert.equal((await appointment.reload()).nota, 'Synthetic clinical operation committed');
  assert.equal(warnings.at(-1), 'ER_NO_SUCH_TABLE');
  report.checks.push('Missing tracking schema is isolated after commit: synthetic clinical operation remains committed; no Meta, Redis or real database connection occurred.');
}));
