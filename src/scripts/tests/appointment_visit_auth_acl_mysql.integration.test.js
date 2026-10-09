'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const { report } = owned;
  const fixture = await createOwnedVisitAuthAclFixture(owned);
  const { db, ids, request, body, fingerprint } = fixture;
  const messages = [], originalError = console.error, originalWarn = console.warn;
  console.error = (...args) => { messages.push({ kind: 'error', message: String(args[0]) }); originalError(...args); };
  console.warn = (...args) => { messages.push({ kind: 'warning', message: String(args[0]) }); originalWarn(...args); };
  const C = require('../../services/authEmailChallenge.contract');
  const sessions = require('../../services/accessSession.service');
  const sourceFiles = [
    'routes/auth.routes', 'routes/auth.middleware', 'controllers/auth.controllers', 'services/accessSession.service',
    'services/authEmailChallenge.service', 'services/authEmailChallenge.contract', 'lib/access-policy',
    'routes/citas.routes', 'controllers/citas.controller', 'services/appointmentBookingCommand.service',
    'services/appointmentCare.service', 'services/appointmentConsentEligibility.service',
    'routes/treatmentDocumentation.routes', 'services/treatmentDocumentation.service',
  ];
  report.proof = { boundaries: fixture.boundaries, employeeId: ids.assistant, globalAdminIdsAbsent: true,
    fixtureHashes: Object.fromEntries([__filename, require.resolve('./helpers/owned-visit-auth-acl-fixture')]
      .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256')
      .update(fs.readFileSync(require.resolve('../../' + file))).digest('hex')])) };
  const sameDomain = async (before, reason) => assert.deepEqual(await fingerprint(), before, reason);
  const denied = async (method, target, value, token, expected, reason, headers) => {
    const before = await fingerprint(), result = await request(method, target, value, token, headers);
    assert.equal(result.status, expected, reason + ': ' + JSON.stringify(result.body));
    await sameDomain(before, reason + ' must not mutate appointment/domain/job state'); return result;
  };
  const signIn = async id => {
    const started = await request('POST', '/api/auth/sign-in', { email: 'owned-' + id + '@example.invalid', password: fixture.password });
    assert.equal(started.status, 202, JSON.stringify(started.body)); assert.match(started.headers['cache-control'], /no-store/);
    assert.equal(started.body.mfaRequired, true); assert.equal(started.body.token, undefined);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(started.body.challengeToken) } });
    assert(row && row.state === 'pending');
    const verified = await request('POST', '/api/auth/email-code/verify', {
      challengeToken: started.body.challengeToken, code: fixture.codeFor(row.challenge_id) });
    assert.equal(verified.status, 200, JSON.stringify(verified.body)); assert.match(verified.headers['cache-control'], /no-store/);
    assert.equal((await sessions.verify(verified.body.token)).userId, id);
    assert.equal((await db.AuthEmailChallenge.findByPk(row.challenge_id)).state, 'used');
    return verified.body.token;
  };
  const override = values => db.AccessPolicyOverride.create({ updated_by: ids.owner, ...values });
  try {
    assert.equal(await db.Usuario.count({ where: { id_usuario: [1, 44] } }), 0);
    assert.equal(require('../../services/treatmentBookingProfile.service').bookingCapabilities().relativeSteps, true);
    assert.equal(process.env.APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED, 'false');
    assert.equal(await db.AutomationFlowTemplateV2.count(), 0);

    const initial = await fingerprint();
    await denied('POST', '/api/auth/sign-in', { email: 'owned-' + ids.assistant + '@example.invalid', password: 'WRONG_FICTITIOUS_PASSWORD' },
      null, 401, 'Actual bcrypt rejects incorrect employee password');
    assert.equal(await db.AuthEmailChallenge.count(), 0); assert.equal(await db.AuthSession.count(), 0);
    assert.equal(await db.OwnedAuthOutbox.count(), 0);
    const pending = await request('POST', '/api/auth/sign-in', { email: 'owned-' + ids.assistant + '@example.invalid', password: fixture.password });
    assert.equal(pending.status, 202, JSON.stringify(pending.body));
    assert.equal(pending.body.mfaRequired, true); assert.equal(pending.body.token, undefined);
    assert.equal(await db.AuthSession.count(), 0); assert.equal(await db.OwnedAuthOutbox.count(), 1);
    await denied('POST', '/api/citas', body(), pending.body.challengeToken, 401, 'Opaque email challenge is not an access session');
    const pendingRow = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(pending.body.challengeToken) } });
    const code = fixture.codeFor(pendingRow.challenge_id), wrongCode = code === '000000' ? '111111' : '000000';
    assert.equal(pendingRow.code_hash, C.codeHash(C.settings().key, pendingRow.challenge_id, code));
    assert.equal(pendingRow.credential_binding, sessions.credentialBinding(await db.Usuario.findByPk(ids.assistant)));
    const stored = JSON.stringify(pendingRow.toJSON());
    for (const secret of [pending.body.challengeToken, code, fixture.password]) assert(!stored.includes(secret));
    await denied('POST', '/api/auth/email-code/verify', { challengeToken: pending.body.challengeToken, code: wrongCode },
      null, 401, 'Actual incorrect code preserves pending challenge without issuing access');
    assert.equal((await db.AuthEmailChallenge.findByPk(pendingRow.challenge_id)).attempts, 1);
    assert.equal(await db.AuthSession.count(), 0);
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: pending.body.challengeToken, code });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const employeeToken = verified.body.token, employeeClaims = jwt.decode(employeeToken);
    assert.equal(employeeClaims.userId, ids.assistant); assert.deepEqual(employeeClaims.amr, ['pwd', 'email']);
    assert.equal(employeeClaims.exp - employeeClaims.iat, 3600);
    assert.equal(employeeClaims.sessionVersion, 1); assert.equal(employeeClaims.iss, 'clinicaclick');
    assert.equal(employeeClaims.aud, 'clinicaclick-platform'); assert.equal(employeeClaims.type, 'cc_access');
    const employeeSession = await db.AuthSession.findByPk(employeeClaims.jti);
    assert.equal(employeeSession.user_id, ids.assistant); assert.equal(employeeSession.authentication_method, 'password_email');
    assert.equal(employeeSession.state, 'active'); assert.equal(employeeSession.credential_binding, pendingRow.credential_binding);
    assert.equal((await db.AuthEmailChallenge.findByPk(pendingRow.challenge_id)).state, 'used');
    assert.equal((await request('GET', '/api/auth/me', undefined, employeeToken)).status, 200);
    await denied('POST', '/api/auth/email-code/verify', { challengeToken: pending.body.challengeToken, code },
      null, 401, 'Used email challenge cannot issue a second session');
    assert.equal(await db.AuthSession.count(), 1);
    await sameDomain(initial, 'Authentication proof never mutates patient/booking/domain data');
    report.checks.push('Actual HTTP bcrypt → pending SQL challenge/outbox → HMAC code verification → consumed proof and managed password_email session; bad password/code/challenge-as-token/replay denied');

    const receptionToken = await signIn(ids.reception), ownerToken = await signIn(ids.owner), outsiderToken = await signIn(ids.outsider);
    await denied('POST', '/api/citas', body(), undefined, 401, 'Missing JWT cannot create appointment');
    const tokenParts = employeeToken.split('.'); tokenParts[2] = (tokenParts[2][0] === 'A' ? 'B' : 'A') + tokenParts[2].slice(1);
    await denied('POST', '/api/citas', body(), tokenParts.join('.'),
      401, 'Tampered JWT cannot create appointment');
    await denied('POST', '/api/citas', body(), outsiderToken, 403, 'Other clinic membership does not grant group-wide booking access');
    await denied('POST', '/api/citas', body({ clinica_id: ids.peerClinic }), employeeToken, 403, 'Employee cannot create in a nonmember peer clinic');
    await denied('POST', '/api/citas', body({ paciente: { id_paciente: ids.foreignPatient } }), employeeToken,
      404, 'Foreign patient ID is indistinguishable from unavailable patient');
    const membership = await db.UsuarioClinica.findOne({ where: { id_usuario: ids.assistant, id_clinica: ids.clinic } });
    await membership.update({ estado_invitacion: 'pendiente' });
    await denied('POST', '/api/citas', body(), employeeToken, 403, 'Pending invitation has no booking rights despite active JWT');
    await membership.update({ estado_invitacion: 'aceptada' });
    const groupDeny = await override({ scope_type: 'group', scope_id: ids.group, feature_key: 'appointments.manage', role_code: 'assistant', effect: 'deny' });
    await denied('POST', '/api/citas', body(), employeeToken, 403, 'Native group deny overrides role default');
    const clinicAllow = await override({ scope_type: 'clinic', scope_id: ids.clinic, feature_key: 'appointments.manage', role_code: 'assistant', effect: 'allow' });
    assert.equal(await require('../../lib/access-policy').canUserAccessFeature({ actorId: ids.assistant,
      clinicId: ids.clinic, featureKey: 'appointments.manage' }), true);
    await clinicAllow.destroy(); await groupDeny.destroy();
    const clinicDeny = await override({ scope_type: 'clinic', scope_id: ids.clinic, feature_key: 'appointments.manage', role_code: 'assistant', effect: 'deny' });
    await denied('POST', '/api/citas', body({ role: 'admin', created_by: 1, updated_by: 1 }), employeeToken, 403,
      'Caller role/actor headers cannot bypass native clinic deny', { 'x-owned-actor-id': '1', 'x-user-role': 'admin' });
    await clinicDeny.destroy();
    report.checks.push('Actual router auth and native ACL deny missing/tampered JWT, foreign clinic/patient, pending membership, group deny and clinic deny without any domain write; forged actor/role has no authority');

    const protocolInput = { clinic_id: ids.clinic, title: 'OWNED synthetic protocol', kind: 'protocol', status: 'approved',
      source: 'OWNED test fixture, not clinical instructions', content: 'Synthetic documentation only. No patient care recommendation.', treatment_ids: [ids.treatment] };
    await denied('POST', '/api/treatment-documentation/protocols', protocolInput, employeeToken, 403,
      'Assistant cannot author approved protocols through native clinic.settings ACL');
    const authored = await request('POST', '/api/treatment-documentation/protocols', protocolInput, ownerToken);
    assert.equal(authored.status, 201, JSON.stringify(authored.body));
    const protocolId = authored.body.item.id;
    assert.equal(authored.body.item.version, 1); assert.equal(authored.body.item.approved_by, ids.owner);
    assert.equal(await db.TreatmentProtocolRevision.count({ where: { protocol_id: protocolId } }), 1);
    report.checks.push('Real documentation router blocks assistant authoring; accepted native owner writes synthetic approved protocol and exact immutable revision');

    const created = await request('POST', '/api/citas', body({ created_by: 1, updated_by: 1, role: 'admin',
      import_metadata: { booking: { version: 1, profile: { version: 1, phases: [] } } } }), employeeToken,
      { 'x-owned-actor-id': '1', 'x-user-role': 'admin' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const appointmentId = created.body.id_cita;
    assert.equal(created.body.created_by, ids.assistant); assert.equal(created.body.updated_by, ids.assistant);
    const native = await db.CitaPaciente.findByPk(appointmentId, { raw: true });
    assert.equal(native.created_by, ids.assistant); assert.equal(native.updated_by, ids.assistant);
    assert.equal(native.source_system, null); assert.equal(native.import_metadata.historical_registration, undefined);
    assert.equal(native.import_metadata.booking.profile.version, 4);
    const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointmentId }, raw: true });
    assert.equal(occupancy.length, 4); assert.equal(new Set(occupancy.map(row => row.phase_key)).size, 2);
    assert.equal(+native.fin - +native.inicio, 40 * 60000);
    for (const row of occupancy) {
      const offset = row.phase_key === 'one' ? 0 : 15, duration = row.phase_key === 'one' ? 40 : 20;
      assert.equal(+row.start_at - +native.inicio, offset * 60000); assert.equal(+row.end_at - +row.start_at, duration * 60000);
    }
    assert.equal(await db.AppointmentVisit.count(), 0); assert.equal(await db.AppointmentVisitCommunication.count(), 0);
    assert.equal(await db.JobRequest.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0); assert.equal(await db.Message.count(), 0);
    report.proof.nativeBooking = { appointmentId, actorId: native.created_by, profileVersion: native.import_metadata.booking.profile.version,
      occupancy: occupancy.map(row => ({ kind: row.resource_kind, resourceKey: row.resource_key, phase: row.phase_key,
        start: row.start_at, end: row.end_at })), managedVisitCount: 0, communicationCount: 0 };
    report.checks.push('Actual employee JWT creates native v4 reservation with four SQL resource occupancies, server-owned snapshot and employee attribution; no global-admin impersonation or communication enrollment');
    await denied('POST', '/api/citas', body(), employeeToken, 409,
      'An active native v4 appointment genuinely consumes capacity for another HTTP booking');

    const docPath = '/api/treatment-documentation/for-appointment/' + appointmentId + '?clinic_id=' + ids.clinic;
    const beforeStartDocs = await request('GET', docPath, undefined, employeeToken);
    assert.equal(beforeStartDocs.status, 200, JSON.stringify(beforeStartDocs.body)); assert.match(beforeStartDocs.headers['cache-control'], /no-store/);
    assert(beforeStartDocs.body.items.some(item => Number(item.id) === protocolId));
    await denied('GET', docPath, undefined, receptionToken, 403, 'Reception lacks native clinical documentation permission');
    await denied('GET', docPath, undefined, outsiderToken, 403, 'Other clinic employee cannot read documentation');
    await denied('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, employeeToken, 409,
      'Real care state requires arrival before start');
    const arrived = await request('POST', '/api/citas/' + appointmentId + '/care/arrive', { clinic_id: ids.clinic }, receptionToken);
    assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).arrived_by, ids.reception);
    await denied('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, receptionToken, 403,
      'Reception may receive but cannot initiate clinical care');
    const clinicalDeny = await override({ scope_type: 'clinic', scope_id: ids.clinic, feature_key: 'clinical.reports.manage', role_code: 'assistant', effect: 'deny' });
    await denied('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, employeeToken, 403,
      'Native clinical-manage override denies start before snapshot/events');
    await clinicalDeny.destroy();
    const started = await request('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, employeeToken);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const startRow = await db.CitaPaciente.findByPk(appointmentId);
    assert.equal(startRow.care_started_by, ids.assistant); assert.equal(startRow.updated_by, ids.assistant);
    assert.equal(startRow.estado, 'en_atencion'); assert(startRow.care_started_at);
    assert.equal(await db.AppointmentCareEvent.count({ where: { appointment_id: appointmentId, action: 'start', actor_id: ids.assistant } }), 1);
    const startEvent = await db.PatientOperationalEvent.findOne({ where: { actor_user_id: ids.assistant, event_type: 'appointment_care_changed',
      metadata: { appointment_id: appointmentId, action: 'start' } }, raw: true });
    assert(startEvent?.metadata.documentation_snapshot.sha256);
    assert.deepEqual(startEvent.metadata.documentation_snapshot.revisions.map(ref => [ref.id, ref.version]), [[protocolId, 1]]);
    const startedProof = await fingerprint();
    assert.equal((await request('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, employeeToken)).status, 200);
    await sameDomain(startedProof, 'Replayed clinical start must be idempotent including all native resource/event/job rows');
    report.checks.push('Actual consent assessment (zero hard requirements), arrival and start permissions/state gate run; assistant start freezes approved revision in native care/operational events and repeats without another event');

    const revised = await request('PATCH', '/api/treatment-documentation/protocols/' + protocolId + '?clinic_id=' + ids.clinic,
      { expected_version: 1, content: 'Updated OWNED synthetic text; not clinical instructions.' }, ownerToken);
    assert.equal(revised.status, 200, JSON.stringify(revised.body)); assert.equal(revised.body.item.version, 2);
    assert.equal(revised.body.item.status, 'draft', 'Substantive edit never silently approves a new version');
    const frozenDocs = await request('GET', docPath, undefined, employeeToken);
    assert.equal(frozenDocs.status, 200, JSON.stringify(frozenDocs.body));
    assert.equal(frozenDocs.body.context_source, 'appointment_start_snapshot');
    assert.equal(frozenDocs.body.items[0].version, 1); assert.equal(frozenDocs.body.items[0].content, protocolInput.content);
    const sensitiveDeny = await override({ scope_type: 'clinic', scope_id: ids.clinic, feature_key: 'patients.sensitive.view', role_code: 'assistant', effect: 'deny' });
    await denied('GET', docPath, undefined, employeeToken, 403, 'Current native patient-sensitive deny applies even after care has started');
    await sensitiveDeny.destroy();
    report.checks.push('Actual started-documentation reads keep exact approved v1 after owner updates to v2; live patient-sensitive permission denial does not expose or mutate the frozen clinical document');

    await membership.update({ estado_invitacion: 'rechazada' });
    await denied('PATCH', '/api/citas/' + appointmentId + '/estado', { estado: 'cancelada' }, employeeToken, 403,
      'Withdrawing membership revokes booking mutation authority before session expiry');
    await membership.update({ estado_invitacion: 'aceptada' });
    const deniedCancel = await denied('PATCH', '/api/citas/' + appointmentId + '/estado', { estado: 'cancelada' }, employeeToken, 409,
      'Started clinical care cannot be cancelled or lose its evidence');
    assert.equal(deniedCancel.body.code, 'care_already_started');
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).estado, 'en_atencion');
    await denied('POST', '/api/citas', body(), employeeToken, 409,
      'Rejecting a cancellation does not release started clinical capacity');
    assert.equal((await request('GET', docPath, undefined, employeeToken)).body.context_source, 'appointment_start_snapshot');

    // Cancellation remains valid for another reservation that has not started.
    // Never rewind the already-started appointment just to test old semantics.
    const otherBody = body({ inicio: new Date(+native.inicio + 2 * 3600000).toISOString() });
    const other = await request('POST', '/api/citas', otherBody, employeeToken);
    assert.equal(other.status, 201, JSON.stringify(other.body));
    const cancelledId = other.body.id_cita;
    const otherOccupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: cancelledId }, raw: true });
    const cancelled = await request('PATCH', '/api/citas/' + cancelledId + '/estado', { estado: 'cancelada' }, employeeToken);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const cancelledRow = await db.CitaPaciente.findByPk(cancelledId);
    assert.equal(cancelledRow.estado, 'cancelada'); assert.equal(cancelledRow.updated_by, ids.assistant);
    assert.equal(cancelledRow.care_started_at, null);
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).care_started_at.toISOString(), startRow.care_started_at.toISOString());
    // Canonical cancellation deliberately retains old occupancy as restore
    // provenance. Real availability JOINs exclude its cancelled appointment.
    assert.deepEqual(await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: cancelledId }, raw: true }), otherOccupancy);
    assert.equal(await db.AppointmentBookingOccupancy.count({ where: { appointment_id: cancelledId }, include: [{ model: db.CitaPaciente, as: 'appointment',
      required: true, where: { estado: { [db.Sequelize.Op.ne]: 'cancelada' } } }] }), 0);
    assert.equal(await db.PatientOperationalEvent.count({ where: { actor_user_id: ids.assistant, event_type: 'appointment.status_changed',
      metadata: { appointment_id: cancelledId, new_status: 'cancelada' } } }), 1);
    await denied('POST', '/api/citas/' + cancelledId + '/care/start', { clinic_id: ids.clinic }, employeeToken, 409,
      'Cancelled clinical appointment cannot be restarted');
    const capacityProof = await request('POST', '/api/citas', body({ inicio: otherBody.inicio }), employeeToken);
    assert.equal(capacityProof.status, 201, JSON.stringify(capacityProof.body));
    assert.notEqual(capacityProof.body.id_cita, cancelledId);
    assert.equal((await request('PATCH', '/api/citas/' + capacityProof.body.id_cita + '/estado', { estado: 'cancelada' }, employeeToken)).status, 200);
    report.proof.cancelledCapacity = { startedAppointmentPreserved: appointmentId, oldOccupancyRowsPreserved: otherOccupancy.length,
      newAppointmentAtSameResourcesAndTime: capacityProof.body.id_cita };
    report.checks.push('Started care rejects cancellation without releasing capacity or frozen documentation; a separate unstarted reservation can be cancelled, keeps occupancy provenance and permits a new native HTTP booking at its former slot');

    const loggedOut = await request('POST', '/api/auth/sign-out', {}, employeeToken);
    assert.equal(loggedOut.status, 200, JSON.stringify(loggedOut.body));
    assert.equal((await db.AuthSession.findByPk(employeeClaims.jti)).state, 'revoked');
    await denied('POST', '/api/citas', body(), employeeToken, 401, 'Managed revoked JWT cannot create a new reservation');
    await denied('GET', docPath, undefined, employeeToken, 401, 'Managed revoked JWT cannot read documentation');
    await denied('PATCH', '/api/citas/' + appointmentId + '/estado', { estado: 'pendiente' }, employeeToken, 401,
      'Managed revoked JWT cannot reactivate cancelled visit');
    await assert.rejects(sessions.verify(employeeToken), /auth_invalid/);
    report.checks.push('Actual HTTP logout durably revokes managed session; native middleware denies read/create/mutate with old JWT and preserves every patient/booking/document/job row');

    assert.equal(await db.AutomationFlowTemplateV2.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0);
    assert.equal(await db.JobRequest.count(), 0); assert.equal(await db.Message.count(), 0); assert.equal(await db.Conversation.count(), 0);
    assert.equal(await db.AppointmentVisit.count(), 0); assert.equal(await db.AppointmentVisitCommunication.count(), 0);
    assert.equal(await db.PatientConsentDocument.count(), 0);
    assert.equal(require('../../services/jobScheduler.service')._getWorkerState().running, false);
    assert.equal(fixture.externalFetchAttempts, 0, 'No provider/fetch boundary was even attempted');
    assert.equal(messages.length, 0, 'No hidden post-commit warning/error may turn this proof into a partial false success');
    const audits = await db.PlatformAuditEvent.findAll({ raw: true });
    assert(audits.length > 0);
    const auditEvents = audits.map(row => require('../../../services/platform-audit/src/event').unpack(row).event);
    assert.equal(auditEvents.filter(event => event.action === 'session.issued' && event.subjectUserId === String(ids.assistant)
      && event.sessionRef === employeeClaims.jti).length, 1);
    assert.equal(auditEvents.filter(event => event.action === 'session.revoked' && event.subjectUserId === String(ids.assistant)
      && event.sessionRef === employeeClaims.jti).length, 1);
    assert.equal(auditEvents.filter(event => event.action === 'auth.email_code' && event.reason === 'code_verified'
      && event.actor.id === String(ids.assistant) && event.sessionRef === employeeClaims.jti).length, 1);
    assert(auditEvents.some(event => event.action === 'auth.email_code' && event.reason === 'code_rejected'));
    assert(auditEvents.some(event => event.action === 'auth.email_code' && event.reason === 'credentials_rejected'));
    report.proof.auditRows = audits.length; report.proof.localOutboxRows = await db.OwnedAuthOutbox.count();
    report.proof.auditIntegrity = 'All rows passed actual canonical unpack/digest validation; employee issue, MFA and revocation share actual SQL session reference';
    report.proof.authSessions = await db.AuthSession.count(); report.proof.httpRequests = fixture.requests;
    report.proof.providerAttempts = 0; report.proof.externalFetchAttempts = fixture.externalFetchAttempts;
    report.proof.workerStarted = false; report.proof.hiddenWarnings = messages;
    report.proof.finalDomain = await fingerprint();
  } finally {
    console.error = originalError; console.warn = originalWarn;
    await fixture.close();
  }
}).catch(error => { console.error(error); process.exitCode = 1; });
