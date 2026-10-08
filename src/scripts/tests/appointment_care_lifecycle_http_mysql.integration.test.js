'use strict';
const assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture(owned);
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
          assert.match(result.body.code, /^care_/);
          assert.deepEqual(await fingerprint(), before, 'Forged clinical creation has no domain mutation');
        }
      } finally { process.env.BOOKING_PROFILES_ENABLED = oldGate; }
    }
    const created = await request('POST', '/api/citas', f.body(), clinical);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id_cita, care = action => `/api/citas/${id}/care/${action}`;
    const denied = async (method, route, body, token, status, code) => {
      const before = await fingerprint(), result = await request(method, route, body, token);
      assert.equal(result.status, status, JSON.stringify(result.body));
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
    assert.equal(await db.PatientConsentDocument.count(), 0);
    assert.equal(await db.Message.count(), 0);
    assert.equal(await db.JobRequest.count(), 0);
    assert.equal(await db.FlowExecutionV2.count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Actual authenticated HTTP/SQL: generic creation cannot forge arrival/start/finish with booking gate on or off; ACL cross-clinic/clinical rights; no finish before start; arrival/replay; actor spoof rejected by authenticated attribution; care start; no confirmation rewind; two concurrent finishes produce one evidence event and one replay; completion replay has no mutation; no cancellation rewind; zero consents/messages/jobs/executions/provider calls');
  } finally { await f.close(); }
}).then(() => {}, error => { console.error(error.code || error.message); process.exitCode = 1; });
