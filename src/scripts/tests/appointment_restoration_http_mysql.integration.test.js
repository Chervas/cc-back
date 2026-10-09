'use strict';
// Real routers/JWT/MFA/ACL over newly owned MySQL; no live tenant/provider.
const assert = require('node:assert/strict'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, nativeFinalHandler: true, includeProgramLedger: true });
  const { db, ids, request, fingerprint } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const r = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(r.status, 202); const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(r.body.challengeToken) } });
    const v = await request('POST', '/api/auth/email-code/verify', { challengeToken: r.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(v.status, 200); return v.body.token;
  };
  const requireCode = async (method, path, body, token, status, code) => {
    const before = await fingerprint(), r = await request(method, path, body, token, { accept: 'application/json' });
    assert.equal(r.status, status, JSON.stringify(r.body)); assert.match(r.headers['content-type'], /^application\/json\b/);
    if (code) assert.equal(r.body.code, code);
    assert.deepEqual(await fingerprint(), before, 'Rejected request changes no booking, audit, message or job'); return r;
  };
  const silent = async () => {
    const counts = {};
    for (const name of ['Message', 'FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest', 'ConsentSignaturePackage',
      'PatientConsentDocument', 'AppointmentVisitCommunication', 'AppointmentVisitDispatch']) counts[name] = await db[name].count();
    return counts;
  };
  let next = 0;
  const create = async (token, patch = {}) => {
    const start = new Date(Date.parse('2030-01-07T08:00:00Z') + next++ * 60 * 60000);
    const body = f.body({ tratamiento_id: null, instalacion_id: null, tipo_cita: 'primera_sin_trat',
      inicio: start.toISOString(), fin: new Date(+start + 30 * 60000).toISOString(),
      same_day_choice: { mode: 'separate' }, ...patch });
    delete body.booking_request_key;
    if (!body.tratamiento_id) { delete body.phase_durations; delete body.booking_selection; }
    else delete body.fin;
    let r = await request('POST', '/api/citas', body, token);
    if (r.status === 409 && r.body.can_confirm_restrictions) r = await request('POST', '/api/citas', { ...body,
      booking_plan_sha256: r.body.booking_plan_sha256, booking_restriction_acknowledgement: r.body.booking_restriction_acknowledgement }, token);
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id_cita;
  };
  const cancel = async (id, token) => {
    const r = await request('PATCH', `/api/citas/${id}/estado`, { estado: 'cancelada' }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r;
  };
  const preview = async (id, token) => {
    const r = await request('GET', `/api/citas/${id}/recuperacion`, undefined, token);
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body;
  };
  const restore = async (id, token, p = null) => {
    const input = { restoration_acknowledgement: (p || await preview(id, token)).restoration_acknowledgement };
    let r = await request('POST', `/api/citas/${id}/recuperar`, input, token);
    if (r.status === 409 && r.body.can_confirm_restrictions) r = await request('POST', `/api/citas/${id}/recuperar`, { ...input,
      booking_plan_sha256: r.body.booking_plan_sha256, booking_restriction_acknowledgement: r.body.booking_restriction_acknowledgement }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body)); return r;
  };
  try {
    const token = await login(ids.reception), owner = await login(ids.owner), outsider = await login(ids.outsider);
    const id = await create(token); await cancel(id, token);
    const p = await preview(id, token); assert.equal(p.previous_status, 'pendiente'); assert.equal(p.can_restore, true);
    await requireCode('GET', `/api/citas/${id}/recuperacion`, undefined, outsider, 403);
    await requireCode('POST', `/api/citas/${id}/recuperar`, { restoration_acknowledgement: p.restoration_acknowledgement }, owner, 409, 'booking_restore_changed');
    await requireCode('POST', `/api/citas/${id}/recuperar`, { restoration_acknowledgement: p.restoration_acknowledgement, estado: 'info_confirmada' }, token, 400, 'booking_restore_invalid');
    const counts = await silent(), r = await restore(id, token, p);
    assert.equal(r.body.estado, 'pendiente'); assert.equal(r.body.restoration.restored, true);
    assert.deepEqual(await silent(), counts, 'Recovery creates no messages, jobs, flows or consent packages');
    assert.equal((await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id } })).length, 1);
    await requireCode('POST', `/api/citas/${id}/recuperar`, { restoration_acknowledgement: p.restoration_acknowledgement }, token, 409, 'booking_restore_not_cancelled');
    owned.report.checks.push('Native JWT/MFA/ACL, prior pending, silent recovery, replay and arbitrary state rejection');

    for (const state of ['info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']) {
      const member = await create(token);
      // Isolated fixture setup creates native audit, without messaging worker.
      await db.CitaPaciente.update({ estado: state }, { where: { id_cita: member } });
      await cancel(member, token); const before = await silent(); const restored = await restore(member, token);
      assert.equal(restored.body.estado, state); assert.deepEqual(await silent(), before);
    }
    owned.report.checks.push('Every notification/confirmation stage restores itself, not invented info_confirmada');
    const stale = await create(token); await cancel(stale, token); const sp = await preview(stale, token);
    await db.CitaPaciente.update({ nota: 'OWNED changed after preview' }, { where: { id_cita: stale } });
    await requireCode('POST', `/api/citas/${stale}/recuperar`, { restoration_acknowledgement: sp.restoration_acknowledgement }, token, 409, 'booking_restore_changed');
    const undocumented = await create(token);
    await db.CitaPaciente.update({ estado: 'cancelada' }, { where: { id_cita: undocumented } });
    const hp = await preview(undocumented, token); assert.equal(hp.can_restore, false); assert.equal(hp.code, 'booking_restore_history_required');
    owned.report.checks.push('Audit required; preview fingerprint catches changed original row');

    const blocked = await create(token); await cancel(blocked, token); const bp = await preview(blocked, token);
    const blockedRow = await db.CitaPaciente.findByPk(blocked);
    await db.DoctorBloqueo.create({ doctor_id: ids.doctorOne, clinica_id: ids.clinic, tipo: 'otro', recurrente: 'none',
      fecha_inicio: blockedRow.inicio, fecha_fin: blockedRow.fin, motivo: 'OWNED new conflict after cancellation' });
    const conflict = await requireCode('POST', `/api/citas/${blocked}/recuperar`, { restoration_acknowledgement: bp.restoration_acknowledgement }, token, 409, 'booking_restriction_confirmation_required');
    assert.equal(conflict.body.can_confirm_restrictions, true);
    await requireCode('POST', `/api/citas/${blocked}/recuperar`, { restoration_acknowledgement: bp.restoration_acknowledgement,
      booking_restriction_acknowledgement: conflict.body.booking_restriction_acknowledgement, booking_plan_sha256: '0'.repeat(64) }, token, 409, 'booking_plan_changed');
    await restore(blocked, token, bp);
    owned.report.checks.push('Fresh normal manual confirmation and canonical SHA on newly occupied slot');

    // A two-phase combined visit remains one cita, with both phases rebuilt.
    const combined = await create(token, { tratamiento_id: ids.treatment, instalacion_id: ids.roomOne });
    const beforePhases = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: combined }, raw: true });
    assert(beforePhases.length > 1); await cancel(combined, token); const cc = await silent(); await restore(combined, token);
    const afterPhases = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: combined }, raw: true });
    const signature = rows => rows.map(({ phase_key, resource_kind, resource_key, start_at, end_at }) =>
      ({ phase_key, resource_kind, resource_key, start_at, end_at }));
    assert.deepEqual(signature(afterPhases), signature(beforePhases)); assert.deepEqual(await silent(), cc);
    owned.report.checks.push('Combined booking keeps one identity and reconstructs all exact phase resources silently');

    // The purchased ledger is isolated fixture setup. Recovery cannot consume
    // again, steal a replaced session or manufacture a second allocation.
    const programRow = await db.CitaPaciente.findByPk(combined), metadata = programRow.import_metadata;
    const voucher = await db.PatientVoucher.create({ public_id: require('node:crypto').randomUUID(), clinic_id: ids.clinic,
      patient_id: ids.patient, treatment_id: ids.treatment, name: 'OWNED fictitious purchased program', total_units: 2,
      available_units: 2, sold_amount: 0, status: 'active', source_system: 'treatment_program' });
    const session = await db.PatientProgramSession.create({ voucher_id: voucher.id, session_key: 'owned-recovery-session', position: 0,
      snapshot_sha256: 'a'.repeat(64), appointment_id: combined, snapshot: { key: 'owned-recovery-session', treatment_ids: [ids.treatment],
        booking_profile: metadata.booking.profile, program_cadence: null,
        phase_treatments: metadata.booking.phases.map(phase => ({ key: phase.key, treatment_id: ids.treatment })) } });
    await programRow.update({ voucher_id: voucher.id, source_system: 'treatment_program', import_metadata: {
      ...metadata, automation_policy: 'hold', program_session: { session_id: String(session.id), key: session.session_key } } });
    await cancel(combined, token); const pc = await silent(); await restore(combined, token);
    assert.equal(Number((await voucher.reload()).available_units), 2); assert.equal(await db.PatientVoucherMovement.count(), 0);
    assert.equal((await session.reload()).appointment_id, combined); assert.deepEqual(await silent(), pc);
    await cancel(combined, token); const pp = await preview(combined, token);
    const movement = await db.PatientVoucherMovement.create({ voucher_id: voucher.id, appointment_id: combined,
      movement_type: 'consume', units: 1, occurred_at: new Date(), created_by: ids.reception });
    await session.update({ consumption_movement_id: movement.id });
    await requireCode('POST', `/api/citas/${combined}/recuperar`, { restoration_acknowledgement: pp.restoration_acknowledgement }, token, 409, 'program_session_completed');
    await session.update({ consumption_movement_id: null, appointment_id: blocked });
    await requireCode('POST', `/api/citas/${combined}/recuperar`, { restoration_acknowledgement: pp.restoration_acknowledgement }, token, 409, 'program_session_replaced');
    owned.report.checks.push('Purchased session reuses its allocation without consumption; consumed/replaced ledger refuses recovery atomically');

    const arrived = await create(token, { inicio: '2026-10-01T08:00:00Z', fin: '2026-10-01T08:30:00Z' });
    const arrival = await request('POST', `/api/citas/${arrived}/care/arrive`, {}, token);
    assert.equal(arrival.status, 200, JSON.stringify(arrival.body)); const arrivalRow = await db.CitaPaciente.findByPk(arrived);
    const arrivalAt = +new Date(arrivalRow.arrived_at); await cancel(arrived, token);
    const ac = await silent(); const recoveredArrival = await restore(arrived, token);
    assert.equal(recoveredArrival.body.estado, 'ha_acudido');
    const ar = await db.CitaPaciente.findByPk(arrived); assert.equal(+new Date(ar.arrived_at), arrivalAt);
    assert.equal(ar.care_started_at, null); assert.equal(ar.care_completed_at, null); assert.deepEqual(await silent(), ac);
    owned.report.checks.push('Recorded arrival remains arrival, preserves its timestamp and is never clinical completion');

    await require('../../../migrations/20261007170000-create-appointment-patient-links').up(f.sql.getQueryInterface(), S);
    db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(f.sql, S.DataTypes);
    db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(f.sql, S.DataTypes);
    const a = await create(token), b = await create(token); await db.CitaPaciente.update({ estado: 'info_enviada' }, { where: { id_cita: b } });
    const group = await db.AppointmentPatientLink.create({ id: require('node:crypto').randomUUID(), clinic_id: ids.clinic, patient_id: ids.patient, owner_appointment_id: a, revision: 1, created_by: ids.reception });
    await db.AppointmentPatientLinkMember.bulkCreate([{ link_id: group.id, appointment_id: a, position: 1 }, { link_id: group.id, appointment_id: b, position: 2 }]);
    await cancel(a, token); const gp = await preview(a, token); assert.equal(gp.count, 2);
    assert.deepEqual(gp.members.map(row => row.previous_status), ['pendiente', 'info_enviada']);
    const ga = await db.CitaPaciente.findByPk(a), gb = await db.CitaPaciente.findByPk(b);
    for (const row of [ga, gb]) await db.DoctorBloqueo.create({ doctor_id: ids.doctorOne, clinica_id: ids.clinic,
      tipo: 'otro', recurrente: 'none', fecha_inicio: row.inicio, fecha_fin: row.fin, motivo: 'OWNED group warning' });
    const gw = await requireCode('POST', `/api/citas/${a}/recuperar`, { restoration_acknowledgement: gp.restoration_acknowledgement }, token, 409, 'booking_restriction_confirmation_required');
    assert.equal(gw.body.linked_appointments, 2); assert.equal(gw.body.can_confirm_restrictions, true);
    await requireCode('POST', `/api/citas/${b}/recuperar`, { restoration_acknowledgement: gp.restoration_acknowledgement,
      booking_restriction_acknowledgement: gw.body.booking_restriction_acknowledgement, booking_plan_sha256: gw.body.booking_plan_sha256 }, token, 409, 'booking_restore_changed');
    const gc = await silent(); await restore(a, token, gp);
    assert.equal((await db.CitaPaciente.findByPk(a)).estado, 'pendiente'); assert.equal((await db.CitaPaciente.findByPk(b)).estado, 'info_enviada');
    assert.deepEqual(await silent(), gc); await cancel(a, token);
    const ap = await preview(a, token); await db.CitaPaciente.update({ estado: 'pendiente' }, { where: { id_cita: b } });
    await requireCode('POST', `/api/citas/${a}/recuperar`, { restoration_acknowledgement: ap.restoration_acknowledgement }, token, 409, 'booking_restore_not_cancelled');
    assert.equal((await db.CitaPaciente.findByPk(a)).estado, 'cancelada');
    owned.report.checks.push('Linked group restores per-member real status atomically using one explicit receipt; selected-member change or already active member rejects all');
  } finally { await f.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
