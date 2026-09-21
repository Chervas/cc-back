'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { findUniqueAppointmentLead, recordCreatedAppointmentLead } = require('../../services/appointmentLeadLink.service');
const { registerLeadWhatsappContactAttempt } = require('../../services/manualLeadWhatsappContact.service');
const { createAppointmentWithPatientLanguage } = require('../../lib/patient-language');

test('appointment/lead linkage uses isolated SQL, including rollback and simultaneous contact', async t => {
  await withIsolatedCampaignMysql(async ({ sql, models, report }) => {
    models.Sequelize = Sequelize;
    models.LeadIntake = sql.define('LeadIntake', { id: { type: DataTypes.INTEGER, primaryKey: true },
      clinica_id: DataTypes.INTEGER, telefono: DataTypes.STRING, status_lead: DataTypes.STRING,
      archived_at: DataTypes.DATE, call_initiated: DataTypes.BOOLEAN, call_outcome: DataTypes.STRING,
      call_outcome_at: DataTypes.DATE, call_outcome_notes: DataTypes.STRING, call_outcome_appointment_id: DataTypes.INTEGER,
      historial_contactos: DataTypes.JSON, num_contactos: DataTypes.INTEGER, ultimo_contacto: DataTypes.DATE,
    }, { indexes: [{ fields: ['clinica_id'] }] });
    models.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      clinica_id: DataTypes.INTEGER, paciente_id: DataTypes.INTEGER, lead_intake_id: DataTypes.INTEGER, estado: DataTypes.STRING });
    models.Conversation = sql.define('Conversation', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      clinic_id: DataTypes.INTEGER, patient_id: DataTypes.INTEGER, lead_id: DataTypes.INTEGER });
    models.LeadAttributionAudit = sql.define('LeadAttributionAudit', { lead_intake_id: DataTypes.INTEGER,
      raw_payload: DataTypes.JSON, attribution_steps: DataTypes.JSON });
    models.LeadContactAttempt = sql.define('LeadContactAttempt', { lead_intake_id: DataTypes.INTEGER,
      usuario_id: DataTypes.INTEGER, canal: DataTypes.STRING, motivo: DataTypes.STRING, notas: DataTypes.STRING(500) });
    await sql.sync();
    const reset = async () => { for (const m of Object.values(models)) if (m?.destroy) await m.destroy({ where: {}, truncate: true }); };
    const lead = values => models.LeadIntake.create({ id: 1, clinica_id: 3, telefono: '612345678',
      status_lead: 'contactado', archived_at: null, call_initiated: false, num_contactos: 0, historial_contactos: [], ...values });
    const find = (values = {}) => findUniqueAppointmentLead({ models, clinicId: 3, phone: '+34612345678', patientId: 9, ...values });
    const create = (linked, extra = {}) => createAppointmentWithPatientLanguage({ sequelize: sql,
      AppointmentModel: models.CitaPaciente, patient: { id_paciente: 9 }, appointmentValues: {
        clinica_id: 3, paciente_id: 9, lead_intake_id: linked.id, estado: 'info_confirmada',
      }, afterPersist: async (appointment, transaction) => {
        await recordCreatedAppointmentLead({ models, lead: linked, appointment, transaction,
          autoLinkPhone: '+34612345678', actorId: 7 });
        await extra.afterPersist?.(appointment, transaction);
      } });

    await t.test('a first visit without a previous call commits its lead status and attribution together', async () => {
      await reset(); await lead(); const found = await find(); assert.equal(found.id, 1);
      const appointment = await create(found); const after = await models.LeadIntake.findByPk(1);
      assert.equal(after.status_lead, 'citado'); assert.equal(after.call_outcome_appointment_id, appointment.id_cita);
      assert.equal(after.call_initiated, false); assert.equal(after.call_outcome, null);
      assert.equal(await models.LeadAttributionAudit.count(), 1);
    });
    await t.test('an unrelated clinic and a foreign number with the same suffix are never attributed', async () => {
      await reset(); await lead({ id: 2, clinica_id: 4 }); await lead({ id: 3, telefono: '+1612345678' });
      assert.equal(await find(), null); await lead(); assert.equal((await find()).id, 1);
    });
    await t.test('explicit links preserve attended and terminal states; genuine pending calls still resolve', async () => {
      for (const status of ['acudio_cita', 'convertido', 'descartado']) {
        await reset(); const linked = await lead({ status_lead: status });
        await sql.transaction(async transaction => {
          const appointment = await models.CitaPaciente.create({ clinica_id: 3, paciente_id: 9,
            lead_intake_id: 1, estado: 'pendiente' }, { transaction });
          await recordCreatedAppointmentLead({ models, lead: linked, appointment, transaction });
        });
        assert.equal((await models.LeadIntake.findByPk(1)).status_lead, status);
      }
      await reset(); await lead({ call_initiated: true }); await create(await find());
      const after = await models.LeadIntake.findByPk(1);
      assert.equal(after.status_lead, 'citado'); assert.equal(after.call_outcome, 'citado');
    });
    await t.test('two eligible leads require an explicit choice, even when one has a pending call', async () => {
      await reset(); await lead(); await lead({ id: 2, telefono: '+34612345678', call_initiated: true });
      assert.equal(await find(), null);
    });
    await t.test('archived, discarded and converted leads cannot be silently reopened', async () => {
      for (const values of [{ archived_at: new Date() }, { status_lead: 'descartado' }, { status_lead: 'convertido' }]) {
        await reset(); await lead(values); assert.equal(await find(), null);
      }
    });
    await t.test('a lead already bound to a different patient cannot be taken by phone matching', async () => {
      await reset(); await lead(); await models.Conversation.create({ clinic_id: 3, lead_id: 1, patient_id: 10 });
      assert.equal(await find(), null); await models.Conversation.destroy({ where: {} });
      await models.CitaPaciente.create({ clinica_id: 3, lead_intake_id: 1, paciente_id: 10, estado: 'cancelada' });
      assert.equal(await find(), null);
    });
    await t.test('a late duplicate aborts the booking instead of committing an obsolete selection', async () => {
      await reset(); await lead(); const found = await find(); await lead({ id: 2 });
      await assert.rejects(create(found), { code: 'appointment_lead_link_changed' });
      assert.equal(await models.CitaPaciente.count(), 0); assert.equal(await models.LeadAttributionAudit.count(), 0);
      assert.equal((await models.LeadIntake.findByPk(1)).status_lead, 'contactado');
    });
    await t.test('a failed transaction rolls back appointment, lead status and attribution', async () => {
      await reset(); await lead();
      await assert.rejects(create(await find(), { afterPersist() { throw Error('FICTITIOUS_AFTER_PERSIST_FAILURE'); } }), /FICTITIOUS/);
      assert.equal(await models.CitaPaciente.count(), 0); assert.equal(await models.LeadAttributionAudit.count(), 0);
      const after = await models.LeadIntake.findByPk(1); assert.equal(after.status_lead, 'contactado');
      assert.equal(after.call_outcome_appointment_id, null);
    });
    await t.test('a manual WhatsApp queued while booking waits for the lock and preserves citado', async () => {
      await reset(); await lead(); const found = await find();
      const tx = await sql.transaction(); let contact;
      try {
        const appointment = await models.CitaPaciente.create({ clinica_id: 3, paciente_id: 9, lead_intake_id: 1, estado: 'pendiente' }, { transaction: tx });
        await recordCreatedAppointmentLead({ models, lead: found, appointment, transaction: tx, autoLinkPhone: '+34612345678' });
        let settled = false;
        contact = registerLeadWhatsappContactAttempt({ models, leadId: 1, userId: 7, isTemplate: true, body: 'FICTITIOUS' })
          .finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(settled, false);
        await tx.commit(); await contact;
        assert.equal((await models.LeadIntake.findByPk(1)).status_lead, 'citado');
        assert.equal(await models.LeadContactAttempt.count(), 1);
      } finally { if (!tx.finished) await tx.rollback(); if (contact) await contact; }
    });
    await t.test('failure to record a contact leaves both its counter and history unchanged', async () => {
      await reset(); await lead({ status_lead: 'citado' }); const original = models.LeadContactAttempt.create;
      models.LeadContactAttempt.create = async () => { throw Error('FICTITIOUS_CONTACT_FAILURE'); };
      try { await assert.rejects(registerLeadWhatsappContactAttempt({ models, leadId: 1, userId: 7, body: 'FICTITIOUS' }), /FICTITIOUS/); }
      finally { models.LeadContactAttempt.create = original; }
      const after = await models.LeadIntake.findByPk(1); assert.equal(after.status_lead, 'citado');
      assert.equal(after.num_contactos, 0); assert.deepEqual(after.historial_contactos, []);
    });
    report.checks.push('Unique same-clinic identity; no-call first visit; duplicate/foreign/patient conflict denial; atomic rollback; concurrent manual contact protection');
  });
});
