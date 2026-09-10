'use strict';

// Opt-in SQL proof. Only session-local temporary tables receive synthetic rows.
const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const db = require('../../../models');
const { enqueueUniqueJobRequest } = require('../../services/jobRequests.service');
const { enqueueMetaLeadLifecycleSignal } = require('../../services/metaLeadLifecycleJob.service');
const { persistLeadWithCrmSignals, enqueueCreatedAppointmentCrmSignals } = require('../../services/leadCrmSignalPersistence.service');
const { maybeUploadLeadLifecycleConversion } = require('../../services/leadLifecycleConversion.service');
const { createAppointmentWithPatientLanguage } = require('../../lib/patient-language');

async function main() {
  assert.equal(process.env.CC_QA_MYSQL_ATOMIC, 'true', 'Explicit temporary-table QA flag required');
  assert.notEqual(process.env.CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED, 'true', 'Customer activation must remain closed');
  const source = db.sequelize;
  const sequelize = new Sequelize(source.config.database, source.config.username, source.config.password,
    { ...source.options, logging: false, pool: { min: 1, max: 1, idle: 600000 }, retry: { max: 0 } });
  const models = {
    Lead: require('../../../models/leadintake')(sequelize, DataTypes),
    Appointment: require('../../../models/citapaciente')(sequelize, DataTypes),
    Job: require('../../../models/jobrequest')(sequelize, DataTypes),
  };
  const tables = [];
  const quote = table => sequelize.getQueryInterface().queryGenerator.quoteTable(table);
  try {
    for (const [key, model] of Object.entries(models)) {
      const original = model.getTableName();
      const temporary = `tmp_cc_crm_atomic_${key.toLowerCase()}`;
      await sequelize.query(`CREATE TEMPORARY TABLE ${quote(temporary)} LIKE ${quote(original)}`);
      tables.push(temporary); model.tableName = temporary; model.options.tableName = temporary;
      assert.equal(model.getTableName(), temporary);
      assert.equal(model.sequelize, sequelize);
    }
    const { Lead, Appointment, Job } = models;
    let failSchedule = false; let resolutions = 0; let googleCalls = 0;
    const dependencies = { models: { sequelize }, env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' },
      enqueue: (input, options) => enqueueMetaLeadLifecycleSignal(input, { ...options,
        env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true' },
        resolve: async (payload, { transaction }) => {
          assert.ok(transaction); assert.equal(transaction.finished, undefined);
          const lead = await Lead.findByPk(payload.lead_id, { transaction });
          assert.ok(['cualificado', 'citado', 'contactado'].includes(lead.status_lead));
          if (payload.appointment_id) {
            const appointment = await Appointment.findByPk(payload.appointment_id, { transaction });
            assert.equal(appointment.lead_intake_id, lead.id);
          }
          resolutions++; return { authorizationKey: 'a'.repeat(64) };
        },
        enqueue: (request, persistence) => {
          if (failSchedule && request.payload.event_name === 'schedule') throw new Error('qa_queue_failure');
          return enqueueUniqueJobRequest({ ...request, payload: { ...request.payload, __runtime_namespace: 'qa_temporary_only' } },
            { ...persistence, JobRequestModel: Job, sequelizeInstance: sequelize });
        },
      }) };
    const reset = async () => {
      for (const model of Object.values(models)) {
        assert.match(model.getTableName(), /^tmp_cc_crm_atomic_/);
        await model.destroy({ where: {} });
      }
      return Lead.create({ id: 1, clinica_id: 987654, source: 'meta_ads', status_lead: 'contactado' });
    };

    let lead = await reset();
    await persistLeadWithCrmSignals({ lead, changes: { status_lead: 'cualificado' }, dependencies });
    assert.equal((await Lead.findByPk(1)).status_lead, 'cualificado'); assert.equal(await Job.count(), 1);
    const hook = await maybeUploadLeadLifecycleConversion({ lead, eventName: 'qualified_lead', eventId: 'lead-1-qualified',
      dependencies: { google: async () => { googleCalls++; return { sent: true }; },
        enqueueMeta: () => assert.fail('The post-commit hook must not enqueue again') } });
    assert.equal(hook.meta.queued, true); assert.equal(googleCalls, 1); assert.equal(await Job.count(), 1);
    console.log('OK MySQL qualification and job commit together; post-commit Google is independent');

    lead = await reset();
    let appointment = await Appointment.create({ id_cita: 3, clinica_id: 987654, paciente_id: 987654,
      estado: 'pendiente', inicio: new Date(), fin: new Date(Date.now() + 3600000) });
    failSchedule = true;
    await assert.rejects(persistLeadWithCrmSignals({ lead, appointment, changes: { status_lead: 'citado' }, dependencies }),
      { code: 'meta_crm_outbox_persistence_failed' });
    assert.equal((await Lead.findByPk(1)).status_lead, 'contactado');
    assert.equal((await Appointment.findByPk(3)).lead_intake_id, null); assert.equal(await Job.count(), 0);
    console.log('OK MySQL second-job failure rolls back the first job, appointment link and lead status');

    lead = await Lead.findByPk(1); appointment = await Appointment.findByPk(3); failSchedule = false;
    await persistLeadWithCrmSignals({ lead, appointment, changes: { status_lead: 'citado' }, dependencies });
    assert.equal((await Appointment.findByPk(3)).lead_intake_id, 1); assert.equal(await Job.count(), 2);
    await persistLeadWithCrmSignals({ lead, appointment, changes: { status_lead: 'citado' }, dependencies });
    assert.equal(await Job.count(), 2, 'Active-job deduplication uses the inherited SQL transaction');
    console.log('OK MySQL link commits both jobs and repeated linking does not duplicate them');

    lead = await reset(); failSchedule = true;
    await assert.rejects(createAppointmentWithPatientLanguage({ sequelize, AppointmentModel: Appointment,
      appointmentValues: { id_cita: 3, clinica_id: 987654, paciente_id: 987654, lead_intake_id: 1,
        estado: 'pendiente', inicio: new Date(), fin: new Date(Date.now() + 3600000) },
      patient: null, requestedLanguage: null,
      afterPersist: (created, transaction) => enqueueCreatedAppointmentCrmSignals({ lead, appointment: created,
        transaction, dependencies }) }), { code: 'meta_crm_outbox_persistence_failed' });
    assert.equal(await Appointment.count(), 0); assert.equal(await Job.count(), 0);
    console.log('OK MySQL creation rollback leaves no appointment and no signal job');
    assert.ok(resolutions >= 7);
    console.log(JSON.stringify({ checks: 4, temporaryTables: tables.length, providerCalls: 0, customerWrites: 0 }));
  } finally {
    try {
      for (const table of tables.reverse()) await sequelize.query(`DROP TEMPORARY TABLE IF EXISTS ${quote(table)}`);
    } finally { await sequelize.close(); }
  }
}

main().catch(error => { console.error(error.code || error.name || 'atomic_sql_qa_failed'); process.exitCode = 1; })
  .finally(() => db.sequelize.close());
