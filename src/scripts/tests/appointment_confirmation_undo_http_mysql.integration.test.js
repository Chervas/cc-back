'use strict';

// Real routers, JWT/session/MFA/ACL and command over a freshly OWNED mysqld.
// No live DEV/CRM connection, provider, background worker or real patient.
// Socket transport is an explicit in-process observer; no Redis is started.
const assert = require('node:assert/strict');
const S = require('sequelize');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  for (const file of ['appointmentclinicalreport', 'appointmentclinicalreportrevision']) {
    const model = require('../../../models/' + file)(owned.sql, S.DataTypes);
    owned.models[model.name] = model;
  }
  const packets = [];
  const socketFile = require.resolve('../../services/socket.service');
  const sockets = require(socketFile);
  require.cache[socketFile].exports = { ...sockets, getIO: () => ({
    to(room) { return { emit(event, payload) { packets.push({ room, event, payload }); } }; },
  }) };
  const f = await createOwnedVisitAuthAclFixture({ ...owned, nativeFinalHandler: true });
  const { db, ids, request } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202, JSON.stringify(challenge.body));
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', {
      challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id),
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
  };
  const fingerprint = async () => ({ ...await f.fingerprint(),
    links: db.AppointmentPatientLink ? await db.AppointmentPatientLink.findAll({ order: [['id', 'ASC']], raw: true }) : [],
    members: db.AppointmentPatientLinkMember ? await db.AppointmentPatientLinkMember.findAll({ order: [['appointment_id', 'ASC']], raw: true }) : [],
    reports: await db.AppointmentClinicalReport.findAll({ order: [['id', 'ASC']], raw: true }),
    revisions: await db.AppointmentClinicalReportRevision.findAll({ order: [['id', 'ASC']], raw: true }),
  });
  const silent = async () => Object.fromEntries(await Promise.all([
    'Message', 'FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest', 'ConsentSignaturePackage',
    'PatientConsentDocument', 'PatientIntakeRequest', 'AppointmentVisitCommunication', 'AppointmentVisitDispatch',
    'AppointmentCareEvent',
  ].map(async name => [name, await db[name].count()])));
  let next = 0;
  const anchor = Date.now() - 10 * 86400000;
  const create = async (token, patch = {}) => {
    const start = new Date(anchor + next++ * 60 * 60000);
    const body = f.body({ tratamiento_id: null, instalacion_id: null, tipo_cita: 'primera_sin_trat',
      inicio: start.toISOString(), fin: new Date(+start + 30 * 60000).toISOString(),
      same_day_choice: { mode: 'separate' }, ...patch });
    delete body.booking_request_key; delete body.phase_durations; delete body.booking_selection;
    let result = await request('POST', '/api/citas', body, token);
    if (result.status === 409 && result.body.can_confirm_restrictions) result = await request('POST', '/api/citas', {
      ...body, booking_plan_sha256: result.body.booking_plan_sha256,
      booking_restriction_acknowledgement: result.body.booking_restriction_acknowledgement,
    }, token);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.id_cita;
  };
  const state = async id => (await db.CitaPaciente.findByPk(id)).estado;
  const undoPath = id => `/api/citas/${id}/estado/deshacer`;
  const arrive = async (id, token) => {
    const result = await request('POST', `/api/citas/${id}/care/arrive`, {}, token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.estado, 'ha_acudido');
    assert(result.body.confirmation_undo, 'A new reception arrival exposes its own opaque undo receipt');
    assert.equal(result.body.confirmation_undo.appointment_id, id);
    assert.equal(result.body.confirmation_undo.duration_ms, 20000);
    assert.equal(result.body.confirmation_undo.affected_count, 1);
    return result.body.confirmation_undo;
  };
  const undo = async (id, receipt, token) => {
    const result = await request('POST', undoPath(id), { change_id: receipt.change_id }, token);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result;
  };
  const occupancy = async id => db.AppointmentBookingOccupancy.findAll({
    where: { appointment_id: id }, order: [['id', 'ASC']], raw: true,
  });
  const reject = async (method, path, input, token, status, code) => {
    const before = await fingerprint(), n = packets.length;
    const result = await request(method, path, input, token, { accept: 'application/json' });
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.match(result.headers['content-type'], /^application\/json\b/);
    if (code) assert.equal(result.body.code, code);
    assert.deepEqual(await fingerprint(), before, 'Rejected undo changes no domain row or append-only audit');
    assert.equal(packets.length, n, 'Rejected undo emits no appointment packet');
    return result;
  };
  const link = async (a, b) => {
    const group = await db.AppointmentPatientLink.create({ id: randomUUID(), clinic_id: ids.clinic,
      patient_id: ids.patient, owner_appointment_id: a, revision: 1, created_by: ids.reception });
    await db.AppointmentPatientLinkMember.bulkCreate([
      { link_id: group.id, appointment_id: a, position: 1 },
      { link_id: group.id, appointment_id: b, position: 2 },
    ]);
    return group;
  };
  try {
    const reception = await login(ids.reception), owner = await login(ids.owner), outsider = await login(ids.outsider),
      clinical = await login(ids.assistant);
    for (const previousStatus of ['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']) {
      const id = await create(reception, { estado: previousStatus });
      const before = await db.CitaPaciente.findByPk(id, { raw: true }), capacity = await occupancy(id);
      const receipt = await arrive(id, reception), afterArrival = await silent(), packetCount = packets.length;
      const changed = await undo(id, receipt, reception);
      assert.equal(changed.body.appointment.estado, previousStatus);
      assert.equal(changed.body.undone, true);
      const after = await db.CitaPaciente.findByPk(id, { raw: true });
      for (const key of ['arrived_at', 'arrived_by', 'care_started_at', 'care_started_by',
        'care_completed_at', 'care_completed_by', 'care_schedule_start']) assert.equal(after[key], before[key], key);
      for (const key of ['inicio', 'fin', 'doctor_id', 'instalacion_id', 'paciente_id', 'tratamiento_id', 'import_metadata'])
        assert.deepEqual(after[key], before[key], 'Undo does not rebook ' + key);
      assert.deepEqual(await occupancy(id), capacity, 'The exact booking capacity rows are preserved');
      const afterUndo = await silent();
      assert.equal(afterUndo.AppointmentCareEvent, afterArrival.AppointmentCareEvent + 1,
        'Arrival reversal adds a separate care audit; it never deletes the arrival');
      delete afterArrival.AppointmentCareEvent; delete afterUndo.AppointmentCareEvent;
      assert.deepEqual(afterUndo, afterArrival, 'Undo starts no message, flow, job, consent or medical questionnaire');
      assert.equal(packets.length, packetCount + 1, 'One affected appointment yields one socket invalidation');
      assert.equal(packets.at(-1).room, `clinic:${ids.clinic}`);
      assert.equal(packets.at(-1).payload.appointment_id, id);
      assert.equal(packets.at(-1).payload.estado, previousStatus);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: id, action: 'arrive' } }), 1);
      assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: id, action: 'arrival_corrected' } }), 1);
      await reject('POST', undoPath(id), { change_id: receipt.change_id }, reception, 409, 'appointment_confirmation_undo_used');
    }
    owned.report.checks.push('Native arrival→undo restores all six real prior notification stages and original arrival evidence fields; original booking/occupancy untouched, one socket per affected row, separate arrival_corrected audit, no messages/jobs/flows/consents, replay rejected');

    const scoped = await create(reception), sr = await arrive(scoped, reception);
    await reject('POST', undoPath(scoped), { change_id: sr.change_id }, outsider, 403);
    await reject('POST', undoPath(scoped), { change_id: sr.change_id }, owner, 403, 'appointment_confirmation_undo_forbidden');
    await reject('POST', undoPath(scoped), { change_id: sr.change_id, estado: 'pendiente' }, reception, 400, 'appointment_confirmation_undo_invalid');
    await reject('POST', undoPath(scoped), { change_id: -1 }, reception, 400, 'appointment_confirmation_undo_invalid');
    const other = await create(reception);
    await reject('POST', undoPath(other), { change_id: sr.change_id }, reception, 403, 'appointment_confirmation_undo_forbidden');
    await undo(scoped, sr, reception);
    owned.report.checks.push('Native JWT/MFA/ACL rejects outside-clinic actor, another authorized actor, wrong appointment, invalid receipt and arbitrary requested state without any domain mutation or socket');

    const raced = await create(reception), rr = await arrive(raced, reception), n = packets.length;
    const parallel = await Promise.all([1, 2].map(() => request('POST', undoPath(raced), { change_id: rr.change_id }, reception)));
    assert.deepEqual(parallel.map(result => result.status).sort(), [200, 409]);
    assert.equal(await state(raced), 'pendiente');
    assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: raced, action: 'arrival_corrected' } }), 1);
    assert.equal(packets.length, n + 1);
    owned.report.checks.push('Concurrent actual HTTP undos serialize to one success and one used receipt; one correction audit and one socket only');

    const againstStart = await create(reception), asr = await arrive(againstStart, reception);
    const [inverse, begin] = await Promise.all([
      request('POST', undoPath(againstStart), { change_id: asr.change_id }, reception),
      request('POST', `/api/citas/${againstStart}/care/start`, {}, clinical),
    ]);
    assert([200, 409].includes(inverse.status), JSON.stringify(inverse.body));
    assert([200, 409].includes(begin.status), JSON.stringify(begin.body));
    assert.equal([inverse, begin].filter(result => result.status === 200).length, 1,
      'Starting care and undoing arrival cannot both succeed');
    const againstStartRow = await db.CitaPaciente.findByPk(againstStart);
    if (begin.status === 200) {
      assert.equal(againstStartRow.estado, 'en_atencion'); assert(againstStartRow.care_started_at && againstStartRow.arrived_at);
    } else {
      assert.equal(againstStartRow.estado, 'pendiente'); assert.equal(againstStartRow.arrived_at, null);
      assert.equal(againstStartRow.care_started_at, null);
    }
    owned.report.checks.push('Concurrent native clinical start versus arrival undo has exactly one winner; no started care can be rewound');

    const noteChanged = await create(reception), nr = await arrive(noteChanged, reception);
    assert.equal((await request('PATCH', `/api/citas/${noteChanged}/nota`, { nota: 'OWNED fictitious edit after arrival' }, reception)).status, 200);
    await reject('POST', undoPath(noteChanged), { change_id: nr.change_id }, reception, 409, 'appointment_confirmation_undo_changed');
    const careStarted = await create(reception), cr = await arrive(careStarted, reception);
    const start = await request('POST', `/api/citas/${careStarted}/care/start`, {}, clinical);
    assert.equal(start.status, 200, JSON.stringify(start.body));
    await reject('POST', undoPath(careStarted), { change_id: cr.change_id }, reception, 409, 'appointment_confirmation_undo_changed');
    const reportCreated = await create(reception), pr = await arrive(reportCreated, reception);
    const report = await request('PUT', `/api/citas/${reportCreated}/clinical-report`, {
      expected_version: 0, summary: 'OWNED fictitious clinical draft after arrival',
    }, clinical);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    await reject('POST', undoPath(reportCreated), { change_id: pr.change_id }, reception, 409, 'appointment_confirmation_undo_changed');
    owned.report.checks.push('A later actual note edit, care start or native clinical draft prevents undo atomically; clinical records and the new state remain intact');

    const module = require('../../services/appointmentConfirmationUndo.service');
    const expired = await create(reception), er = await arrive(expired, reception), beforeExpiry = await fingerprint();
    const expiry = module.createAppointmentConfirmationUndoService({ db, now: () => new Date(Date.parse(er.expires_at) + 1) });
    await assert.rejects(() => expiry.undo({ appointmentId: expired, changeId: er.change_id,
      clinicId: ids.clinic, actorId: ids.reception }), { code: 'appointment_confirmation_undo_expired' });
    assert.deepEqual(await fingerprint(), beforeExpiry);
    await assert.rejects(() => module.createAppointmentConfirmationUndoService({ db }).undo({ appointmentId: expired,
      changeId: er.change_id, clinicId: ids.peerClinic, actorId: ids.reception }), { code: 'appointment_confirmation_undo_forbidden' });
    assert.deepEqual(await fingerprint(), beforeExpiry);
    const failed = await create(reception), fr = await arrive(failed, reception), beforeFailure = await fingerprint();
    const failure = module.createAppointmentConfirmationUndoService({ db, recordStatusChange: async () => { throw Error('OWNED_UNDO_AUDIT_FAILURE'); } });
    await assert.rejects(() => failure.undo({ appointmentId: failed, changeId: fr.change_id,
      clinicId: ids.clinic, actorId: ids.reception }), /OWNED_UNDO_AUDIT_FAILURE/);
    assert.deepEqual(await fingerprint(), beforeFailure, 'A failure after the row restoration rolls back row, care correction and all new audit');
    await undo(failed, fr, reception);
    owned.report.checks.push('Injected deterministic clock proves 30-second receipt expiry; direct wrong-clinic call rejects; injected post-restore audit failure rolls back the entire real SQL transaction and receipt remains usable');

    await require('../../../migrations/20261007170000-create-appointment-patient-links').up(f.sql.getQueryInterface(), S);
    db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(f.sql, S.DataTypes);
    db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(f.sql, S.DataTypes);
    const a = await create(reception, { estado: 'recordatorio_confirmado' }), b = await create(reception, { estado: 'recordatorio_confirmado' });
    await link(a, b);
    const linkedBefore = await db.CitaPaciente.findByPk(b, { raw: true });
    const lr = await arrive(a, reception); assert.equal(await state(b), 'recordatorio_confirmado');
    await undo(a, lr, reception);
    assert.equal(await state(a), 'recordatorio_confirmado');
    assert.deepEqual(await db.CitaPaciente.findByPk(b, { raw: true }), linkedBefore,
      'Arrival is local to the actual selected appointment; linked sibling is not falsely arrived or rewound');
    const changedGroupReceipt = await arrive(a, reception);
    const siblingEdit = await request('PATCH', `/api/citas/${b}/nota`, { nota: 'OWNED linked sibling edited' }, reception);
    assert.equal(siblingEdit.status, 200, JSON.stringify(siblingEdit.body));
    await reject('POST', undoPath(a), { change_id: changedGroupReceipt.change_id }, reception, 409, 'appointment_confirmation_undo_changed');
    owned.report.checks.push('Two linked visits: arrival and undo affect only the selected real appointment, preserving sibling confirmation and all linkage');
    assert.equal(f.externalFetchAttempts, 0);
  } finally { await f.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
