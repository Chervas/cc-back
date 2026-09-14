#!/usr/bin/env node
'use strict';
// Real SQL and HTTP QA, NEVER app.js/bootstrap/jobs. Explicit synthetic scope.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const marker = 'program-booking-20260914-v1';
const root = '/home/ubuntu/qa-evidence';
async function main() {
  const mode = process.argv[2];
  assert(['--prepare', '--verify', '--verify-documents', '--serve', '--reset-browser'].includes(mode));
  assert.equal(process.cwd(), '/home/ubuntu/wt/back-dev');
  assert.equal(process.env.QA_PROGRAM_DEMO_WRITES, '82');
  require('dotenv').config({ quiet: true });
  for (const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED', 'BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED']) process.env[key] = 'true';
  process.env.RUN_CRON_JOBS = 'false'; process.env.RUN_WORKER = 'false';
  process.env.JOBS_WORKER_ENABLED = 'false'; process.env.JOBS_CRON_LEADER = 'false'; process.env.JOBS_AUTO_START = 'false';
  const db = require('../../models');
  const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
  const clinic = await db.Clinica.findByPk(82);
  assert.equal(parse(clinic.configuracion)?.qa_demo?.key, 'bs-medical-accounting-demo-v1');
  assert.equal(parse(clinic.configuracion)?.qa_demo?.synthetic_data_only, true);
  const patient = await db.Paciente.findOne({ where: { public_id: 'demo_bsmedical_capillary_v1', clinica_id: 82 } }); assert(patient);
  const actor = await db.Usuario.findOne({ where: { email_usuario: 'carlos@clinicaclick.com' } }); assert(actor);
  const actorId = actor.id_usuario;
  const economics = require('../services/patientEconomics.service');
  const programs = require('../services/treatmentPrograms.service');
  const booking = require('../services/patientProgramBooking.service');
  const command = require('../services/appointmentBookingCommand.service');
  const { addDays } = require('../lib/personal-schedule-recurring');
  const { formatDateLocal } = require('../lib/availability-calendar');
  const context = { clinicId: 82, actorId };
  async function purchases() {
    const vouchers = await db.PatientVoucher.findAll({ where: { clinic_id: 82, patient_id: patient.id_paciente, source_system: 'treatment_program' } });
    const result = {};
    for (const kind of ['simple', 'multi', 'regression']) {
      const budget = await db.EconomicBudget.findOne({ where: { clinic_id: 82, source_reference: `${marker}-${kind}` } });
      if (budget) result[kind] = { voucherId: vouchers.find(v => Number(v.budget_id) === Number(budget.id))?.public_id, budgetId: budget.public_id };
    }
    return result;
  }
  try {
    if (mode === '--prepare') {
      const backup = process.env.QA_PROGRAM_BACKUP;
      assert(backup?.startsWith('/home/ubuntu/secure-imports/cliniccloud-dev-schema-') && backup.endsWith('/manifest.json'));
      const manifest = JSON.parse(fs.readFileSync(backup, 'utf8'));
      assert(manifest.backup.bytes > 0 && manifest.migrations.some(row => row.name === '20260914070000-create-patient-program-sessions.js' && row.action === 'applied'));
      assert(fs.statSync(path.join(path.dirname(backup), manifest.backup.file)).size === manifest.backup.bytes);
      const treatments = [];
      for (const [index, room] of [38, 39].entries()) {
        const code = `QA-PROGRAM-PHASE-${index + 1}-20260914`;
        let treatment = await db.Tratamiento.findOne({ where: { codigo: code, clinica_id: 82 } });
        if (treatment) assert.equal(parse(treatment.clinical_config)?.qa_demo, marker);
        else treatment = await db.Tratamiento.create({ codigo: code, nombre: `QA · Paso ${index + 1} del programa (demostración)`, disciplina: 'estetica',
          categoria: 'Demostración · no usar en pacientes reales', clinica_id: 82, origen: 'clinica', activo: true, duracion_min: 30, precio_base: 50,
          clinical_config: { qa_demo: marker, catalog_status: 'active', booking_profile: { version: 1, phases: [{ key: 'treatment', label: `Paso ${index + 1}`, duration_minutes: 30,
            installation_ids: [room], professionals: { mode: 'any', ids: [90], preferred_id: 90 } }] } } });
        treatments.push(treatment.id_tratamiento);
      }
      for (const kind of ['simple', 'multi', 'regression']) {
        const existing = await db.TreatmentProgram.findOne({ where: { clinic_id: 82, request_key: `${marker}-${kind}` } });
        const item = existing ? (await programs.get({ clinicId: 82, id: existing.public_id })).item : (await programs.create({ clinicId: 82, actorId,
          payload: { idempotency_key: `${marker}-${kind}`, name: `QA · Programa ${kind === 'simple' ? 'una cabina' : kind === 'multi' ? 'dos cabinas' : 'regresión'} · DEMO`,
            status: 'active', kind: 'program', total_price: 120, notes: 'Solo demostración. Sin validez clínica ni económica real.',
            cadence: { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 },
            appointments: Array.from({ length: 3 }, (_, i) => ({ key: `session_${i + 1}`, label: `Sesión ${i + 1}`, offset_days: null, treatment_ids: kind === 'simple' ? [treatments[0]] : treatments })) } })).item;
        assert(item?.id);
        let budget = await db.EconomicBudget.findOne({ where: { clinic_id: 82, source_reference: `${marker}-${kind}` } });
        if (!budget) {
          const created = await economics.createBudget({ patientIdentifier: patient.public_id, clinicId: 82, actorId, payload: { status: 'draft', source_system: 'clinicaclick_demo',
            source_reference: `${marker}-${kind}`, lines: [{ key: 'program', program_id: item.id, program_version: item.version, quantity: 1, unit_price: 120 }],
            notes: 'Prueba sintética sin validez real.', payment_proposal: { mode: 'single', included_modes: ['single'] } } });
          budget = await db.EconomicBudget.findOne({ where: { public_id: created.id } });
        }
        if (budget.status === 'draft') await economics.transitionBudget({ publicId: budget.public_id, actorId, action: 'present', payload: { presentation_channel: 'printed' } });
        await budget.reload();
        if (budget.status === 'presented') await economics.transitionBudget({ publicId: budget.public_id, actorId, action: 'accept', payload: {
          selected_payment_mode: 'single', signature_channel: 'not_required', send_channel: 'none', collection_method: 'pending' } });
      }
      const result = await purchases();
      assert(Object.values(result).every(row => row.voucherId));
      console.log(JSON.stringify({ synthetic_only: true, marker, purchases: result, reminders_activated: false }));
    }
    if (mode === '--verify') {
      const fixture = await purchases(); assert(fixture.regression?.voucherId);
      const publicId = fixture.regression.voucherId;
      const options = { ...context, publicId };
      const checks = [];
      const check = (label, truth) => { assert(truth, label); checks.push(label); };
      const initial = await booking.read(options);
      const from = addDays(formatDateLocal(new Date(), 'Europe/Madrid'), 14);
      const proposal = await booking.propose({ ...options, payload: { from_date: from, days: 30 } });
      let winner, winnerKey, payload, rows;
      if (initial.sessions.every(row => row.scheduling_status === 'pending')) {
        check('three real proposals, sequential two-room phases', proposal.proposals.length === 3 && proposal.proposals.every(row => row.solution?.phases.length === 2));
        rows = proposal.proposals.slice(0, 2).map(row => ({ key: row.key, start_at: row.solution.start_at, selections: {} }));
        const invalid = { request_key: 'qa_atomic_failure', snapshot_sha256: initial.snapshot_sha256, sessions: structuredClone(rows) };
        invalid.sessions[1].selections = { t2_p1: { installation_id: 99999999 } };
        await assert.rejects(booking.book({ ...options, payload: invalid }), { code: 'program_booking_unavailable' });
        const after = await booking.read(options);
        check('later-phase conflict rolls back earlier sessions and session ledger', after.sessions.every(row => row.scheduling_status === 'pending'));
        payload = { request_key: 'qa_reserve_once', snapshot_sha256: initial.snapshot_sha256, sessions: rows };
        const results = await Promise.allSettled([booking.book({ ...options, payload }), booking.book({ ...options, payload: { ...payload, request_key: 'qa_competing_request' } })]);
        check('simultaneous reservations: exactly one wins', results.filter(row => row.status === 'fulfilled').length === 1);
        winner = results.find(row => row.status === 'fulfilled').value;
        winnerKey = results[0].status === 'fulfilled' ? 'qa_reserve_once' : 'qa_competing_request';
      } else {
        const voucher = await db.PatientVoucher.findOne({ where: { public_id: publicId, clinic_id: 82 } });
        const receipt = await db.PatientProgramBookingRequest.findOne({ where: { voucher_id: voucher.id, request_key: { [db.Sequelize.Op.in]: ['qa_reserve_once', 'qa_competing_request'] } } });
        assert(receipt); winner = parse(receipt.result); winnerKey = receipt.request_key;
        rows = winner.sessions.map(row => ({ key: row.key, start_at: row.start_at, selections: {} }));
        payload = { request_key: winnerKey, snapshot_sha256: initial.snapshot_sha256, sessions: rows };
      }
        const replay = await booking.book({ ...options, payload: { ...payload, request_key: winnerKey } });
        assert.deepEqual(replay.sessions, winner.sessions); check('replay returns identical appointments', replay.replayed);
        await assert.rejects(booking.book({ ...options, payload: { ...payload, request_key: winnerKey, sessions: [rows[0]] } }), { code: 'program_booking_request_conflict' });
        check('reused request with changed contents rejected', true);
        const id = winner.sessions[0].appointment_id;
        const mutate = (id, values) => command.mutateAppointmentBooking({ db, existingAppointmentId: id, appointmentValues: { ...values, updated_by: actorId }, stateOnly: true,
          persist: ({ existing, values, transaction }) => existing.update(values, { transaction }) });
        const before = await booking.read(options);
        if (before.sessions[0].appointment_id === id) {
          await mutate(id, { estado: 'cancelada' });
          check('cancellation returns unit to pending without consuming', (await booking.read(options)).sessions[0].scheduling_status === 'pending');
        }
        const replacement = await booking.book({ ...options, payload: { ...payload, request_key: 'qa_rebook_cancelled', sessions: [rows[0]] } });
        check('rebooked unit gets one new canonical appointment', replacement.sessions[0].appointment_id !== id);
        await assert.rejects(mutate(id, { estado: 'pendiente' }), { code: 'program_session_replaced' });
        check('superseded historical appointment cannot be restored over replacement', true);
        await mutate(replacement.sessions[0].appointment_id, { estado: 'completada' });
        await mutate(replacement.sessions[0].appointment_id, { estado: 'completada' });
      const secondId = winner.sessions[1].appointment_id;
      const second = await db.CitaPaciente.findByPk(secondId);
      const targetStart = new Date(new Date(winner.sessions[1].start_at).getTime() + 86400000);
      const targetEnd = new Date(targetStart.getTime() + 60 * 60000);
      const change = { inicio: targetStart, fin: targetEnd, estado: 'reprogramada', updated_by: actorId };
      const originalTime = new Date(second.inicio).getTime();
      await assert.rejects(command.mutateAppointmentBooking({ db, existingAppointmentId: secondId, appointmentValues: change,
        selections: { t2_p1: { installation_id: 99999999 } }, persist: ({ existing, values, transaction }) => existing.update(values, { transaction }) }), { code: 'booking_unavailable' });
      await second.reload(); check('failed reschedule preserves original canonical time', new Date(second.inicio).getTime() === originalTime);
      const moved = await command.mutateAppointmentBooking({ db, existingAppointmentId: secondId, appointmentValues: change,
        persist: ({ existing, values, transaction }) => existing.update(values, { transaction }) });
      const phases = parse(moved.import_metadata).booking.phases;
      check('reschedule moves both phases under the same appointment', moved.id_cita === secondId && phases.length === 2 && new Date(phases[0].start_at).getTime() === targetStart.getTime()
        && new Date(phases[1].start_at).getTime() === targetStart.getTime() + 30 * 60000);
      const final = await booking.read(options);
      const voucher = await db.PatientVoucher.findOne({ where: { public_id: publicId, clinic_id: 82 } });
      check('two-room completed session consumes exactly one unit', Number(voucher.available_units) === 2 && final.sessions[0].scheduling_status === 'completed');
      check('one existing canonical consumption movement', await db.PatientVoucherMovement.count({ where: { voucher_id: voucher.id, movement_type: 'consumption' } }) === 1);
      const citas = await db.CitaPaciente.findAll({ where: { voucher_id: voucher.id } });
      check('all QA program appointments retain three suppression flags', citas.every(row => { const suppression = parse(row.import_metadata).notification_suppression; return suppression.appointment_details && suppression.day_before && suppression.same_day; }));
      await assert.rejects(booking.read({ ...options, clinicId: 72 }), { code: 'program_purchase_not_found' });
      check('foreign clinic cannot load purchase', true);
      const dir = fs.mkdtempSync(root + '/program-booking-sql-'); fs.chmodSync(dir, 0o700);
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ marker, checks, synthetic_only: true, purchases: fixture }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ evidence: dir, checks: checks.length, passed: true }));
    }
    if (mode === '--verify-documents') {
      const fixtures = await purchases();
      const plan = await booking.read({ ...context, publicId: fixtures.multi.voucherId });
      const appointmentId = plan.sessions.find(row => row.scheduling_status === 'reserved')?.appointment_id; assert(appointmentId);
      const appointment = await db.CitaPaciente.findByPk(appointmentId);
      assert.equal(appointment.clinica_id, 82); assert.equal(appointment.paciente_id, patient.id_paciente);
      const treatments = await db.Tratamiento.findAll({ where: { clinica_id: 82, codigo: { [db.Sequelize.Op.in]: ['QA-PROGRAM-PHASE-1-20260914', 'QA-PROGRAM-PHASE-2-20260914'] } } });
      assert.equal(treatments.length, 2);
      const consent = require('../services/consentimientos.service');
      const templateName = 'QA · Consentimiento por fase · DEMO 20260914';
      let template = await db.ClinicConsentTemplate.findOne({ where: { clinic_id: 82, name: templateName } });
      if (!template) {
        await consent.createClinicTemplate({ clinic_id: 82, name: templateName, purpose: 'clinical', status: 'active', validity_mode: 'single_act',
          body_html: '<h1>Documento ficticio de QA: sin validez clínica</h1><p>Tratamiento: {{tratamiento.nombre}}</p>',
          tratamiento_ids: treatments.map(row => row.id_tratamiento), apply_to_group: false }, actorId);
        template = await db.ClinicConsentTemplate.findOne({ where: { clinic_id: 82, name: templateName } });
      }
      assert(template);
      const first = await consent.ensurePackageForAppointment(appointmentId, { createdBy: actorId, triggerSource: 'synthetic_program_qa' });
      const documents = await db.PatientConsentDocument.findAll({ where: { cita_id: appointmentId, clinica_id: 82, clinic_template_id: template.id } });
      assert.equal(documents.length, 2);
      assert.equal(new Set(documents.map(row => row.tratamiento_id)).size, 2);
      assert(documents.every(row => Number(parse(row.snapshot_json).context.tratamiento.id) === row.tratamiento_id
        && row.snapshot_html.includes(treatments.find(item => item.id_tratamiento === row.tratamiento_id).nombre) && row.status === 'pending'));
      assert.equal(first.summary.pending_required, 2);
      const repeated = await consent.ensurePackageForAppointment(appointmentId, { createdBy: actorId, triggerSource: 'synthetic_program_qa' });
      assert.equal(repeated.package.id, first.package.id);
      assert.equal(await db.PatientConsentDocument.count({ where: { cita_id: appointmentId, clinica_id: 82, clinic_template_id: template.id } }), 2);
      const dir = fs.mkdtempSync(root + '/program-booking-documents-'); fs.chmodSync(dir, 0o700);
      const result = { synthetic_only: true, passed: true, checks: ['One package for one canonical appointment', 'Both phase treatments require documents', 'Same template has distinct treatment context', 'Both unsigned requirements visible', 'Repeated preparation creates no duplicate'], appointment_id: appointmentId, package_id: first.package.id, documents: documents.map(row => row.id), no_signing_or_delivery: true };
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ evidence: dir, checks: result.checks.length, passed: true }));
    }
    if (mode === '--reset-browser') {
      const fixtures = await purchases(); const cancelled = [];
      for (const kind of ['simple', 'multi']) {
        const plan = await booking.read({ ...context, publicId: fixtures[kind].voucherId });
        assert.equal(plan.sessions.length, 3);
        for (const row of plan.sessions.filter(row => row.scheduling_status === 'reserved')) {
          const appointment = await db.CitaPaciente.findByPk(row.appointment_id);
          assert.equal(appointment.clinica_id, 82); assert.equal(appointment.paciente_id, patient.id_paciente); assert.equal(appointment.source_system, 'treatment_program');
          await command.mutateAppointmentBooking({ db, existingAppointmentId: appointment.id_cita,
            appointmentValues: { estado: 'cancelada', updated_by: actorId }, stateOnly: true,
            persist: ({ existing, values, transaction }) => existing.update(values, { transaction }) });
          cancelled.push(appointment.id_cita);
        }
      }
      console.log(JSON.stringify({ synthetic_only: true, history_preserved: true, cancelled_qa_appointments: cancelled }));
    }
    if (mode === '--serve') {
      const express = require('express'); const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.use(async (req, res, next) => {
        try {
          // Independent fail-closed scope guard before the REAL authenticated
          // routes. No public signing, sending, payments or patient creation.
          let okay = false;
          const voucher = req.path.match(/^\/api\/economics\/vouchers\/([^/]+)\/(program-plan|program-proposals|program-appointments)$/);
          if (voucher) okay = !!(await db.PatientVoucher.findOne({ where: { public_id: voucher[1], clinic_id: 82, patient_id: patient.id_paciente, source_system: 'treatment_program' } }));
          if (req.method === 'GET' && [patient.public_id, String(patient.id_paciente)].some(id => req.path === `/api/economics/patients/${id}/workspace`) && Number(req.query.clinic_id) === 82) okay = true;
          if (req.method === 'GET' && req.path === '/api/economics/catalog' && Number(req.query.clinic_id) === 82) okay = true;
          if (req.method === 'GET' && /^\/api\/treatment-programs(?:\/[^/]+)?$/.test(req.path) && Number(req.query.clinic_id) === 82) okay = true;
          if (req.method === 'GET' && ['/api/citas', '/api/citas/calendar'].includes(req.path) && Number(req.query.clinica_id) === 82) okay = true;
          if (req.method === 'GET' && req.path === '/api/citas' && [patient.public_id, String(patient.id_paciente)].includes(String(req.query.paciente_id))) { req.query.clinica_id = '82'; okay = true; }
          const cita = req.path.match(/^\/api\/citas\/(\d+)$/);
          if (req.method === 'GET' && cita) okay = !!(await db.CitaPaciente.findOne({ where: { id_cita: Number(cita[1]), clinica_id: 82, paciente_id: patient.id_paciente } }));
          if (!okay) return res.status(403).json({ error: { code: 'qa_scope_guard', message: 'Solo demostración verificada.' } });
          return next();
        } catch (error) { return next(error); }
      });
      app.use('/api/economics', require('../routes/patientEconomics.routes'));
      app.use('/api/treatment-programs', require('../routes/treatmentPrograms.routes'));
      app.use('/api/citas', require('../routes/citas.routes'));
      app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: { code: error.code || 'qa_error', message: error.message } }));
      const server = app.listen(3005, '127.0.0.1', () => console.log(JSON.stringify({ qa_server: '127.0.0.1:3005', clinic_id: 82, synthetic_only: true, app_bootstrap_loaded: false, reminders_enabled: false })));
      await new Promise(resolve => { process.once('SIGINT', () => server.close(resolve)); process.once('SIGTERM', () => server.close(resolve)); });
    }
  } finally { await db.sequelize.close(); }
}
if (require.main === module) main().then(() => process.exit(0)).catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message, details: error.details })); process.exit(1); });
