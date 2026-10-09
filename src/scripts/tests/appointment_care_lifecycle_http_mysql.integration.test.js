'use strict';
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, nativeFinalHandler: true });
  const { db, ids, request, fingerprint } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(verified.status, 200);
    return verified.body.token;
  };
  try {
    const reception = await login(ids.reception), clinical = await login(ids.assistant), outsider = await login(ids.outsider);
    // Both reservation paths must reject clinical states supplied by a generic
    // creation payload. No API client can manufacture the native care evidence.
    for (const enabled of ['true', 'false']) {
      const oldGate = process.env.BOOKING_PROFILES_ENABLED;
      process.env.BOOKING_PROFILES_ENABLED = enabled;
      try {
        for (const estado of ['ha_acudido', 'en_atencion', 'completada']) {
          const before = await fingerprint();
          const body = f.body({ estado });
          if (enabled === 'false') {
            Object.assign(body, { tratamiento_id: null, tipo_cita: 'primera_sin_trat',
              fin: new Date(Date.parse(body.inicio) + 40 * 60000).toISOString() });
            delete body.phase_durations; delete body.booking_request_key; delete body.booking_selection;
          }
          const result = await request('POST', '/api/citas', body, clinical);
          assert.equal(result.status, 409, JSON.stringify(result.body));
          assert.match(result.headers['content-type'], /^application\/json\b/);
          assert.match(result.body.code, /^care_/);
          assert.deepEqual(await fingerprint(), before, 'Forged clinical creation has no domain mutation');
        }
      } finally { process.env.BOOKING_PROFILES_ENABLED = oldGate; }
    }
    const created = await request('POST', '/api/citas', f.body(), clinical);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id_cita, care = action => `/api/citas/${id}/care/${action}`;
    const denied = async (method, route, body, token, status, code) => {
      const before = await fingerprint(), result = await request(method, route, body, token,
        { accept: 'application/json' });
      assert.equal(result.status, status, JSON.stringify(result.body));
      assert.match(result.headers['content-type'], /^application\/json\b/,
        'Native router supplies JSON: no fixture error fallback is installed');
      if (code) assert.equal(result.body.code, code);
      assert.deepEqual(await fingerprint(), before, 'Denied action has no domain mutation');
    };
    await denied('POST', care('arrive'), {}, outsider, 403);
    await denied('POST', care('start'), {}, clinical, 409, 'care_arrival_required');
    await denied('POST', care('finish'), {}, reception, 403);
    await denied('POST', care('finish'), {}, clinical, 409, 'care_start_required');
    const arrival = await request('POST', care('arrive'), { actorId: ids.owner }, reception);
    assert.equal(arrival.status, 200, JSON.stringify(arrival.body));
    assert.equal(arrival.body.estado, 'ha_acudido');
    assert.equal(arrival.body.care.can_start, true);
    assert.equal((await db.CitaPaciente.findByPk(id)).arrived_by, ids.reception);
    const beforeReplay = await fingerprint();
    assert.equal((await request('POST', care('arrive'), {}, reception)).body.replayed, true);
    assert.deepEqual(await fingerprint(), beforeReplay);
    const start = await request('POST', care('start'), { actorId: ids.owner }, clinical);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.estado, 'en_atencion');
    assert.equal(start.body.care.can_complete, true);
    for (const resource of [{ doctor_id: ids.doctorTwo }, { instalacion_id: ids.roomTwo }]) {
      await denied('PATCH', `/api/citas/${id}/reagendar`, { inicio: start.body.inicio, fin: start.body.fin,
        reschedule_reason: 'administrative_error', ...resource }, reception, 409, 'care_reservation_locked');
    }
    await denied('PATCH', `/api/citas/${id}/personal-apoyo`, { additional_staff_ids: [ids.doctorTwo],
      expected_start: start.body.inicio, expected_end: start.body.fin }, reception, 409, 'care_reservation_locked');
    await denied('PATCH', `/api/citas/${id}/estado`, { estado: 'recordatorio_confirmado' }, reception, 409, 'care_already_started');
    const finishes = await Promise.all([request('POST', care('finish'), {}, clinical), request('POST', care('finish'), {}, clinical)]);
    for (const finish of finishes) assert.equal(finish.status, 200, JSON.stringify(finish.body));
    assert.equal(finishes.filter(result => result.body.replayed === true).length, 1);
    const row = await db.CitaPaciente.findByPk(id);
    assert.equal(row.estado, 'completada');
    assert.equal(row.care_started_by, ids.assistant);
    assert.equal(row.care_completed_by, ids.assistant);
    assert(row.care_completed_at && row.arrived_at && row.care_started_at);
    assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: id, action: 'finish' } }), 1);
    const afterFinish = await fingerprint();
    assert.equal((await request('PATCH', `/api/citas/${id}/estado`, { estado: 'completada' }, clinical)).body.replayed, true);
    assert.deepEqual(await fingerprint(), afterFinish);
    await denied('PATCH', `/api/citas/${id}/estado`, { estado: 'cancelada' }, reception, 409, 'care_already_completed');

    // Reservation actions remain independent from treatment catalogue edits.
    // This is a real authenticated HTTP request over the owned SQL fixture,
    // with every delivery/provider socket still denied by the fixture.
    const futureStart = new Date(Date.now() + 86400000).toISOString();
    const future = await request('POST', '/api/citas', f.body({ inicio: futureStart, same_day_choice: { mode: 'separate' } }), reception);
    assert.equal(future.status, 201, JSON.stringify(future.body));
    const futureId = future.body.id_cita;
    assert.equal(future.body.care.can_no_show, false);
    await denied('PATCH', `/api/citas/${futureId}/estado`, { estado: 'no_asistio' }, reception, 409, 'care_no_show_too_early');
    for (const enabled of ['true', 'false']) {
      const oldGate = process.env.BOOKING_PROFILES_ENABLED;
      process.env.BOOKING_PROFILES_ENABLED = enabled;
      try {
        await denied('PATCH', `/api/citas/${futureId}/estado`, { estado: 'no_asistio' }, reception, 409, 'care_no_show_too_early');
      } finally { process.env.BOOKING_PROFILES_ENABLED = oldGate; }
    }
    const futureRow = await db.CitaPaciente.findByPk(futureId);
    const originalOccupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: futureId },
      order: [['id', 'ASC']], raw: true });
    const incompleteSnapshot = { ...futureRow.import_metadata, booking: { version: 1, old_profile_missing: true } };
    await futureRow.update({ import_metadata: incompleteSnapshot });
    await db.Tratamiento.update({ activo: false, eliminado_por_clinica: [ids.clinic] }, { where: { id_tratamiento: ids.treatment } });
    const oldMultiGate = process.env.BOOKING_MULTI_RESOURCE_ENABLED;
    process.env.BOOKING_MULTI_RESOURCE_ENABLED = 'false';
    try {
      const cancel = await request('PATCH', `/api/citas/${futureId}/estado`, { estado: 'cancelada' }, reception);
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal(cancel.body.estado, 'cancelada');
      assert.equal(cancel.body.care.can_no_show, false);
      const canceled = await db.CitaPaciente.findByPk(futureId);
      assert.deepEqual(canceled.import_metadata, incompleteSnapshot);
      assert.deepEqual(await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: futureId },
        order: [['id', 'ASC']], raw: true }), originalOccupancy, 'Cancelled capacity is released by canonical status; original occupancy remains historical evidence');
      await denied('PATCH', `/api/citas/${futureId}/estado`, { estado: 'pendiente' }, reception, 404, 'treatment_not_found');
    } finally { process.env.BOOKING_MULTI_RESOURCE_ENABLED = oldMultiGate; }
    assert.equal(await db.PatientConsentDocument.count(), 0);
    assert.equal(await db.Message.count(), 0);
    assert.equal(await db.JobRequest.count(), 0);
    assert.equal(await db.FlowExecutionV2.count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Native router JSON contract, without the fixture error fallback: every rejected lifecycle action returns application/json with its domain code; future no-show with profile gate on/off and care/resource/state rewinds preserve all domain rows. Accept:application/json does not manufacture this contract. Unknown errors remain delegated to Express final handling.');
    owned.report.checks.push('Actual authenticated HTTP/SQL: generic creation cannot forge arrival/start/finish with booking gate on or off; ACL cross-clinic/clinical rights; no finish before start; arrival/replay; actor spoof rejected by authenticated attribution; care start; no changing doctor/room/support after care started even at unchanged times; no confirmation rewind; two concurrent finishes produce one evidence event and one replay; completion replay has no mutation; no cancellation rewind; future no-show denied transactionally with booking gate on/off; existing open reservation cancelled despite hidden treatment, incomplete historic profile and closed multi-resource gate, original snapshots/occupancy preserved, reopening still validates; zero consents/messages/jobs/executions/provider calls');
  } finally { await f.close(); }
}).then(() => {}, error => { console.error(error.code || error.message); process.exitCode = 1; });
