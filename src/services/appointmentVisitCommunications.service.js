'use strict';

// Explicit dependencies: importing this module cannot bootstrap the app, DB,
// workers, transport or import/release policy. These are real Sequelize writes,
// confined to the three foundation tables and caller-owned transactions.
const { randomUUID } = require('node:crypto');
const c = require('../lib/appointment-clinical-components');
const v = require('../lib/appointment-visit-communication');
const operations = require('../lib/whatsappImportedAppointmentOperations');
const legacyRelease = require('../lib/whatsappImportedReminderRelease');
const runtimeContract = require('../lib/appointment-visit-runtime-contract');
const { plain, fail, positiveId, uuid } = v;

function createAppointmentVisitCommunicationService({ db, now = () => new Date(), newId = randomUUID,
  readOperationalPolicy = operations.read, readLegacyPolicy = legacyRelease.read }) {
  for (const name of ['CitaPaciente', 'AppointmentVisit', 'AppointmentVisitMember', 'AppointmentVisitCommunication']) {
    if (!db?.[name]) throw Error('appointment_visit_dependency_missing:' + name);
  }
  if (!db.sequelize?.transaction) throw Error('appointment_visit_transaction_unavailable');
  const options = tx => ({ transaction: tx, hooks: false });
  const transaction = (supplied, execute) => {
    const checked = tx => {
      if (tx?.options?.isolationLevel !== 'READ COMMITTED' || !tx.LOCK?.UPDATE) fail('transaction_invalid');
      return execute(tx);
    };
    return supplied ? checked(supplied) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, checked);
  };
  function scope(clinicId, actorId) {
    if (!positiveId(clinicId) || actorId != null && !positiveId(actorId)) fail('invalid_scope', 400);
  }
  async function lockAppointments(ids, clinicId, tx) {
    const appointments = [];
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
      if (!positiveId(id)) fail('invalid_appointment', 400);
      const row = await db.CitaPaciente.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!row || Number(row.clinica_id) !== clinicId) fail('appointment_not_found', 404);
      if (!positiveId(Number(row.paciente_id))) fail('invalid_scope');
      appointments.push(row);
    }
    return appointments;
  }
  async function lockVisits(ids, clinicId, tx) {
    const visits = new Map();
    for (const id of [...new Set(ids)].sort()) {
      if (!uuid(id)) fail('invalid_visit', 400);
      const row = await db.AppointmentVisit.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!row || Number(row.clinic_id) !== clinicId) fail('visit_not_found', 404);
      visits.set(id, row);
    }
    return visits;
  }
  async function readPrpProof(component, parent, tx) {
    if (!db.Tratamiento || !db.PatientOperationalEvent) fail('grouping_guard_unavailable');
    const receipt = c.metadata(component)[c.PARENT_KEY];
    if (!c.validReceipt(receipt)) fail('clinical_relation_unproven');
    const treatment = await db.Tratamiento.findByPk(parent.tratamiento_id, { transaction: tx, lock: tx.LOCK.SHARE });
    const auditEvent = await db.PatientOperationalEvent.findByPk(receipt.audit_event_id, { transaction: tx, lock: tx.LOCK.SHARE });
    const context = c.componentContext({ component, parent, treatment, auditEvent });
    if (!c.isValidatedClinicalComponentContext(context, component)) fail('clinical_relation_unproven');
    return { component_appointment_id: Number(component.id_cita), parent_appointment_id: Number(parent.id_cita),
      receipt_sha256: context.receipt_sha256, audit_event_id: receipt.audit_event_id };
  }
  async function projectionFor(visit, appointments, members, tx) {
    const row = plain(visit);
    const projection = v.buildVisitSnapshot({ visitId: row.id, ownerAppointmentId: Number(row.owner_appointment_id),
      appointments, members, groupingKind: row.grouping_kind, evidence: row.grouping_evidence });
    if (Number(row.clinic_id) !== projection.snapshot.clinic_id || Number(row.patient_id) !== projection.snapshot.patient_id) fail('scope_changed');
    if (row.grouping_kind === 'validated_prp') {
      const evidence = v.groupingEvidence(row.grouping_kind, row.grouping_evidence);
      const component = appointments.find(a => Number(a.id_cita) === evidence.component_appointment_id);
      const parent = appointments.find(a => Number(a.id_cita) === evidence.parent_appointment_id);
      if (!component || !parent || v.hash(await readPrpProof(component, parent, tx)) !== v.hash(evidence)) fail('clinical_relation_changed');
    } else if (appointments.some(a => {
      const metadata = c.metadata(a);
      return metadata[c.PARENT_KEY] != null || metadata[c.CHILDREN_KEY] != null;
    })) {
      // Do not let two already linked historical IDs independently claim.
      fail('clinical_grouping_required');
    }
    return projection;
  }
  const purposeTriggers = { appointment_details: ['appointment_created', 'appointment_rescheduled'],
    reminder_day_before: ['appointment_reminder_window'], reminder_same_day: ['appointment_reminder_window'],
    confirmation_acknowledgement: ['appointment_confirmed'], confirmation_timeout: ['appointment_created', 'appointment_reminder_window'],
    cancellation: ['appointment_cancelled'], no_show: ['appointment_no_show'], completed: ['appointment_completed'],
    aftercare: ['appointment_after'], clinical_consent: ['consent_required'] };
  async function assertEligibility(context, purpose, tx, { communication = null, execution = null, templateVersionId = null, window = null } = {}) {
    const time = new Date(now()).getTime(), owner = context.appointments.find(a => Number(a.id_cita) === Number(context.visit.owner_appointment_id));
    if (!owner) fail('invalid_membership');
    // Initial managed lane remains native/future v4 at every use. Existing
    // protected imported-operation releases still govern UNENROLLED foundation
    // callers below; they never become a managed enrollment fallback.
    if (context.visit.runtime_enrollment) {
      const origin = v.object(context.visit.runtime_enrollment).origin;
      const voucherOriginProof = origin == null ? null : await require('../lib/voucher-booking-origin')
        .createVoucherBookingOriginReader({ db }).forVisit({ visit: context.visit, appointment: owner, transaction: tx });
      runtimeContract.assertManagedEligibility(owner, purpose, now(), { voucherOriginProof, transaction: tx });
      await require('../lib/appointment-visit-reminder-current').assertReminderCurrent({ db, visit: context.visit, owner, purpose,
        templateVersionId: execution?.template_version_id || communication?.template_version_id || templateVersionId,
        window, communication, transaction: tx, now: now() });
    }
    if (!execution && communication?.execution_id) {
      if (!db.FlowExecutionV2) fail('binding_guard_unavailable');
      execution = await db.FlowExecutionV2.findByPk(communication.execution_id, { transaction: tx });
    }
    if (execution) {
      const captured = v.object(v.object(execution.context).appointment);
      if (context.visit.runtime_enrollment) {
        if (!communication || !db.AutomationFlowTemplateV2) fail('runtime_stage_binding_required');
        const binding = runtimeContract.assertStageExecution({ visit: context.visit, communication, execution });
        const template = await db.AutomationFlowTemplateV2.findByPk(execution.template_version_id, { transaction: tx });
        if (!template || runtimeContract.graphHash(template) !== binding.manifest.graph_sha256) fail('runtime_graph_changed');
      }
      if (!['running', 'waiting', 'completed'].includes(execution.status)) fail('execution_not_active');
      if (Number(execution.clinic_id) !== Number(owner.clinica_id) || execution.trigger_entity_type !== 'appointment'
        || Number(execution.trigger_entity_id) !== Number(owner.id_cita)
        || !context.visit.runtime_enrollment && !purposeTriggers[purpose]?.includes(execution.trigger_type)
        || v.instant(captured.inicio) !== v.instant(owner.inicio) || v.qa(v.object(execution.context))) fail('execution_scope_changed');
      for (const field of ['id_cita', 'clinica_id', 'paciente_id']) {
        if (captured[field] != null && Number(captured[field]) !== Number(owner[field])) fail('execution_scope_changed');
      }
    }
    const rawOperational = readOperationalPolicy(), rawLegacy = readLegacyPolicy();
    const policy = rawOperational ? operations.validate(rawOperational, { now: time }) : null;
    const legacy = rawLegacy ? legacyRelease.validate(rawLegacy) : null;
    const importedOwner = !!(owner.source_system || owner.source_reference || v.held(owner.import_metadata));
    const freshIntent = approval => (!communication || new Date(communication.created_at).getTime() >= Date.parse(approval))
      && (!window || Date.parse(window.starts_at) >= Date.parse(approval));
    const operationalOwner = policy && freshIntent(policy.approvedAt)
      && (execution ? operations.permits(owner, { execution, policy, now: time }) : !communication && operations.allowsAppointment(owner, { policy, now: time }));
    const legacyOwner = purpose === 'reminder_day_before' && legacy && freshIntent(legacy.approvedAt)
      && legacyRelease.permits(owner, { execution, templateVersionId: execution?.template_version_id || templateVersionId, policy: legacy, now: time })
      && (!communication || !!execution);
    const decisions = new Map();
    for (const appointment of context.appointments) {
      const operational = !!operationalOwner && operations.allowsAppointment(appointment, { policy, now: time });
      const exactLegacy = !!legacyOwner && legacyRelease.permits(appointment,
        { templateVersionId: execution?.template_version_id || templateVersionId, policy: legacy, now: time });
      decisions.set(appointment, { allowed: operational || exactLegacy, sameDayOff: importedOwner && (operational || exactLegacy),
        suppressionOverride: operational && operations.allowsSuppressionOverride(appointment, { policy, now: time })
          || exactLegacy && purpose === 'reminder_day_before' });
      if (operations.isHistorical(appointment)) fail('held');
    }
    v.assertNotificationEligibility({ appointments: context.appointments, purpose, now: now(),
      releaseForAppointment: appointment => decisions.get(appointment) });
  }
  // Canonical lock order: existing appointments by numeric ID, membership,
  // visits by stable ID, communication. No runtime/execution/message writes.
  async function lockedVisit(visitId, clinicId, tx) {
    if (!uuid(visitId)) fail('invalid_visit', 400);
    const first = await db.AppointmentVisit.findByPk(visitId, { transaction: tx });
    if (!first || Number(first.clinic_id) !== clinicId) fail('visit_not_found', 404);
    const before = await db.AppointmentVisitMember.findAll({ where: { visit_id: visitId }, transaction: tx,
      order: [['appointment_id', 'ASC']] });
    if (![1, 2].includes(before.length)) fail('invalid_membership');
    const appointments = await lockAppointments(before.map(m => Number(m.appointment_id)), clinicId, tx);
    const members = [];
    for (const appointment of appointments) {
      const member = await db.AppointmentVisitMember.findByPk(Number(appointment.id_cita), { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!member || member.visit_id !== visitId) fail('membership_changed');
      members.push(member);
    }
    const visit = (await lockVisits([visitId], clinicId, tx)).get(visitId);
    const after = await db.AppointmentVisitMember.findAll({ where: { visit_id: visitId }, transaction: tx,
      lock: tx.LOCK.UPDATE, order: [['appointment_id', 'ASC']] });
    if (after.length !== members.length || after.some((m, i) => Number(m.appointment_id) !== Number(members[i].appointment_id))) fail('membership_changed');
    const projection = await projectionFor(visit, appointments, members, tx);
    return { visit, members, appointments, projection };
  }
  function identityValues({ id, appointments, members, ownerId, kind, evidence, actorId }) {
    const projection = v.buildVisitSnapshot({ visitId: id, ownerAppointmentId: ownerId, appointments, members,
      groupingKind: kind, evidence });
    return { id, clinic_id: projection.snapshot.clinic_id, patient_id: projection.snapshot.patient_id,
      owner_appointment_id: ownerId, grouping_kind: kind, grouping_evidence: evidence, status: 'active',
      communication_revision: 1, ...projection, created_by: actorId ?? null, updated_by: actorId ?? null };
  }
  function memberValues(appointment, visitId, role, evidence) {
    return { appointment_id: Number(appointment.id_cita), visit_id: visitId, clinic_id: Number(appointment.clinica_id),
      patient_id: Number(appointment.paciente_id), role, evidence };
  }

  async function ensureSingletonVisit({ appointmentId, clinicId, actorId = null, transaction: tx = null }) {
    scope(clinicId, actorId);
    return transaction(tx, async current => {
      const [appointment] = await lockAppointments([appointmentId], clinicId, current);
      const member = await db.AppointmentVisitMember.findByPk(appointmentId, { transaction: current, lock: current.LOCK.UPDATE });
      if (member) {
        if (Number(member.clinic_id) !== clinicId || Number(member.patient_id) !== Number(appointment.paciente_id)) fail('scope_changed');
        const visit = (await lockVisits([member.visit_id], clinicId, current)).get(member.visit_id);
        if (visit.status !== 'active' || Number(visit.patient_id) !== Number(appointment.paciente_id)) fail('visit_not_active');
        return { created: false, visit };
      }
      const id = newId(), values = memberValues(appointment, id, 'primary', {});
      const visit = await db.AppointmentVisit.create(identityValues({ id, appointments: [appointment], members: [values],
        ownerId: appointmentId, kind: 'singleton', evidence: {}, actorId }), options(current));
      await db.AppointmentVisitMember.create(values, options(current));
      return { created: true, visit };
    });
  }

  async function linkValidatedPrpVisit({ componentAppointmentId, parentAppointmentId, clinicId, actorId = null, transaction: tx = null }) {
    scope(clinicId, actorId);
    if (componentAppointmentId === parentAppointmentId) fail('invalid_membership', 400);
    return transaction(tx, async current => {
      const appointments = await lockAppointments([componentAppointmentId, parentAppointmentId], clinicId, current);
      const component = appointments.find(a => Number(a.id_cita) === componentAppointmentId);
      const parent = appointments.find(a => Number(a.id_cita) === parentAppointmentId);
      const evidence = await readPrpProof(component, parent, current);
      const existingMembers = [];
      for (const appointment of appointments) {
        const member = await db.AppointmentVisitMember.findByPk(Number(appointment.id_cita), { transaction: current, lock: current.LOCK.UPDATE });
        if (member) {
          if (Number(member.clinic_id) !== clinicId || Number(member.patient_id) !== Number(appointment.paciente_id)) fail('scope_changed');
          existingMembers.push(member);
        }
      }
      const visits = await lockVisits(existingMembers.map(m => m.visit_id), clinicId, current);
      for (const visit of visits.values()) {
        if (visit.status !== 'active' || Number(visit.patient_id) !== Number(parent.paciente_id)) fail('visit_not_active');
        const members = await db.AppointmentVisitMember.findAll({ where: { visit_id: visit.id }, transaction: current, lock: current.LOCK.UPDATE });
        if (members.some(m => ![componentAppointmentId, parentAppointmentId].includes(Number(m.appointment_id)))) fail('invalid_membership');
      }
      if (existingMembers.length === 2 && existingMembers[0].visit_id === existingMembers[1].visit_id) {
        const visit = visits.get(existingMembers[0].visit_id);
        const projection = await projectionFor(visit, appointments, existingMembers, current);
        v.assertCurrentProjection({ visit, projection, expectedRevision: Number(visit.communication_revision) });
        if (visit.grouping_kind !== 'validated_prp' || v.hash(visit.grouping_evidence) !== v.hash(evidence)) fail('clinical_relation_changed');
        return { created: false, visit, relation: evidence };
      }
      // Adopting an execution/wait/reply from two existing histories requires a
      // separately approved reconciliation. Never manufacture that decision.
      for (const visit of visits.values()) {
        if (visit.grouping_kind !== 'singleton' || Number(visit.owner_appointment_id) !== Number(existingMembers.find(m => m.visit_id === visit.id)?.appointment_id)) fail('invalid_membership');
        if (await db.AppointmentVisitCommunication.findOne({ where: { visit_id: visit.id }, transaction: current, lock: current.LOCK.UPDATE })) fail('grouping_communication_history_requires_review');
        // Existing legacy automation history is not yet in our new tables.
        if (!db.FlowExecutionV2) fail('legacy_history_guard_unavailable');
        if (await db.FlowExecutionV2.findOne({ where: { clinic_id: clinicId, trigger_entity_type: 'appointment',
          trigger_entity_id: Number(visit.owner_appointment_id) }, transaction: current })) fail('grouping_communication_history_requires_review');
      }
      // Guard legacy history even if no new singleton has been created yet.
      if (!db.FlowExecutionV2) fail('legacy_history_guard_unavailable');
      for (const appointment of appointments) {
        if (await db.FlowExecutionV2.findOne({ where: { clinic_id: clinicId, trigger_entity_type: 'appointment',
          trigger_entity_id: Number(appointment.id_cita) }, transaction: current })) fail('grouping_communication_history_requires_review');
      }
      const parentMember = existingMembers.find(m => Number(m.appointment_id) === parentAppointmentId);
      const id = parentMember?.visit_id || newId();
      const values = appointments.map(a => memberValues(a, id, Number(a.id_cita) === parentAppointmentId ? 'primary' : 'prp_extraction', evidence));
      let visit = visits.get(id);
      const identity = identityValues({ id, appointments, members: values, ownerId: parentAppointmentId, kind: 'validated_prp', evidence, actorId });
      if (!visit) visit = await db.AppointmentVisit.create(identity, options(current));
      else await visit.update({ grouping_kind: identity.grouping_kind, grouping_evidence: evidence, snapshot: identity.snapshot,
        membership_sha256: identity.membership_sha256, snapshot_sha256: identity.snapshot_sha256,
        communication_revision: Number(visit.communication_revision) + 1, updated_by: actorId }, options(current));
      for (const value of values) {
        const member = existingMembers.find(m => Number(m.appointment_id) === value.appointment_id);
        if (member) await member.update(value, options(current));
        else await db.AppointmentVisitMember.create(value, options(current));
      }
      for (const old of visits.values()) if (old.id !== id) {
        await old.update({ status: 'merged', merged_into_visit_id: id, updated_by: actorId }, options(current));
      }
      return { created: true, visit, relation: evidence };
    });
  }

  async function refreshVisitSnapshot({ visitId, clinicId, expectedRevision, actorId = null, transaction: tx = null }) {
    scope(clinicId, actorId);
    return transaction(tx, async current => {
      const context = await lockedVisit(visitId, clinicId, current), { visit, projection } = context;
      if (!positiveId(expectedRevision) || Number(visit.communication_revision) !== expectedRevision) fail('revision_changed');
      if (visit.status !== 'active' || visit.merged_into_visit_id) fail('visit_not_active');
      const changed = visit.snapshot_sha256 !== projection.snapshot_sha256 || visit.membership_sha256 !== projection.membership_sha256;
      if (v.hash(visit.snapshot) !== visit.snapshot_sha256) fail('snapshot_corrupt');
      if (changed) await visit.update({ ...projection, communication_revision: expectedRevision + 1, updated_by: actorId }, options(current));
      return { changed, visit };
    });
  }

  async function claimCommunication({ visitId, clinicId, purpose, expectedRevision, window, templateVersionId = null,
    actorId = null, transaction: tx = null, runtimeStagePlan = null }) {
    scope(clinicId, actorId); v.purposePolicy(purpose);
    if (templateVersionId != null && !positiveId(templateVersionId)) fail('invalid_template', 400);
    const normalized = v.normalizeWindow(window);
    return transaction(tx, async current => {
      const context = await lockedVisit(visitId, clinicId, current), { visit, projection, appointments } = context;
      v.assertCurrentProjection({ visit, projection, expectedRevision });
      const managed = visit.runtime_enrollment ? runtimeContract.stagePlan(runtimeStagePlan, visit, purpose, window) : null;
      if (managed && managed.stored.template_version_id !== templateVersionId || !managed && runtimeStagePlan) fail('runtime_stage_binding_required');
      await assertEligibility(context, purpose, current, { templateVersionId, window: normalized }); v.assertWindow(normalized, now());
      const where = { visit_id: visitId, purpose, communication_revision: expectedRevision, window_sha256: normalized.sha256 };
      const existing = await db.AppointmentVisitCommunication.findOne({ where, transaction: current, lock: current.LOCK.UPDATE });
      if (existing) {
        if (v.instant(existing.window_starts_at) !== normalized.starts_at || v.instant(existing.window_ends_at) !== normalized.ends_at) fail('window_definition_changed');
        if (existing.snapshot_sha256 !== projection.snapshot_sha256 || existing.membership_sha256 !== projection.membership_sha256) fail('communication_snapshot_changed');
        if (managed && (!existing.runtime_stage || v.hash(existing.runtime_stage) !== existing.runtime_stage_sha256
          || existing.runtime_stage.stage_key !== managed.stored.stage_key)) fail('runtime_stage_binding_required');
        return { created: false, communication: existing, delivery_key: v.deliveryKey(existing) };
      }
      const communication = await db.AppointmentVisitCommunication.create({ id: newId(), ...where,
        clinic_id: clinicId, patient_id: Number(visit.patient_id), owner_appointment_id: Number(visit.owner_appointment_id),
        window_key: normalized.key, window_starts_at: normalized.starts_at, window_ends_at: normalized.ends_at,
        ...projection, ...(managed ? { runtime_stage: managed.stored, runtime_stage_sha256: v.hash(managed.stored) } : {}),
        status: 'pending', template_version_id: templateVersionId, created_by: actorId, created_at: now() }, options(current));
      return { created: true, communication, delivery_key: v.deliveryKey(communication) };
    });
  }

  async function lockedCommunication(communicationId, clinicId, tx, validate = true, execution = null) {
    if (!uuid(communicationId)) fail('invalid_communication', 400);
    const initial = await db.AppointmentVisitCommunication.findByPk(communicationId, { transaction: tx });
    if (!initial || Number(initial.clinic_id) !== clinicId) fail('communication_not_found', 404);
    // Reconciliation/cancellation must remain possible for a stale, held or
    // broken clinical relation; do not lose accepted/unknown historical rights.
    const context = validate ? await lockedVisit(initial.visit_id, clinicId, tx) : null;
    const communication = await db.AppointmentVisitCommunication.findByPk(communicationId, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (!communication || communication.visit_id !== initial.visit_id || Number(communication.clinic_id) !== clinicId) fail('communication_scope_changed');
    if (validate) {
      v.assertCurrentProjection({ visit: context.visit, projection: context.projection, expectedRevision: Number(communication.communication_revision) });
      if (Number(communication.patient_id) !== Number(context.visit.patient_id)
        || Number(communication.owner_appointment_id) !== Number(context.visit.owner_appointment_id)
        || communication.membership_sha256 !== context.projection.membership_sha256
        || communication.snapshot_sha256 !== context.projection.snapshot_sha256 || v.hash(communication.snapshot) !== communication.snapshot_sha256) fail('communication_scope_changed');
      const normalized = v.normalizeWindow({ key: communication.window_key, starts_at: communication.window_starts_at, ends_at: communication.window_ends_at });
      if (normalized.sha256 !== communication.window_sha256) fail('window_definition_changed');
      await assertEligibility(context, communication.purpose, tx, { communication, execution,
        templateVersionId: communication.template_version_id, window: normalized });
      v.assertWindow(normalized, now(), true);
    }
    return { ...context, communication };
  }
  async function boundMessage(communication, tx) {
    if (!communication.message_id) return null;
    if (!db.Message || !db.Conversation) fail('message_guard_unavailable');
    // Never acquire existing runtime locks in a new inverse order. This API
    // does not replace final family/execution/message/transport authorization.
    const message = await db.Message.findByPk(communication.message_id, { transaction: tx });
    const conversation = message && await db.Conversation.findByPk(message.conversation_id, { transaction: tx });
    const metadata = v.object(message?.metadata);
    if (!message || message.direction !== 'outbound' || !conversation || Number(conversation.clinic_id) !== Number(communication.clinic_id)
      || Number(conversation.patient_id) !== Number(communication.patient_id) || v.qa(message) || v.qa(conversation)
      || message.automation_delivery_key !== v.deliveryKey(communication)
      || Number(metadata.execution_id) !== Number(communication.execution_id)
      || communication.runtime_stage && metadata.visit_communication_id !== communication.id
      || communication.runtime_stage && !communication.runtime_stage.node_ids?.includes(metadata.node_id)
      || metadata.recipient_patient_id != null && Number(metadata.recipient_patient_id) !== Number(communication.patient_id)
      || metadata.clinic_id != null && Number(metadata.clinic_id) !== Number(communication.clinic_id)) fail('message_scope_changed');
    return message;
  }
  async function reconcileRow(communication, tx) {
    const message = await boundMessage(communication, tx), outcome = v.messageOutcome(message);
    const status = communication.status;
    if (status === 'accepted') return communication;
    if (outcome === 'accepted') await communication.update({ status: 'accepted', accepted_at: communication.accepted_at || now() }, options(tx));
    else if (outcome === 'unknown' && status !== 'unknown') await communication.update({ status: 'unknown', unknown_at: communication.unknown_at || now() }, options(tx));
    else if (status !== 'unknown' && status !== 'cancelled' && outcome === 'failed') await communication.update({ status: 'failed' }, options(tx));
    return communication;
  }

  async function assertCommunicationCurrent({ communicationId, clinicId, transaction: tx = null }) {
    scope(clinicId);
    return transaction(tx, async current => {
      const context = await lockedCommunication(communicationId, clinicId, current);
      const communication = context.communication, outcome = v.messageOutcome(await boundMessage(communication, current));
      if (!['pending', 'dispatching', 'failed'].includes(communication.status) || ['accepted', 'unknown'].includes(outcome)) fail('communication_not_dispatchable');
      return { ...context, communication, delivery_key: v.deliveryKey(communication),
        owner_appointment_id: Number(communication.owner_appointment_id) };
    });
  }
  // Projection/policy inspection, NOT a delivery right. The real dispatch lease
  // service additionally owns and checks Message/status/attempt under its locks.
  async function inspectCommunicationCurrent({ communicationId, clinicId, transaction: tx = null }) {
    scope(clinicId);
    return transaction(tx, async current => {
      const context = await lockedCommunication(communicationId, clinicId, current);
      return { ...context, message: await boundMessage(context.communication, current) };
    });
  }
  async function bindCommunication({ communicationId, clinicId, executionId, messageId, transaction: tx = null }) {
    scope(clinicId);
    if (!positiveId(executionId) || !positiveId(messageId)) fail('invalid_binding', 400);
    return transaction(tx, async current => {
      if (!db.FlowExecutionV2 || !db.Message || !db.Conversation) fail('binding_guard_unavailable');
      const execution = await db.FlowExecutionV2.findByPk(executionId, { transaction: current });
      const { communication } = await lockedCommunication(communicationId, clinicId, current, true, execution);
      if (communication.execution_id && Number(communication.execution_id) !== executionId
        || communication.message_id && Number(communication.message_id) !== messageId) fail('binding_exists');
      if (!execution || Number(execution.clinic_id) !== clinicId || execution.trigger_entity_type !== 'appointment'
        || Number(execution.trigger_entity_id) !== Number(communication.owner_appointment_id)
        || communication.template_version_id != null && Number(execution.template_version_id) !== Number(communication.template_version_id)
        || v.qa(v.object(execution.context)) || !['running', 'waiting'].includes(execution.status)) fail('execution_scope_changed');
      const otherBinding = await db.AppointmentVisitCommunication.findOne({ where: { message_id: messageId }, transaction: current });
      if (otherBinding && otherBinding.id !== communication.id) fail('message_already_bound');
      const candidate = { ...plain(communication), execution_id: executionId, message_id: messageId };
      await boundMessage(candidate, current);
      // No retry/reassignment of an accepted or unknown delivery to a new row.
      await reconcileRow(communication, current);
      if (!['pending', 'failed', 'dispatching'].includes(communication.status)) fail('communication_not_dispatchable');
      if (!communication.execution_id || !communication.message_id) await communication.update({ execution_id: executionId, message_id: messageId }, options(current));
      await reconcileRow(communication, current);
      return { communication, delivery_key: v.deliveryKey(communication) };
    });
  }
  async function bindExecution({ communicationId, clinicId, executionId, transaction: tx = null }) {
    scope(clinicId);
    if (!positiveId(executionId)) fail('invalid_binding', 400);
    return transaction(tx, async current => {
      const execution = await db.FlowExecutionV2.findByPk(executionId, { transaction: current });
      const context = await lockedCommunication(communicationId, clinicId, current, true, execution), row = context.communication;
      if (!context.visit.runtime_enrollment || !execution || !['running','waiting'].includes(execution.status)
        || row.execution_id && Number(row.execution_id) !== executionId || !['pending','failed','dispatching'].includes(row.status)) fail('execution_scope_changed');
      if (!row.execution_id) await row.update({ execution_id: executionId }, options(current));
      return row;
    });
  }
  async function reconcileDelivery({ communicationId, clinicId, transaction: tx = null }) {
    scope(clinicId);
    return transaction(tx, async current => {
      const { communication } = await lockedCommunication(communicationId, clinicId, current, false);
      return reconcileRow(communication, current);
    });
  }
  async function cancelCommunication({ communicationId, clinicId, reason, transaction: tx = null }) {
    scope(clinicId);
    if (typeof reason !== 'string' || !/^[a-z][a-z0-9_:-]{0,119}$/.test(reason)) fail('invalid_cancellation_reason', 400);
    return transaction(tx, async current => {
      const { communication } = await lockedCommunication(communicationId, clinicId, current, false);
      await reconcileRow(communication, current);
      if (['accepted', 'unknown', 'cancelled'].includes(communication.status)) return { cancelled: false, communication };
      await communication.update({ status: 'cancelled', cancelled_at: now(), cancellation_reason: reason }, options(current));
      return { cancelled: true, communication };
    });
  }
  return Object.freeze({ ensureSingletonVisit, linkValidatedPrpVisit, refreshVisitSnapshot, claimCommunication,
    assertCommunicationCurrent, inspectCommunicationCurrent, bindExecution, bindCommunication, reconcileDelivery, cancelCommunication });
}

module.exports = { createAppointmentVisitCommunicationService };
