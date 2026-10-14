'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const operations = require('../../lib/whatsappImportedAppointmentOperations');

// Fictitious data, fixture-owned skip-networking mysqld. No application model
// bootstrap, credentials, real patients, jobs, broker, worker or external send.
test('native imported reply SQL resumes fresh received notices with NULL sent_at only on provider evidence and exact current scope',
  { skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const CitaPaciente = sql.define('CitaPaciente', {
      id_cita: { type: Sequelize.INTEGER, primaryKey: true }, clinica_id: Sequelize.INTEGER,
      paciente_id: Sequelize.INTEGER, inicio: Sequelize.DATE(3), estado: Sequelize.STRING(40),
      source_system: Sequelize.STRING(40), source_reference: Sequelize.STRING(120),
      import_metadata: Sequelize.JSON, es_provisional: Sequelize.BOOLEAN,
    }, { tableName: 'CitasPacientes', timestamps: false });
    await CitaPaciente.sync();
    await sql.query(`CREATE TABLE FlowExecutionsV2 (id INT PRIMARY KEY, clinic_id INT NOT NULL,
      template_version_id INT NOT NULL, trigger_type VARCHAR(80) NOT NULL,
      trigger_entity_type VARCHAR(80), trigger_entity_id INT, created_at DATETIME(3) NOT NULL,
      context JSON NOT NULL, status VARCHAR(30) NOT NULL)`);
    await sql.query(`CREATE TABLE Messages (id INT PRIMARY KEY, conversation_id INT NOT NULL,
      direction VARCHAR(20) NOT NULL, message_type VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL,
      createdAt DATETIME(3) NOT NULL, sent_at DATETIME(3), metadata JSON NOT NULL)`);
    await sql.query(`CREATE TABLE PatientCustomFields (id INT PRIMARY KEY, paciente_id INT NOT NULL,
      source VARCHAR(30), value JSON NOT NULL)`);
    const now = Date.parse('2030-01-10T11:00:00.000Z');
    const policy = operations.validate({ version: 1, purpose: 'appointment_operations', approvedBy: 1,
      approvalRef: 'fictitious_fixture_only', approvedAt: '2030-01-10T08:00:00.000Z', clinicIds: [66,72],
      automaticBacklogReplay: false, sameDayAllowed: true }, { now });
    const conversation = { id: 60, clinic_id: 66, patient_id: 20 };
    const inbound = { id: 200, conversation_id: 60, direction: 'inbound', sent_at: '2030-01-10T10:00:00.000Z' };
    const appointment = { id_cita: 10, clinica_id: 66, paciente_id: 20, inicio: '2030-01-10T14:00:00.000Z',
      estado: 'recordatorio_enviado', source_system: 'cliniccloud', source_reference: 'fictitious:10',
      es_provisional: false, import_metadata: { source_account: 'cliniccloud-5880',
        cliniccloud_reconciliation: { automation_policy: 'hold' },
        notification_suppression: { appointment_details: true, day_before: true, same_day: true } } };
    const execution = { id: 50, clinic_id: 66, template_version_id: 30, trigger_type: 'appointment_reminder_window',
      trigger_entity_type: 'appointment', trigger_entity_id: 10, created_at: '2030-01-10 08:30:00.000', status: 'waiting',
      context: { appointment: { id_cita: 10, clinica_id: 66, paciente_id: 20, inicio: appointment.inicio },
        trigger: { schedule_moment: 'same_day' } } };
    const defaultMessage = { id: 100, conversation_id: 60, direction: 'outbound', message_type: 'template',
      status: 'delivered', createdAt: '2030-01-10 08:45:00.000', sent_at: null,
      metadata: { execution_id: 50, template_name: 'clinicaclick_recordatorio_mismo_dia_fictitious',
        wamid: 'wamid.FictitiousAccepted==', provider_acceptance_at: '2030-01-10T09:00:00.000Z' } };
    await sql.query('INSERT INTO PatientCustomFields VALUES (1,20,\'cliniccloud\',:hold)', {
      replacements: { hold: JSON.stringify({ import: { automation_policy: 'hold', messages_enabled: false } }) } });

    async function seed({ a = {}, e = {}, m = {}, receipt = {} } = {}) {
      await CitaPaciente.destroy({ where: {} });
      await sql.query('DELETE FROM FlowExecutionsV2'); await sql.query('DELETE FROM Messages');
      await CitaPaciente.create({ ...appointment, ...a });
      const active = { ...execution, ...e };
      await sql.query(`INSERT INTO FlowExecutionsV2 VALUES (:id,:clinic_id,:template_version_id,:trigger_type,
        :trigger_entity_type,:trigger_entity_id,:created_at,:context,:status)`, {
        replacements: { ...active, context: JSON.stringify(active.context) } });
      const notice = { ...defaultMessage, ...m, metadata: { ...defaultMessage.metadata, ...receipt } };
      await sql.query(`INSERT INTO Messages VALUES (:id,:conversation_id,:direction,:message_type,:status,:createdAt,:sent_at,:metadata)`, {
        replacements: { ...notice, metadata: JSON.stringify(notice.metadata) } });
    }
    const db = { sequelize: sql, CitaPaciente };
    async function allowed({ conv = conversation, reply = inbound } = {}) {
      return sql.transaction({ readOnly: true }, tx => operations.permitsReply(conv, reply, db, tx, { policy, now }));
    }
    async function snapshot() {
      const [[appts]] = await sql.query('SELECT SHA2(GROUP_CONCAT(CONCAT_WS(\'|\',id_cita,clinica_id,paciente_id,inicio,estado,source_system,source_reference,CAST(import_metadata AS CHAR)) ORDER BY id_cita),256) AS sha FROM CitasPacientes');
      const [[patients]] = await sql.query('SELECT SHA2(CAST(value AS CHAR),256) AS sha FROM PatientCustomFields WHERE id=1');
      const [[notices]] = await sql.query('SELECT SHA2(GROUP_CONCAT(CONCAT_WS(\'|\',id,conversation_id,direction,message_type,status,createdAt,COALESCE(sent_at,\'NULL\'),CAST(metadata AS CHAR)) ORDER BY id),256) AS sha FROM Messages');
      const [[flows]] = await sql.query('SELECT SHA2(CONCAT_WS(\'|\',id,status,created_at,CAST(context AS CHAR)),256) AS sha FROM FlowExecutionsV2 WHERE id=50');
      return [appts.sha,patients.sha,notices.sha,flows.sha];
    }

    await seed(); const before = await snapshot();
    assert.equal(await allowed(), true, 'actual MySQL JSON_OBJECT receipt preserves provider strings and JSON nulls');
    assert.deepEqual(await snapshot(), before, 'reply authorization cannot mutate patient HOLD, appointments, messages or executions');

    for (const status of ['sent','delivered','read']) {
      await seed({ m: { status } }); assert.equal(await allowed(), true);
    }
    for (const receipt of [
      { provider_acceptance_at: null, wa_status_timestamps: { delivered: String(Date.parse('2030-01-10T09:05:00Z') / 1000) } },
      { provider_acceptance_at: null, wa_status: { status: 'read', timestamp: Date.parse('2030-01-10T09:06:00Z') / 1000 } },
      { wamid: null, wa_response: { messages: [{ id: 'wamid.FictitiousAccepted==' }] } },
      { wa_response: { messages: [{ id: 'wamid.FictitiousAccepted==' }] } },
    ]) { await seed({ receipt }); assert.equal(await allowed(), true, JSON.stringify(receipt)); }

    const rejected = [
      { receipt: { wamid: null, provider_acceptance_at: null } },
      { receipt: { wamid: 'not-a-provider-id' } },
      { receipt: { provider_acceptance_at: null } },
      { receipt: { provider_acceptance_at: '2030-01-10T07:59:59.000Z' } },
      { receipt: { provider_acceptance_at: '2030-01-10T10:00:01.000Z' } },
      { receipt: { provider_acceptance_at: null, wa_status_timestamps: { delivered: false } } },
      { receipt: { wa_response: { messages: [{ id: 'wamid.OtherFictitiousMessage==' }] } } },
      { receipt: { historical: true } }, { receipt: { qa_demo: true } }, { receipt: { synthetic_data_only: true } },
      { m: { status: 'pending' } }, { m: { status: 'sending' } }, { m: { status: 'failed' } },
      { m: { direction: 'inbound' } }, { m: { message_type: 'event' } }, { m: { conversation_id: 61 } },
      { m: { createdAt: '2030-01-10 07:59:59.000' } }, { m: { createdAt: '2030-01-10 10:00:01.000' } },
      { m: { sent_at: '2030-01-10 07:59:59.000' } }, { m: { sent_at: '2030-01-10 10:00:01.000' } },
      { e: { created_at: '2030-01-10 07:59:59.000' } }, { e: { created_at: '2030-01-10 11:00:01.000' } },
      { e: { clinic_id: 72 } }, { e: { status: 'cancelled' } }, { e: { status: 'completed' } },
      { e: { trigger_entity_type: 'patient' } }, { e: { trigger_type: 'lead_created' } },
      { e: { context: { ...execution.context, appointment: { ...execution.context.appointment, inicio: '2030-01-10T14:01:00.000Z' } } } },
      { e: { context: { ...execution.context, appointment: { ...execution.context.appointment, paciente_id: 21 } } } },
      { a: { paciente_id: 21 } }, { a: { es_provisional: true } }, { a: { estado: 'cancelada' } },
      { a: { inicio: '2030-01-10T10:59:00.000Z' } },
      { a: { import_metadata: { historical_registration: true } } },
    ];
    for (const change of rejected) {
      await seed(change); const original = await snapshot();
      assert.equal(await allowed(), false, JSON.stringify(change));
      assert.deepEqual(await snapshot(), original, 'denied requests also remain read-only');
    }
    await seed({ m: { sent_at: '2030-01-10 09:00:00.000' }, receipt: { wamid: null, provider_acceptance_at: null } });
    assert.equal(await allowed(), true, 'factual sent timestamp remains supported');
    await seed({ a: { source_system: null, source_reference: null, import_metadata: {} } });
    assert.equal(await allowed(), true, 'new native appointment may override only old patient HOLD');
    await seed({ a: { source_system: null, source_reference: null, import_metadata: { automation_policy: 'hold' } } });
    assert.equal(await allowed(), false, 'native appointment manual HOLD remains blocked');
    await seed();
    for (const changes of [
      { conv: { ...conversation, clinic_id: 72 } }, { conv: { ...conversation, patient_id: 21 } },
      { reply: { ...inbound, direction: 'outbound' } }, { reply: { ...inbound, conversation_id: 61 } },
      { reply: { ...inbound, sent_at: '2030-01-10T07:59:59.000Z' } },
      { reply: { ...inbound, sent_at: '2030-01-10T11:00:01.000Z' } },
    ]) assert.equal(await allowed(changes), false, JSON.stringify(changes));
    report.checks.push('Production permitsReply SQL on fixture-owned isolated MySQL: truthful sent clock, NULL sent_at API acceptance/provider sent-delivered-read clocks, provider IDs and matching wa_response, boundary/scope/execution/current-slot guards, historical/synthetic/provisional exclusion, native appointment HOLD denied, and no modifications to patient HOLD/appointments/messages/executions');

    // The cancellation acknowledgement is a continuation of THIS patient's
    // fresh reminder reply, not a new global permission for a held patient.
    const ackExecution = { ...execution, context: { ...execution.context,
      last_response_context: { response_message_id: 200 } } };
    const ack = { id: 101, conversation_id: 60, direction: 'outbound', message_type: 'text', status: 'pending',
      metadata: { execution_id: 50, communication_scope: 'care', appointment_timeout: false } };
    async function seedAcknowledgement({ a = {}, e = {}, receipt = {}, responseMetadata = {}, responseTime = '2030-01-10 10:00:00.000',
      responseConversation = 60, responseDirection = 'inbound' } = {}) {
      await seed({ a: { source_system: null, source_reference: null, import_metadata: {}, estado: 'cancelada', ...a },
        e: { ...ackExecution, ...e }, receipt });
      await sql.query(`INSERT INTO Messages VALUES (200,:conversation,:direction,'text','read',:clock,:clock,:metadata)`, {
        replacements: { conversation: responseConversation, direction: responseDirection, clock: responseTime,
          metadata: JSON.stringify(responseMetadata) } });
    }
    async function acknowledgementAllowed({ supplied = ack, payload = { type: 'text' }, conv = conversation,
      suppliedExecution = ackExecution } = {}) {
      const a = await CitaPaciente.findByPk(10, { raw: true });
      return sql.transaction({ readOnly: true }, transaction => operations.permitsNativeReplyAcknowledgement(a, {
        execution: suppliedExecution, conversation: conv, message: supplied, payload, db, transaction, policy, now }));
    }
    await seedAcknowledgement(); const ackBefore = await snapshot();
    assert.equal(await acknowledgementAllowed(), true, 'actual inbound and post-approval provider receipt resume only this native cancellation ACK');
    assert.deepEqual(await snapshot(), ackBefore, 'native ACK authorization preserves source patient HOLD and all persisted entities');
    for (const change of [
      { responseMetadata: { historical: true } }, { responseMetadata: { revoked: true } },
      { responseMetadata: { revoked_at: '2030-01-10T10:01:00Z' } }, { responseMetadata: { revoke: true } },
      { responseMetadata: { coexistence: { last_event: 'revoke' } } },
      { responseMetadata: { coexistence: { revoked_at: '2030-01-10T10:01:00Z' } } },
      { responseMetadata: { qa_demo: true } }, { responseMetadata: { synthetic_data_only: true } },
      { responseTime: '2030-01-10 07:59:59.000' }, { responseTime: '2030-01-10 11:00:01.000' },
      { responseConversation: 61 }, { responseDirection: 'outbound' },
      { receipt: { wamid: null, provider_acceptance_at: null } },
      { e: { status: 'cancelled' } }, { e: { status: 'completed' } },
      { a: { import_metadata: { automation_policy: 'hold' } } }, { a: { source_reference: 'historic:10' } },
    ]) { await seedAcknowledgement(change); assert.equal(await acknowledgementAllowed(), false, JSON.stringify(change)); }
    await seedAcknowledgement();
    for (const change of [
      { payload: { type: 'template', template: { name: 'clinicaclick_recordatorio_mismo_dia_fixture' } } },
      { payload: { type: 'template', template: { name: 'clinicaclick_confirmacion_datos_cita_hoy_fixture' } } },
      { payload: { type: 'template', template: { name: 'clinicaclick_consent_fixture' } } },
      { payload: { type: 'template', template: { name: 'clinicaclick_review_fixture' } } },
      { supplied: { ...ack, metadata: { ...ack.metadata, communication_scope: 'marketing' } } },
      { supplied: { ...ack, metadata: { ...ack.metadata, appointment_timeout: true } } },
      { supplied: { ...ack, metadata: { ...ack.metadata, execution_id: 51 } } },
      { suppliedExecution: { ...ackExecution, context: { ...ackExecution.context,
        appointment: { ...ackExecution.context.appointment, paciente_id: 21 } } } },
      { suppliedExecution: { ...ackExecution, context: { ...ackExecution.context, last_response_context: { response_message_id: 201 } } } },
    ]) assert.equal(await acknowledgementAllowed(change), false, JSON.stringify(change));
    report.checks.push('Native cancellation ACK SQL requires same-execution accepted outbound and actual scoped fresh inbound; JSON-null projected revocation fields stay null, all revoke/historical/synthetic/foreign/old receipts reject; consent/reviews/marketing/reminders/timeouts/manual appointment HOLD never obtain the ACK exception');
  });
});
