'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeProgramLedger: true });
  const { db, ids, request, fingerprint } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const result = await request('POST', '/api/auth/email-code/verify', { challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(result.status, 200);
    return result.body.token;
  };
  try {
    const clinical = await login(ids.assistant), reception = await login(ids.reception);
    const created = await request('POST', '/api/citas', f.body(), clinical);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id_cita, route = action => `/api/citas/${id}/care/${action}`;
    const appointment = await db.CitaPaciente.findByPk(id);
    const metadata = appointment.import_metadata;
    // Only the already-purchased/materialized ledger is fixture setup. All
    // arrival/start/finish evidence must come from actual authenticated HTTP.
    const voucher = await db.PatientVoucher.create({ public_id: crypto.randomUUID(), clinic_id: ids.clinic,
      patient_id: ids.patient, treatment_id: ids.treatment, name: 'OWNED fictitious program', total_units: 2,
      available_units: 2, sold_amount: 0, status: 'active', source_system: 'treatment_program' });
    const session = await db.PatientProgramSession.create({ voucher_id: voucher.id, session_key: 'owned-session', position: 0,
      snapshot_sha256: 'a'.repeat(64), appointment_id: id, snapshot: { key: 'owned-session', treatment_ids: [ids.treatment],
        booking_profile: metadata.booking.profile, program_cadence: null,
        phase_treatments: metadata.booking.phases.map(phase => ({ key: phase.key, treatment_id: ids.treatment })) } });
    await appointment.update({ voucher_id: voucher.id, source_system: 'treatment_program', import_metadata: {
      ...metadata, automation_policy: 'hold', program_session: { session_id: String(session.id), key: session.session_key } } });
    assert.equal(appointment.arrived_at, null); assert.equal(appointment.care_started_at, null);
    const ledger = async (units, consumed) => {
      assert.equal(Number((await voucher.reload()).available_units), units);
      assert.equal(await db.PatientVoucherMovement.count(), consumed ? 1 : 0);
      assert.equal(!!(await session.reload()).consumption_movement_id, consumed);
    };
    const denied = async (method, path, body, token, code) => {
      const before = await fingerprint(), result = await request(method, path, body, token);
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal(result.body.code, code);
      assert.deepEqual(await fingerprint(), before, 'Failed program care action rolls back all care and economic evidence');
    };
    await denied('POST', route('finish'), {}, clinical, 'care_start_required');
    await ledger(2, false);
    assert.equal((await request('POST', route('arrive'), {}, reception)).status, 200);
    assert.equal((await db.CitaPaciente.findByPk(id)).estado, 'ha_acudido');
    await ledger(2, false);
    const started = await request('POST', route('start'), {}, clinical);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.estado, 'en_atencion');
    await ledger(2, false);

    await voucher.update({ status: 'pending' });
    await denied('POST', route('finish'), {}, clinical, 'program_session_not_consumable');
    assert.equal((await db.CitaPaciente.findByPk(id)).care_completed_at, null);
    assert.equal(await db.AppointmentCareEvent.count({ where: { action: 'finish' } }), 0);
    await ledger(2, false);
    await voucher.update({ status: 'active', patient_id: ids.foreignPatient });
    await denied('POST', route('finish'), {}, clinical, 'program_session_identity_locked');
    await ledger(2, false);
    await voucher.update({ patient_id: ids.patient });

    const finishes = await Promise.all([request('POST', route('finish'), {}, clinical), request('POST', route('finish'), {}, clinical)]);
    for (const result of finishes) assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(finishes.filter(result => result.body.replayed).length, 1);
    await ledger(1, true);
    const finished = await db.CitaPaciente.findByPk(id), movement = await db.PatientVoucherMovement.findOne();
    assert.equal(finished.estado, 'completada');
    assert.equal(finished.arrived_by, ids.reception);
    assert.equal(finished.care_started_by, ids.assistant); assert.equal(finished.care_completed_by, ids.assistant);
    assert(finished.arrived_at && finished.care_started_at && finished.care_completed_at);
    assert.equal(movement.appointment_id, id); assert.equal(movement.created_by, ids.assistant);
    assert.equal(Number(movement.units), -1);
    assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: id, action: 'finish' } }), 1);
    const completeProof = await fingerprint();
    for (const [method, path, body] of [['POST', route('finish'), {}], ['PATCH', `/api/citas/${id}/estado`, { estado: 'completada' }]]) {
      const repeated = await request(method, path, body, clinical);
      assert.equal(repeated.status, 200); assert.equal(repeated.body.replayed, true);
      assert.deepEqual(await fingerprint(), completeProof, 'Replays do not consume another unit or append another care event');
    }
    await denied('PATCH', `/api/citas/${id}/estado`, { estado: 'cancelada' }, clinical, 'program_session_completed');
    assert.equal(await db.PatientConsentDocument.count(), 0);
    assert.equal(await db.Message.count(), 0); assert.equal(await db.Conversation.count(), 0);
    assert.equal(await db.JobRequest.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Actual managed-session HTTP care with real SQL purchased-session ledger: arrival/start consume zero; inactive or foreign purchase rejects finish atomically; two concurrent native finishes consume one unit and record one finish; HTTP replays preserve all rows; no cancellation rewind or messages/consents/jobs/flows/provider calls');
  } finally { await f.close(); }
}).then(() => {}, error => { console.error(error.code || error.message); process.exitCode = 1; });
