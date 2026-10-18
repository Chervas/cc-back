'use strict';

// Real signed-LOPD profile reconciliation -> durable request -> modular V2 ->
// profile projection/manual correction. Own mysqld/Unix socket, fake contacts,
// frozen clock and a local queue double; no app bootstrap or provider transport.
const assert = require('node:assert/strict');
const S = require('sequelize');
const C = require('../../lib/patient-mobile-verification');
const registration = require('../../lib/registration-privacy-template');
const blocks = require('../../lib/consent-document-blocks');
const choices = require('../../lib/consent-document-choices');
const nativeProfile = require('../../services/patientPrivacyProfile.service');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const createFixture = require('./fixtures/patient_mobile_verification_modular_runtime.fixture');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

withIsolatedCampaignMysql(async scope => {
  const t = await createFixture(scope), { sql, report } = scope, { db, engine } = t, D = S.DataTypes;
  await require('../../../migrations/20261018100000-prepare-patient-mobile-verification-v2').up(sql.getQueryInterface());
  await t.approved.update({ catalog_template_id: (await db.WhatsappTemplateCatalog.findOne({ where: { name: C.TEMPLATE } })).id });
  // The native origin timestamps with the process clock, while transport has
  // its fixture clock. Keep the explicit cut before both, never rewrite events.
  await t.template.update({ trigger_config: { ...t.template.trigger_config, enabled_after: '2026-10-17T13:00:00Z' } });
  const check = text => report.checks.push(text);
  const extend = async (model, fields) => {
    for (const [name, type] of Object.entries(fields)) {
      await sql.getQueryInterface().addColumn(model.tableName, name, { type, allowNull: true });
      model.rawAttributes[name] = { type, allowNull: true };
    }
    model.refreshAttributes();
  };
  await extend(db.Paciente, { public_id: D.STRING, dni: D.STRING, fecha_nacimiento: D.DATEONLY, edad: D.INTEGER,
    direccion: D.STRING, codigo_postal: D.STRING, poblacion: D.STRING, provincia: D.STRING, telefono_secundario: D.STRING });
  await extend(db.PatientConsentDocument, { public_id: D.STRING, purpose: D.STRING, clinic_template_id: D.INTEGER,
    clinic_template_version_id: D.INTEGER, package_id: D.INTEGER, title: D.STRING, snapshot_json: D.JSON,
    snapshot_html: D.TEXT('medium'), signed_at: D.DATE, expires_at: D.DATE, createdAt: D.DATE, updatedAt: D.DATE });
  for (const file of ['clinicconsenttemplate', 'clinicconsenttemplateversion', 'patientcustomfield', 'patientconsentexternalattestation']) {
    const model = require('../../../models/' + file)(sql, D); db[model.name] = model; await model.sync();
  }
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER,
    clinica_id: D.INTEGER, care_started_at: D.DATE, care_legacy_attendance: D.BOOLEAN }, { tableName: 'CitasPacientes', timestamps: false });
  await db.CitaPaciente.sync();
  await db.Clinica.update({ grupoClinicaId: 50 }, { where: { id_clinica: [72, 73] } });
  t.checkCorrection = nativeProfile.checkContactCollisions;
  const profile = loadSource('patientPrivacyProfile.service', {
    'node:crypto': require('node:crypto'),
    './patientPrivacyStatus.service': require('../../services/patientPrivacyStatus.service'),
    './patientMobileVerification.service': { recordRequest: ({ db: ignored, ...values }, options) => t.runtime.recordRequest(values, options) },
  }, {});
  const built = registration.standardDraft({ id_clinica: 72 });
  const bodyJson = { ...built.body_json, document_blocks: { schema_version: blocks.SCHEMA, blocks: [
    { id: 'personal', type: 'patient_data', fields: [...blocks.KEYS] },
    { id: 'notice', type: 'text', html: blocks.validate({ schema_version: blocks.SCHEMA,
      blocks: [{ id: 'notice', type: 'text', html: built.body_html }, { id: 'signature', type: 'signature' }] }).blocks[0].html },
    { id: 'choices', type: 'decisions' }, { id: 'signature', type: 'signature' },
  ] } };
  const template = await db.ClinicConsentTemplate.create({ public_id: 'TESTONLY_ORIGIN_PRIVACY', clinic_id: 72,
    catalog_key: require('../../services/appointmentPrivacyEligibility.service').FINAL_PRIVACY_KEY,
    name: 'TESTONLY privacy', purpose: 'data_protection', status: 'active', is_default: true,
    blocking_policy: 'hard', validity_mode: 'manual' });
  const version = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 1,
    title: 'TESTONLY privacy', locale: 'es', status: 'published', body_html: built.body_html, body_json: bodyJson });
  const signedAt = '2026-10-17T12:00:00Z'; let seq = 800;
  async function seed({ previous = '34000000001', proposed } = {}) {
    const id = ++seq; proposed ||= '340000' + String(id).padStart(5, '0');
    const patient = await db.Paciente.create({ id_paciente: id, public_id: 'TESTONLY_origin_' + id, clinica_id: 72,
      nombre: 'TESTONLY', apellidos: 'Origin ' + id, telefono_movil: previous });
    const context = { clinica: { id: 72 }, responsable: { razon_social: 'TESTONLY Entity', cif: 'TESTONLY',
      direccion: 'TESTONLY Street', telefono: '34000000000', email: 'privacy@example.invalid', dpo_email: 'dpo@example.invalid' },
      paciente: { id, nombre: patient.nombre, apellidos: patient.apellidos,
      telefono: proposed, telefono2: '', email: '', dni: '', direccion: '', codigo_postal: '', ciudad: '', provincia: '', fecha_nacimiento: '', compania: '' } };
    const answers = Object.fromEntries(version.body_json.consent_form.fields.map(({ key }) => [key, 'no']));
    const snapshot = { template: template.toJSON(), version: version.toJSON(), context,
      patient_identity: { confirmed: true }, integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM },
      signature_evidence: { signed_at: signedAt, accepted_statement: true,
        consent_choices: { schema_version: version.body_json.consent_form.schema_version, answers } } };
    const html = blocks.renderVersion(version.toJSON(), context, { choiceEvidence: snapshot.signature_evidence.consent_choices });
    const document = await db.PatientConsentDocument.create({ public_id: 'TESTONLY_origin_doc_' + id, paciente_id: id, clinica_id: 72,
      clinic_template_id: template.id, clinic_template_version_id: version.id, purpose: 'data_protection', title: 'TESTONLY privacy',
      status: 'signed', signed_at: signedAt, snapshot_json: snapshot, snapshot_html: html, snapshot_hash: choices.choiceSnapshotHash(snapshot, html) });
    const frozen = (await document.reload()).toJSON();
    const review = await profile.view({ db, patientId: id, clinicId: 72 });
    assert.equal(review.available, true, 'Source must satisfy the native signed-LOPD eligibility/hash/body checks');
    const payload = { clinic_id: 72, document_id: document.id, snapshot_hash: document.snapshot_hash,
      patient_version: review.patient_version, fields: ['telefono_movil'], acknowledge_contact_changes: true };
    return { patient, document, frozen, payload };
  }
  async function apply(item, patch = {}, extra = {}) {
    return sql.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => profile.apply({ db, patientId: item.patient.id_paciente, clinicId: 72, actorId: 15,
      authorizedPrimaryClinicId: 72, authorizeCurrent: async clinic => assert.equal(clinic, 72), transaction,
      payload: { ...item.payload, ...patch }, ...extra }));
  }
  const requestFor = item => db.PatientOperationalEvent.findOne({ where: { patient_id: item.patient.id_paciente, event_type: C.REQUEST }, order: [['id', 'DESC']] });
  const tasks = request => db.Notification.findAll({ where: { dedupeKey: { [S.Op.like]: `patient-mobile-verification:${request.id}:%` } } });
  async function start(item, { alreadyApplied = false } = {}) {
    if (!alreadyApplied) await apply(item);
    const request = await requestFor(item);
    const dispatch = await t.runtime.dispatch({ request_event_id: request.id, clinic_id: 72 });
    assert(dispatch.result.execution_id, JSON.stringify(dispatch));
    await engine.runExecution(dispatch.result.execution_id);
    const exec = await db.FlowExecutionV2.findByPk(dispatch.result.execution_id);
    const message = await db.Message.findOne({ where: { automation_delivery_key: `mobile-verification:${request.id}:outbound` } });
    if (exec.status !== 'waiting' || !message) {
      const errors = await db.FlowExecutionLogV2.findAll({ where: { flow_execution_id: exec.id, status: 'error' }, raw: true });
      throw Error('TESTONLY_ORIGIN_SEND_NOT_REACHED:' + errors.map(row => row.error_message).join(','));
    }
    return { ...item, request, exec, message };
  }
  async function run(item) {
    const exec = await item.exec.reload();
    return engine.runExecution(exec.id, exec.status === 'waiting' ? { resumeMode: 'retry_current_node' } : {});
  }
  async function accept(item) {
    await item.message.reload(); await item.message.update({ metadata: { ...item.message.metadata,
      wamid: 'wamid.TESTONLY.ORIGIN.' + item.message.id, provider_acceptance_at: t.clock.toISOString() } });
  }
  async function reply(item, answer) {
    await item.message.reload();
    const message = await db.Message.create({ conversation_id: item.message.conversation_id, direction: 'inbound',
      message_type: 'text', content: answer, status: 'delivered', sent_at: t.clock, metadata: { historical: false,
        automatic_actions_allowed: true, inbox_receipt: 'TESTONLY', fresh_inbound_dispatched_at: t.clock.toISOString(),
        phone_number_id: t.sender.phoneNumberId, waba_id: t.sender.wabaId, context: { id: item.message.metadata.wamid },
        button: { payload: `pmv:${item.request.id}:${item.request.metadata.reply_token}:${answer}` } } });
    return t.runtime.inbound({ message, conversation: await db.Conversation.findByPk(message.conversation_id) });
  }
  async function manual(item, action, extra = {}) {
    const state = await t.runtime.state(item.request);
    return sql.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => t.runtime.manual({ patientId: item.patient.id_paciente, clinicId: 72, actorId: 16,
      authorizeCurrent: async () => {}, transaction, payload: { request_event_id: item.request.id, revision: state.revision, action, ...extra } }));
  }

  const disabled = await seed();
  assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: C.REQUEST } }), 0, 'Signing and opening source do not request verification');
  await assert.rejects(apply(disabled, { acknowledge_contact_changes: false }), /Confirma expresamente/);
  assert.equal((await disabled.patient.reload()).telefono_movil, '34000000001');
  await apply(disabled); const disabledRequest = await requestFor(disabled);
  assert.equal(disabledRequest.metadata.delivery_enabled, false); assert.equal(await db.JobRequest.count(), 0);
  assert.equal(await db.Message.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0);
  assert.deepEqual((await disabled.document.reload()).toJSON(), disabled.frozen);
  t.enabled = true;
  assert.equal((await t.runtime.dispatch({ request_event_id: disabledRequest.id, clinic_id: 72 })).result.skipped, true);
  await assert.rejects(apply(disabled), /han cambiado/);
  assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: disabled.patient.id_paciente, event_type: C.REQUEST } }), 1);
  check('real signed-LOPD eligibility + explicit reception apply creates one immutable, disabled request; signature/read/retry and later activation do not replay it');

  const active = await seed();
  const racingAcceptances = await Promise.allSettled(Array.from({ length: 4 }, () => apply(active)));
  assert.equal(racingAcceptances.filter(row => row.status === 'fulfilled').length, 1);
  assert(racingAcceptances.filter(row => row.status === 'rejected').every(row => row.reason.code === 'privacy_profile_changed'));
  assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: active.patient.id_paciente, event_type: C.REQUEST } }), 1);
  const current = await start(active, { alreadyApplied: true });
  assert.equal(current.request.metadata.phone, active.document.snapshot_json.context.paciente.telefono);
  assert.equal(current.request.metadata.previous_phone, '34000000001'); assert.equal(current.request.metadata.document_id, active.document.id);
  assert.equal(current.request.metadata.snapshot_hash, active.document.snapshot_hash); assert.equal(current.request.actor_user_id, 15);
  assert.equal(current.request.metadata.delivery_enabled, true);
  assert.equal([...t.queued.values()].at(-1).to, current.request.metadata.phone);
  const parallel = await Promise.all(Array.from({ length: 8 }, () => t.runtime.dispatch({ request_event_id: current.request.id, clinic_id: 72 })));
  assert(parallel.every(row => Number(row.result.execution_id) === current.exec.id));
  await accept(current); await reply(current, 'yes'); await run(current);
  const shown = await t.runtime.view({ patientId: current.patient.id_paciente, clinicId: 72 });
  assert.equal(shown.items[0].state, 'confirmed'); assert.equal(shown.items[0].phone, current.request.metadata.phone);
  assert(!JSON.stringify(shown).includes('reply_token'));
  assert.equal((await t.runtime.view({ patientId: current.patient.id_paciente, clinicId: 73 })).items.length, 0);
  assert.deepEqual((await current.document.reload()).toJSON(), current.frozen);
  check('real origin request traverses modular send/wait/button/result and projects verified state; concurrent origin acceptance/dispatch is idempotent, signed source unchanged, foreign clinic empty');

  const rejected = await start(await seed()); await accept(rejected); await reply(rejected, 'no'); await run(rejected);
  assert.equal((await t.runtime.state(rejected.request)).reason, 'patient_rejected'); assert.equal((await tasks(rejected.request)).length, 2);
  const corrected = await manual(rejected, 'correct', { phone: '34000000991', acknowledged: true });
  const replacement = await db.PatientOperationalEvent.findByPk(corrected.request_event_id);
  assert.equal(replacement.source, 'reception_mobile_verification'); assert.equal(replacement.metadata.phone, '34000000991');
  assert.equal((await rejected.patient.reload()).telefono_movil, '34000000991');
  assert.equal((await t.runtime.state(rejected.request)).current, false);
  assert((await tasks(rejected.request)).every(row => row.isRead && row.data.resolved));
  assert.equal((await reply(rejected, 'yes')).ignored, true);
  check('explicit NO creates reception task; correction atomically changes mobile, supersedes old verification, closes old task and rejects its late YES');

  const timed = await start(await seed()); await accept(timed);
  t.clock = new Date(+t.clock + 61 * 60000); await run(timed);
  assert.equal((await t.runtime.state(timed.request)).reason, 'no_response');
  await reply(timed, 'yes'); await run(timed);
  assert.equal((await t.runtime.state(timed.request)).state, 'confirmed'); assert((await tasks(timed.request)).every(row => row.isRead && row.data.resolved));
  const failed = await start(await seed()); await failed.message.update({ status: 'failed' });
  await db.FlowExecutionV2.update({ wait_until: new Date(0) }, { where: { id: failed.exec.id } }); await run(failed);
  assert.equal((await t.runtime.state(failed.request)).reason, 'delivery_failed'); assert.notEqual((await t.runtime.state(failed.request)).reason, 'no_response');
  await manual(failed, 'confirm'); assert.equal((await t.runtime.state(failed.request)).provenance, 'manual_review');
  assert((await tasks(failed.request)).every(row => row.isRead && row.data.resolved));
  check('origin timeout is distinct from failed delivery; late positive resolves only current silence; audited manual confirmation closes delivery review');

  const deferred = await start(await seed()); await accept(deferred);
  t.clock = new Date(+t.clock + 61 * 60000); await run(deferred);
  const beforePending = await t.runtime.state(deferred.request), pendingTasks = await tasks(deferred.request);
  assert.equal(beforePending.reason, 'no_response');
  await manual(deferred, 'pending'); const kept = await t.runtime.state(deferred.request);
  assert.equal(kept.state, 'review_required'); assert.equal(kept.reason, 'no_response');
  assert.equal(kept.manually_resolved, false); assert.equal(kept.provenance, 'manual_pending');
  assert.deepEqual((await tasks(deferred.request)).map(row => row.id), pendingTasks.map(row => row.id));
  assert((await tasks(deferred.request)).every(row => !row.isRead && !row.data.resolved));
  await reply(deferred, 'yes'); t.restart(); await run(deferred);
  const lateConfirmed = await t.runtime.state(deferred.request);
  assert.equal(lateConfirmed.state, 'confirmed'); assert.equal(lateConfirmed.provenance, 'patient_reply');
  assert.equal(lateConfirmed.actor_user_id, null, 'A late patient response never inherits reception actor from Dejar pendiente');
  assert(lateConfirmed.history.some(row => row.provenance === 'manual_pending' && row.actor_user_id === 16));
  assert((await tasks(deferred.request)).every(row => row.isRead && row.data.resolved));
  check('Dejar pendiente preserves silence review and the existing reception task without false resolution; valid late YES still closes it after restart');

  const mobileService = loadSource('patientMobileVerification.service', {
    'node:crypto': require('node:crypto'), './patientPrivacyProfile.service': nativeProfile,
    './jobRequests.service': t.requests,
    './notificationsRealtime.service': { emitNotificationUpdated() {} },
  }, { JOB_RUNTIME_NAMESPACE: 'TESTONLY' });
  async function genericEdit(item, nextPhone, { previousPhone, throwAfterSave = false } = {}) {
    await item.patient.reload();
    return mobileService.withPatientMobileChange({ db, patientId: item.patient.id_paciente, clinicId: 72,
      previousPhone: previousPhone ?? item.patient.telefono_movil, nextPhone, actorId: 16,
      authorizeCurrent: async row => assert.equal(row.id_paciente, item.patient.id_paciente) }, async transaction => {
      await item.patient.update({ telefono_movil: nextPhone }, { transaction });
      if (throwAfterSave) throw Error('TESTONLY_GENERIC_EDIT_ROLLBACK');
      return { saved: true };
    });
  }
  const changed = await start(await seed()); await accept(changed);
  await reply(changed, 'no'); await run(changed);
  const eventCount = await db.PatientOperationalEvent.count({ where: { event_type: C.REQUEST } });
  const requestJobCount = await db.JobRequest.count({ where: { type: 'patient_mobile_verification_dispatch' } });
  const originalPhone = changed.request.metadata.phone;
  await assert.rejects(genericEdit(changed, '34000000992', { throwAfterSave: true }), /TESTONLY_GENERIC_EDIT_ROLLBACK/);
  assert.equal((await changed.patient.reload()).telefono_movil, originalPhone);
  assert.equal((await t.runtime.state(changed.request)).current, true, 'Failed master save cannot retire the live request');
  await assert.rejects(genericEdit(changed, '34000000992', { previousPhone: '34000000993' }), /mobile_verification_changed/);
  await genericEdit(changed, '34000000992');
  assert.equal((await t.runtime.state(changed.request)).current, false);
  assert.equal((await t.runtime.state(changed.request)).reason, 'phone_changed');
  assert((await tasks(changed.request)).every(row => row.isRead && row.data.resolved));
  await genericEdit(changed, originalPhone);
  assert.equal((await t.runtime.state(changed.request)).current, false, 'A -> B -> A must not resurrect the original verification');
  assert.equal((await reply(changed, 'yes')).ignored, true);
  assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: C.REQUEST } }), eventCount);
  assert.equal(await db.JobRequest.count({ where: { type: 'patient_mobile_verification_dispatch' } }), requestJobCount);
  assert.deepEqual((await changed.document.reload()).toJSON(), changed.frozen);
  check('actual generic master edit transaction invalidates old evidence permanently across A-B-A; no new request/dispatch; task closure, CAS and rollback preserve scope/atomicity');

  const collision = await seed({ proposed: '34000000991' });
  await assert.rejects(apply(collision), error => error.code === 'privacy_profile_contact_collision');
  assert.equal(await requestFor(collision), null); assert.equal((await collision.patient.reload()).telefono_movil, '34000000001');
  const atomic = await seed(), eventCreate = db.PatientOperationalEvent.create;
  try {
    db.PatientOperationalEvent.create = function(values, options) {
      if (values.event_type === C.REQUEST) throw Error('TESTONLY_OUTBOX_FAILURE');
      return eventCreate.call(this, values, options);
    };
    await assert.rejects(apply(atomic), /TESTONLY_OUTBOX_FAILURE/);
  } finally { db.PatientOperationalEvent.create = eventCreate; }
  assert.equal((await atomic.patient.reload()).telefono_movil, '34000000001'); assert.equal(await requestFor(atomic), null);
  assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: atomic.patient.id_paciente, event_type: 'patient.privacy_profile_applied' } }), 0);
  check('real collision check rejects other-patient contact; request/outbox failure rolls back master, apply audit and dispatch job together');
  const oldNumber = await seed();
  const oldChat = await db.Conversation.create({ clinic_id: 72, patient_id: oldNumber.patient.id_paciente, channel: 'whatsapp', contact_id: '34000000001' });
  const oldChatSnapshot = (await oldChat.reload()).toJSON();
  const oldMessage = await db.Message.create({ conversation_id: oldChat.id, direction: 'inbound', message_type: 'text',
    content: 'TESTONLY old-number history', status: 'delivered', sent_at: t.clock, metadata: { TESTONLY: 'immutable-old-chat' } });
  const oldMessageSnapshot = (await oldMessage.reload()).toJSON();
  const newNumber = await start(oldNumber);
  assert.notEqual(newNumber.message.conversation_id, oldChat.id);
  const newChat = await db.Conversation.findByPk(newNumber.message.conversation_id);
  assert.equal(C.phone(newChat.contact_id), newNumber.request.metadata.phone);
  assert.equal(newChat.patient_id, oldNumber.patient.id_paciente);
  assert.deepEqual((await oldChat.reload()).toJSON(), oldChatSnapshot, 'Neither accepted phone nor new message merges/repoints the old conversation');
  assert.deepEqual((await oldMessage.reload()).toJSON(), oldMessageSnapshot, 'Old-number messages stay in their old conversation and byte-unchanged');
  check('an acknowledged change with an existing old-number chat creates/selects a distinct exact-new-number conversation; old chat and old messages stay byte-unchanged');

  const formatted = await seed(), formattedPhone = formatted.document.snapshot_json.context.paciente.telefono;
  const formattedContact = '+' + formattedPhone.slice(0, 2) + ' ' + formattedPhone.slice(2, 5) + ' '
    + formattedPhone.slice(5, 8) + ' ' + formattedPhone.slice(8);
  const formattedChat = await db.Conversation.create({ clinic_id: 72, patient_id: formatted.patient.id_paciente,
    channel: 'whatsapp', contact_id: formattedContact });
  const formattedSnapshot = (await formattedChat.reload()).toJSON();
  const formattedSend = await start(formatted);
  assert.equal(formattedSend.message.conversation_id, formattedChat.id);
  assert.equal([...t.queued.values()].at(-1).to, formattedSend.request.metadata.phone);
  const sentChat = (await formattedChat.reload()).toJSON();
  assert.deepEqual({ ...sentChat, last_message_at: formattedSnapshot.last_message_at }, formattedSnapshot,
    'Only the ordinary outgoing last-message timestamp may change; identity, formatting, owner and other fields remain unchanged');
  check('normalized same-number lookup reuses a formatted exact-owner conversation without duplicating or rewriting its stored identity');

  const ambiguous = await seed();
  const ambiguousPhone = ambiguous.document.snapshot_json.context.paciente.telefono;
  const duplicates = await db.Conversation.bulkCreate([ambiguousPhone, '+' + ambiguousPhone.slice(0, 2) + ' ' + ambiguousPhone.slice(2)].map(contact_id => ({
    clinic_id: 72, patient_id: ambiguous.patient.id_paciente, channel: 'whatsapp', contact_id })));
  const duplicateSnapshots = await Promise.all(duplicates.map(async row => (await row.reload()).toJSON()));
  const beforeAmbiguousJobs = t.queued.size;
  await apply(ambiguous); const ambiguousRequest = await requestFor(ambiguous);
  const ambiguousDispatch = await t.runtime.dispatch({ request_event_id: ambiguousRequest.id, clinic_id: 72 });
  await engine.runExecution(ambiguousDispatch.result.execution_id);
  assert.equal((await t.runtime.state(ambiguousRequest)).reason, 'delivery_failed');
  assert.equal((await tasks(ambiguousRequest)).length, 2);
  assert.equal(t.queued.size, beforeAmbiguousJobs, 'Ambiguous same-contact ownership never reaches simulated transport');
  assert.equal(await db.Message.count({ where: { automation_delivery_key: `mobile-verification:${ambiguousRequest.id}:outbound` } }), 0);
  assert.deepEqual(await Promise.all(duplicates.map(async row => (await row.reload()).toJSON())), duplicateSnapshots,
    'Verification never arbitrarily selects, merges, normalizes or reassigns duplicate exact-number chats');
  check('duplicate exact-new-number conversations fail closed to reception review with no message/transport, row merge or arbitrary winner');
  assert.equal(report.rejected.length, 0); report.simulatedTransportJobs = t.queued.size;
}).catch(error => { console.error(error); process.exitCode = 1; });
