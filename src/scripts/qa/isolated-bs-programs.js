#!/usr/bin/env node
'use strict';
// Explicit synthetic SQL acceptance. No authentication bypass, app bootstrap,
// external delivery, runtime flag mutation or connection to the clinical DB.
const assert = require('node:assert/strict');
const { prepare, MARKER } = require('./prepare-isolated-clinical-fixture');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, MARKER);
  assert(['prepare', 'verify'].includes(process.argv[2]));
  require('dotenv').config({ quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated');
  assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  for (const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED', 'BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED']) process.env[key] = 'true';
  const db = require('../../../models');
  try {
    const f = await prepare(db);
    const programs = require('../../services/treatmentPrograms.service');
    const economics = require('../../services/patientEconomics.service');
    const booking = require('../../services/patientProgramBooking.service');
    const command = require('../../services/appointmentBookingCommand.service');
    const treatments = [];
    for (const [index, name, price] of [[0, 'Tonificación corporal', 120], [1, 'Suelo pélvico', 85]]) {
      const [treatment] = await db.Tratamiento.findOrCreate({ where: { codigo: `QA-BS-20260920-${index}`, clinica_id: f.clinicId },
        defaults: { nombre: `QA · ${name} · ficticio`, disciplina: 'estetica', categoria: 'Prueba aislada', origen: 'clinica', activo: true,
          duracion_min: 30, precio_base: price, clinical_config: { qa_demo: MARKER, catalog_status: 'active', booking_profile: {
            version: 1, phases: [{ key: 'treatment', label: name, duration_minutes: 30, installation_ids: [f.installationIds[index]],
              professionals: { mode: 'any', ids: f.doctorIds, preferred_id: f.doctorIds[0] } }] } } } });
      const cfg = typeof treatment.clinical_config === 'string' ? JSON.parse(treatment.clinical_config) : treatment.clinical_config;
      assert.equal(cfg.qa_demo, MARKER); treatments.push(treatment.id_tratamiento);
    }
    const purchases = {};
    for (const [kind, name, total, units, selected] of [
      ['tono', 'BS Tono', 620, 6, [treatments[0]]], ['suelo', 'BS Suelo Pélvico', 420, 6, [treatments[1]]],
      ['multicabina', 'Recorrido de dos cabinas', 300, 3, treatments],
    ]) {
      const result = await programs.create({ clinicId: f.clinicId, actorId: f.actorId, payload: {
        idempotency_key: `${MARKER}-${kind}`, name: `QA · ${name} · demostración`, kind: 'program', status: 'active', total_price: total,
        notes: 'Prueba sintética, sin validez clínica ni económica. Los recursos son ficticios; no acredita la configuración real del cliente.',
        cadence: { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 },
        appointments: Array.from({ length: units }, (_, i) => ({ key: `cita_${i + 1}`, label: `Cita ${i + 1}`, offset_days: null, treatment_ids: selected })) } });
      let budget = await db.EconomicBudget.findOne({ where: { clinic_id: f.clinicId, source_reference: `${MARKER}-${kind}` } });
      if (!budget) {
        const created = await economics.createBudget({ patientIdentifier: f.patientPublicId, clinicId: f.clinicId, actorId: f.actorId,
          payload: { status: 'draft', source_system: 'clinicaclick_demo', source_reference: `${MARKER}-${kind}`,
            lines: [{ key: 'program', program_id: result.item.id, program_version: result.item.version, quantity: 1, unit_price: total }],
            notes: 'Presupuesto ficticio de QA. No facturar ni enviar.', payment_proposal: { mode: 'single', included_modes: ['single'] } } });
        budget = await db.EconomicBudget.findOne({ where: { public_id: created.id } });
      }
      if (budget.status === 'draft') await economics.transitionBudget({ publicId: budget.public_id, actorId: f.actorId, action: 'present', payload: { presentation_channel: 'printed' } });
      await budget.reload();
      if (budget.status === 'presented') await economics.transitionBudget({ publicId: budget.public_id, actorId: f.actorId, action: 'accept',
        payload: { selected_payment_mode: 'single', signature_channel: 'not_required', send_channel: 'none', collection_method: 'pending' } });
      const voucher = await db.PatientVoucher.findOne({ where: { clinic_id: f.clinicId, budget_id: budget.id, patient_id: f.patientId, source_system: 'treatment_program' } });
      assert(voucher); purchases[kind] = { voucherId: voucher.public_id, budgetId: budget.public_id };
    }
    const checks = [];
    if (process.argv[2] === 'verify') {
      const options = { clinicId: f.clinicId, actorId: f.actorId, publicId: purchases.multicabina.voucherId };
      const plan = await booking.read(options);
      const proposal = await booking.propose({ ...options, payload: { from_date: '2026-10-05', days: 30 } });
      assert.equal(proposal.proposals.length, 3); assert(proposal.proposals.every(r => r.solution.phases.length === 2));
      checks.push('Real proposal returns three sessions with two sequential cabins');
      const sessions = proposal.proposals.map(r => ({ key: r.key, start_at: r.solution.start_at, selections: {} }));
      const request = { request_key: `${MARKER}-book`, snapshot_sha256: plan.snapshot_sha256, sessions };
      const invalid = structuredClone(request); invalid.request_key += '-invalid'; invalid.sessions[1].selections = { t2_p1: { installation_id: 99999999 } };
      await assert.rejects(booking.book({ ...options, payload: invalid }), { code: 'program_booking_unavailable' });
      assert((await booking.read(options)).sessions.every(r => r.scheduling_status === 'pending'));
      checks.push('Invalid second phase rolls back the entire batch');
      const races = await Promise.allSettled([booking.book({ ...options, payload: request }), booking.book({ ...options, payload: { ...request, request_key: request.request_key + '-race' } })]);
      assert.equal(races.filter(r => r.status === 'fulfilled').length, 1);
      checks.push('Two concurrent confirmations cannot duplicate the purchased sessions');
      const index = races.findIndex(r => r.status === 'fulfilled'); const winner = races[index].value;
      const replay = await booking.book({ ...options, payload: { ...request, request_key: request.request_key + (index ? '-race' : '') } });
      assert(replay.replayed); assert.deepEqual(replay.sessions, winner.sessions);
      checks.push('Replay returns the same canonical appointments');
      const id = winner.sessions[0].appointment_id;
      for (let i = 0; i < 2; i++) await command.mutateAppointmentBooking({ db, existingAppointmentId: id,
        appointmentValues: { estado: 'completada', updated_by: f.actorId }, stateOnly: true,
        persist: ({ existing, values, transaction }) => existing.update(values, { transaction }) });
      const voucher = await db.PatientVoucher.findOne({ where: { public_id: options.publicId } });
      assert.equal(Number(voucher.available_units), 2);
      assert.equal(await db.PatientVoucherMovement.count({ where: { voucher_id: voucher.id, movement_type: 'consumption' } }), 1);
      checks.push('Completing a two-cabin session twice consumes exactly one unit');
      const appointments = await db.CitaPaciente.findAll({ where: { voucher_id: voucher.id } });
      for (const a of appointments) { const m = typeof a.import_metadata === 'string' ? JSON.parse(a.import_metadata) : a.import_metadata; assert(m.notification_suppression.day_before && m.notification_suppression.same_day && m.notification_suppression.appointment_details); }
      checks.push('Every synthetic program appointment remains under HOLD');
    }
    console.log(JSON.stringify({ synthetic_only: true, clinicId: f.clinicId, patientPublicId: f.patientPublicId, purchases, checks }));
  } finally { await db.sequelize.close(); }
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ code: error.code || error.name, message: error.message, details: error.details })); process.exitCode = 1; });
