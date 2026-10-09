'use strict';
// Native JWT + email MFA + ACL + routers + command over one freshly owned SQL
// database. No provider, worker, real credentials or live tenant is reachable.
const assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, nativeFinalHandler: true, includeAvailabilityRoutes: true });
  const { db, ids, request, fingerprint } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(verified.status, 200); return verified.body.token;
  };
  const visit = (start, doctor = ids.doctorOne) => {
    const body = f.body({ tratamiento_id: null, instalacion_id: null, doctor_id: doctor,
      inicio: start, fin: new Date(Date.parse(start) + 30 * 60000).toISOString(), tipo_cita: 'primera_sin_trat',
      same_day_choice: { mode: 'separate' } });
    delete body.phase_durations; delete body.booking_request_key; delete body.booking_selection;
    return body;
  };
  const url = (route, values) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) query.append(key, String(item));
    return `/api/disponibilidad/${route}?${query}`;
  };
  const receipt = result => ({ booking_restriction_acknowledgement: result.body.booking_restriction_acknowledgement,
    booking_plan_sha256: result.body.booking_plan_sha256 });
  const deny = async (method, path, body, token, status, code) => {
    const before = await fingerprint(), response = await request(method, path, body, token, { accept: 'application/json' });
    assert.equal(response.status, status, JSON.stringify(response.body));
    assert.match(response.headers['content-type'], /^application\/json\b/);
    if (code) assert.equal(response.body.code, code);
    assert.deepEqual(await fingerprint(), before, 'Rejected native request changes no domain rows');
    return response;
  };
  try {
    const reception = await login(ids.reception), owner = await login(ids.owner), outsider = await login(ids.outsider);
    await require('../../../migrations/20261007170000-create-appointment-patient-links').up(f.sql.getQueryInterface(), S);
    db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(f.sql, S.DataTypes);
    db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(f.sql, S.DataTypes);
    const links = require('../../services/appointmentPatientLinks.service');
    const freeInput = visit('2030-01-07T08:00:00Z', ids.doctorTwo);
    const free = await request('POST', '/api/citas', freeInput, reception);
    assert.equal(free.status, 201, JSON.stringify(free.body));
    assert.equal(free.body.instalacion_id, null); assert.equal(free.body.tratamiento_id, null);
    const freeRow = await db.CitaPaciente.findByPk(free.body.id_cita);
    assert.equal(freeRow.import_metadata, null);
    const freeOccupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: freeRow.id_cita }, raw: true });
    assert.equal(freeOccupancy.length, 1); assert.equal(freeOccupancy[0].resource_kind, 'doctor');
    const membership = await db.DoctorClinica.findOne({ where: { doctor_id: ids.doctorOne, clinica_id: ids.clinic } });
    assert.equal(Number(membership.agenda_flexible), 0); assert.equal(Number(membership.allow_legacy_attention_confirmation), 0);
    await db.DoctorHorario.update({ hora_inicio: '09:00', hora_fin: '10:00' }, { where: { doctor_clinica_id: membership.id, dia_semana: 1 } });
    const input = visit('2030-01-07T10:00:00Z');
    const check = await deny('GET', url('check', { clinica_id: ids.clinic, doctor_id: ids.doctorOne,
      paciente_id: ids.patient, inicio_local: '2030-01-07T11:00', fin_local: '2030-01-07T11:30' }), undefined, reception, 409,
    'booking_restriction_confirmation_required');
    assert.equal(check.body.can_confirm_restrictions, true);
    assert.equal(check.body.booking.phases[0].installation_id, null);
    assert(check.body.booking_restrictions.every(reason => !reason.installation));
    const warning = await deny('POST', '/api/citas', input, reception, 409, 'booking_restriction_confirmation_required');
    assert.equal(warning.body.can_confirm_restrictions, true);
    assert.equal(warning.body.booking_plan_sha256, check.body.booking_plan_sha256, 'Preview and writer seal the same roomless plan');
    assert.equal(warning.body.booking_restriction_acknowledgement, check.body.booking_restriction_acknowledgement,
      'Preview receipt can acknowledge the identical native reservation without another dialog');
    await deny('POST', '/api/citas', { ...input, force: true }, reception, 409, 'booking_restriction_confirmation_required');
    for (const selection of [{ doctor_id: ids.doctorTwo }, { installation_id: ids.roomOne }]) {
      await deny('POST', '/api/citas', { ...input, booking_selection: { appointment: selection } }, reception, 400,
        'booking_restriction_selection_invalid');
    }
    const otherActor = await deny('POST', '/api/citas', { ...input, ...receipt(warning) }, owner, 409,
      'booking_restriction_confirmation_required');
    assert.notEqual(otherActor.body.booking_restriction_acknowledgement, warning.body.booking_restriction_acknowledgement);
    await deny('POST', '/api/citas', { ...input, ...receipt(warning) }, outsider, 403);
    await deny('POST', '/api/citas', { ...input, ...receipt(warning), fin: '2030-01-07T10:45:00Z' }, reception, 409,
      'booking_restriction_confirmation_required');
    await deny('POST', '/api/citas', { ...input, ...receipt(warning), instalacion_id: ids.roomOne }, reception, 409,
      'booking_restriction_confirmation_required');
    await db.DoctorBloqueo.create({ doctor_id: ids.doctorOne, clinica_id: ids.clinic, tipo: 'otro', recurrente: 'none',
      fecha_inicio: new Date(input.inicio), fecha_fin: new Date(input.fin), motivo: 'OWNED fictitious block' });
    const refreshed = await deny('POST', '/api/citas', { ...input, ...receipt(warning) }, reception, 409,
      'booking_restriction_confirmation_required');
    assert.notEqual(refreshed.body.booking_restriction_acknowledgement, warning.body.booking_restriction_acknowledgement);
    await deny('POST', '/api/citas', { ...input, ...receipt(refreshed), booking_plan_sha256: '0'.repeat(64) }, reception, 409,
      'booking_plan_changed');
    const accepted = await request('POST', '/api/citas', { ...input, ...receipt(refreshed) }, reception);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    const acceptedRow = await db.CitaPaciente.findByPk(accepted.body.id_cita);
    assert.equal(acceptedRow.doctor_id, ids.doctorOne); assert.equal(acceptedRow.instalacion_id, null);
    assert.equal(acceptedRow.import_metadata.booking, undefined);
    assert.equal(acceptedRow.import_metadata.booking_restriction_confirmation.confirmed_by, ids.reception);
    assert.deepEqual(acceptedRow.import_metadata.booking_restriction_confirmation.original_profile.phases[0].installation_ids, []);
    const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: acceptedRow.id_cita }, raw: true });
    assert.equal(occupancy.length, 1); assert.equal(occupancy[0].doctor_id, acceptedRow.doctor_id);
    assert.equal(occupancy[0].resource_kind, 'doctor'); assert.equal(occupancy[0].installation_id, null);
    await membership.update({ activo: false });
    const outOfScope = await deny('POST', '/api/citas', { ...input, ...receipt(refreshed) }, reception, 409, 'booking_unavailable');
    assert.notEqual(outOfScope.body.can_confirm_restrictions, true);
    await membership.update({ activo: true });
    await db.Instalacion.update({ profesionales_permitidos: [ids.doctorTwo] }, { where: { clinica_id: ids.clinic } });
    const matrix = { clinica_id: ids.clinic, dates: ['2030-01-07'], mode: 'doctor',
      'column_ids[]': [ids.doctorOne, ids.doctorTwo], 'doctor_only_column_ids[]': [ids.doctorOne],
      'peer_instalacion_ids[]': [ids.roomOne, ids.roomTwo], duracion_min: 20, granularity_min: 10,
      from_local: '09:00', to_local: '12:00' };
    const grid = await request('GET', url('grid', matrix), undefined, reception);
    assert.equal(grid.status, 200, JSON.stringify(grid.body));
    const doctorRow = grid.body.rows.find(row => Number(row.column_id) === ids.doctorOne);
    const roomRow = grid.body.rows.find(row => Number(row.column_id) === ids.doctorTwo);
    assert(doctorRow.slots.length > 0); assert.equal(doctorRow.slots_by_instalacion, undefined);
    assert(Object.values(roomRow.slots_by_instalacion).some(slots => slots.length > 0));
    assert(!doctorRow.unavailable_intervals.some(span => span.resource_conflicts.some(reason => reason.code === 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED')));
    const summary = await request('GET', url('summary', matrix), undefined, reception);
    assert.equal(summary.status, 200); assert.equal(summary.body.by_day['2030-01-07'], true);
    for (const route of ['grid', 'summary']) for (const patch of [
      { 'doctor_only_column_ids[]': [ids.doctorOne + 'oops'] }, { 'doctor_only_column_ids[]': [ids.doctorOne + '.5'] },
      { 'doctor_only_column_ids[]': [99999] }, { mode: 'installation' }, { tratamiento_id: ids.treatment },
      { context_instalacion_id: ids.roomOne }, { preferred_instalacion_id: ids.roomOne },
      { 'instalacion_ids[]': [ids.roomOne] }, { 'doctor_only_column_ids[bad]': '1', 'doctor_only_column_ids[]': undefined },
    ]) {
      const values = { ...matrix, ...patch }; for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
      await deny('GET', url(route, values), undefined, reception, 400);
    }
    // Two independently linked no-treatment visits retain NULL room and one
    // doctor occupancy each when one group receipt authorizes their movement.
    const first = await request('POST', '/api/citas', visit('2030-01-08T10:00:00Z', ids.doctorTwo), reception);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const secondInput = visit('2030-01-08T10:30:00Z', ids.doctorTwo);
    secondInput.same_day_choice = { mode: 'link', appointment_id: first.body.id_cita, updated_at: first.body.updated_at };
    const second = await request('POST', '/api/citas', secondInput, reception);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const group = await links.load(db, first.body.id_cita); assert.equal(group.rows.length, 2);
    await db.DoctorBloqueo.create({ doctor_id: ids.doctorTwo, clinica_id: ids.clinic, tipo: 'otro', recurrente: 'none',
      fecha_inicio: new Date('2030-01-08T13:00:00Z'), fecha_fin: new Date('2030-01-08T13:30:00Z'), motivo: 'OWNED linked warning' });
    const movePath = `/api/citas/${second.body.id_cita}/reagendar`;
    const move = { inicio: '2030-01-08T13:30:00Z', fin: '2030-01-08T14:00:00Z', reschedule_reason: 'administrative_error' };
    const groupWarning = await deny('PATCH', movePath, move, reception, 409, 'booking_restriction_confirmation_required');
    assert.equal(groupWarning.body.details.linked_appointments, 2);
    assert(groupWarning.body.booking_restrictions.every(reason => !reason.installation));
    await db.CitaPaciente.update({ estado: 'info_confirmada' }, { where: { id_cita: first.body.id_cita } });
    const staleGroup = await deny('PATCH', movePath, { ...move, ...receipt(groupWarning) }, reception, 409,
      'booking_restriction_confirmation_required');
    assert.notEqual(staleGroup.body.booking_restriction_acknowledgement, groupWarning.body.booking_restriction_acknowledgement);
    const moved = await request('PATCH', movePath, { ...move, ...receipt(staleGroup) }, reception);
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    for (const [id, start] of [[first.body.id_cita, '2030-01-08T13:00:00Z'], [second.body.id_cita, move.inicio]]) {
      const row = await db.CitaPaciente.findByPk(id);
      assert.equal(+new Date(row.inicio), Date.parse(start)); assert.equal(row.instalacion_id, null);
      const holds = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: id }, raw: true });
      assert.equal(holds.length, 1); assert.equal(holds[0].doctor_id, row.doctor_id); assert.equal(holds[0].installation_id, null);
    }
    assert.equal(await db.PatientConsentDocument.count(), 0); assert.equal(await db.Message.count(), 0);
    assert.equal(await db.JobRequest.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0); assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Native managed JWT + email MFA + role/clinic ACL, no JSON fallback: roomless first visit remains free in valid staff/clinic time and saves NULL room/one doctor occupancy; real staff hours/block require 409 + exact actor/evidence/plan receipt, old force fails; stale actor/duration/room/block/SHA and mismatched legacy selections make no domain writes; inactive staff and foreign actor remain non-confirmable. Retired per-person flags remain zero.');
    owned.report.checks.push('Native grid/summary mixed doctor-only subset preserves real staff constraints and normal room columns in one response; partial/float/object/foreign IDs, installation orientation, treatment, explicit room and direct room arrays reject 400. Linked roomless legacy movement uses one atomic group receipt, pins changed free-member state and persists no invented room. No messages, jobs, flows, consents or providers.');
    owned.report.nativeAuthenticatedRequests = f.requests;
  } finally { await f.close(); }
}).then(() => {}, error => { console.error(error.stack || error.message); process.exitCode = 1; });
