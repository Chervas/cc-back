'use strict';

const crypto = require('node:crypto');
const replay = require('../lib/voucher-booking-replay');
const L = require('../lib/economic-concept-ledger');
const SOURCE = 'budget_concept_booking_v1';

/** Native series planning with a real accepted budget-line origin. */
function createService({ db = require('../../models'), coordinator = require('./patientVoucherAppointments.service').seriesCoordinator,
  concepts = require('./economicConcepts.service').createService({ db }),
  canAccess = input => require('../lib/access-policy').canUserAccessFeature(input),
  replayEnabled = () => replay.enabled(), automation = require('./appointmentAutomationV2Runtime.service') } = {}) {
  const eventType = (stage, key) => `budget.concept.${stage}.${replay.key(key)}`;
  async function identity(input, transaction, lock = false, reading = false) {
    if (!Number.isSafeInteger(Number(input.actorId)) || Number(input.actorId) < 1) L.fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    let budget = await db.EconomicBudget.findOne({ where: { public_id: input.publicId }, transaction });
    if (!budget) L.fail('budget_not_found', 'Presupuesto no encontrado.', 404);
    for (const featureKey of ['patients.view', reading ? 'appointments.view' : 'appointments.manage']) {
      if (!await canAccess({ actorId: Number(input.actorId), clinicId: Number(budget.clinic_id), featureKey })) L.fail('access_policy_forbidden', 'No tienes permiso para planificar las citas de este presupuesto.', 403);
    }
    const patient = await db.Paciente.findByPk(budget.patient_id, { transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient || Number(patient.clinica_id) !== Number(budget.clinic_id) && !(db.PacienteClinica && await db.PacienteClinica.findOne({ where: { paciente_id: budget.patient_id, clinica_id: budget.clinic_id }, transaction }))) L.fail('patient_not_found', 'Paciente no encontrado en esta clínica.', 404);
    if (lock) budget = await db.EconomicBudget.findByPk(budget.id, { transaction, lock: transaction.LOCK.UPDATE });
    return budget;
  }
  async function source(input, transaction, lock = false) {
    const result = await concepts.bookingSource({ ...input, transaction, lock, expectedVersion: input.payload?.expected_version });
    if (result.line.program_id || result.progress.fulfillment_voucher_id || !Number.isSafeInteger(Number(result.line.treatment_id)) || Number(result.line.treatment_id) < 1) L.fail('budget_concept_planner_mismatch', 'Utiliza el planificador de este bono o programa.', 409);
    if (!Number.isSafeInteger(result.progress.contracted) || !Number.isSafeInteger(result.progress.pending) || !Number.isSafeInteger(result.progress.reserved)) L.fail('budget_concept_sessions_review', 'El número de sesiones de este concepto requiere revisión antes de agendar.', 409);
    return { ...result, record: { clinic_id: result.budget.clinic_id, patient_id: result.budget.patient_id,
      treatment_id: result.line.treatment_id, name: result.line.name },
      budgetConcept: { budget_id: result.budget.public_id, line_key: result.line.key, version: Number(result.budget.current_version) },
      reservedUnits: result.progress.reserved, availableToSchedule: result.progress.pending };
  }
  function assertVersion(input) {
    if (!Number.isSafeInteger(input.payload?.expected_version) || input.payload.expected_version < 1) L.fail('budget_version_required', 'Actualiza el presupuesto antes de preparar sus citas.', 428);
  }
  function intent(plan, origin, actorId) {
    if (plan.has_conflicts) L.fail('budget_schedule_conflicts', 'Hay conflictos en la serie. Revisa los huecos antes de reservar.');
    return { version: 1, actor_id: Number(actorId), budget_concept: plan.budget_concept,
      concept_revision: Number(origin.progress.concept_revision), clinic_id: Number(origin.record.clinic_id), patient_id: Number(origin.record.patient_id), treatment_id: Number(origin.record.treatment_id),
      configuration: plan.configuration, treatment_name: plan.treatment?.nombre || origin.record.name,
      template: plan.physicalTemplate || null, profile: plan.bookingProfile || null,
      duration_selection: plan.durationSelection || null, selections: replay.selectionsForPlan(plan),
      slots: plan.appointments.map(slot => ({ sequence: slot.sequence, start_at: slot.start_at, end_at: slot.end_at,
        ...(slot.phases ? { phases: slot.phases, warnings: slot.warnings || [], booking_plan_sha256: slot.booking_plan_sha256,
          requires_priority_acknowledgement: slot.requires_priority_acknowledgement === true } : {}) })) };
  }
  async function append(budget, stage, metadata, transaction, actorId) {
    await db.PatientOperationalEvent.create({ patient_id: budget.patient_id, clinic_id: budget.clinic_id, actor_user_id: actorId,
      source: SOURCE, channel: 'internal', event_type: eventType(stage, metadata.request_key), metadata, occurred_at: new Date() }, { transaction });
  }
  async function read(budget, lineKey, stage, requestKey, transaction) {
    const rows = await db.PatientOperationalEvent.findAll({ where: { patient_id: budget.patient_id, clinic_id: budget.clinic_id,
      source: SOURCE, event_type: eventType(stage, requestKey) }, order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 2, transaction });
    if (!rows.length) return null;
    const row = rows[0], saved = L.parse(row.metadata), origin = saved.budget_concept;
    if (rows.length !== 1 || saved.version !== 1 || saved.request_key !== requestKey || !origin || origin.budget_id !== budget.public_id || origin.line_key !== lineKey
      || !Number.isSafeInteger(saved.actor_id) || saved.actor_id < 1 || Number(row.actor_user_id) !== saved.actor_id
      || Number(row.patient_id) !== Number(budget.patient_id) || Number(row.clinic_id) !== Number(budget.clinic_id)
      || row.source !== SOURCE || row.event_type !== eventType(stage, requestKey)) L.fail('budget_booking_receipt_invalid', 'No se puede verificar la referencia de esta reserva. No se creará otra cita.');
    replay.sha(saved.request_sha256);
    if (stage === 'prepared' && (replay.hash(saved.intent) !== saved.request_sha256 || replay.hash(saved.intent.budget_concept) !== replay.hash(origin)
      || saved.intent.actor_id !== saved.actor_id || saved.intent.clinic_id !== Number(budget.clinic_id) || saved.intent.patient_id !== Number(budget.patient_id))) L.fail('budget_booking_receipt_invalid', 'La propuesta guardada no corresponde a este concepto.');
    return saved;
  }
  function assertReplayRuntime() {
    coordinator.assertReplayRuntime();
    if (!db.PatientOperationalEvent) L.fail('budget_booking_replay_unavailable', 'No se puede verificar la reserva. No se creará otra cita.', 503);
  }
  async function resources(input) {
    const budget = await identity(input, null, false, true);
    await source(input, null);
    return coordinator.resourcesForClinic(budget.clinic_id);
  }
  async function preview(input) {
    assertVersion(input);
    const durable = replayEnabled();
    if (durable) assertReplayRuntime();
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      await identity(input, transaction, true);
      const origin = await source(input, transaction, true);
      const plan = await coordinator.buildPlan({ payload: input.payload, transaction, planningSource: origin, sealPlan: durable });
      const result = coordinator.serializePlan(plan);
      if (!durable || plan.has_conflicts) return { ...result, booking_replay_supported: durable };
      const preparedIntent = intent(plan, origin, input.actorId), metadata = { version: 1, actor_id: Number(input.actorId),
        budget_concept: plan.budget_concept, request_key: crypto.randomUUID(), request_sha256: replay.hash(preparedIntent), intent: preparedIntent };
      await append(origin.budget, 'prepared', metadata, transaction, Number(input.actorId));
      return { ...result, booking_replay_supported: true, booking_request_key: metadata.request_key, booking_request_sha256: metadata.request_sha256 };
    });
  }
  async function create(input) {
    assertVersion(input);
    const durable = replayEnabled(), payload = input.payload || {}, actorId = Number(input.actorId);
    if (!durable && (Object.hasOwn(payload, 'booking_request_key') || Object.hasOwn(payload, 'booking_request_sha256'))) L.fail('budget_booking_replay_disabled', 'La recuperación de esta reserva no está habilitada. Revisa el resultado antes de reservar otra vez.');
    let requestKey, requestHash;
    if (durable) { assertReplayRuntime(); requestKey = replay.key(payload.booking_request_key); requestHash = replay.sha(payload.booking_request_sha256); }
    const outcome = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const budget = await identity(input, transaction, true);
      let prepared;
      if (durable) {
        prepared = await read(budget, input.lineKey, 'prepared', requestKey, transaction);
        if (!prepared) L.fail('budget_booking_request_not_found', 'Comprueba los huecos para preparar esta reserva.');
        if (prepared.actor_id !== actorId) L.fail('budget_booking_request_forbidden', 'Esta propuesta pertenece a otra sesión de trabajo.', 403);
        if (prepared.request_sha256 !== requestHash || prepared.budget_concept.version !== payload.expected_version) L.fail('budget_booking_request_conflict', 'La propuesta ha cambiado. Comprueba los huecos otra vez.');
        replay.validatePayload(prepared.intent, payload, coordinator.normalizedSelections);
        const committed = await read(budget, input.lineKey, 'committed', requestKey, transaction);
        if (committed) return { appointments: [], receipt: replay.receiptFromMetadata(committed, prepared), replayed: true };
      }
      const origin = await source(input, transaction, true), plan = await coordinator.buildPlan({ planningSource: origin, transaction, sealPlan: durable,
        payload: durable ? replay.payloadForIntent(prepared.intent, payload) : payload });
      if (durable && replay.hash(intent(plan, origin, actorId)) !== requestHash) L.fail('budget_booking_plan_changed', 'Los huecos, el concepto o el tratamiento han cambiado. Comprueba la propuesta otra vez.');
      const appointments = await coordinator.persistPlan({ plan, actorId, payload, transaction, durable, prepared,
        birthRequestKey: sequence => {
          const bytes = crypto.createHash('sha256').update(`${SOURCE}:${requestKey}:${sequence}`).digest().subarray(0, 16);
          bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
          const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        } });
      await concepts.recordBooked({ ...input, expectedVersion: input.payload.expected_version, transaction, appointments });
      const receipt = replay.receiptForAppointments(appointments);
      if (durable) await append(budget, 'committed', { version: 1, actor_id: actorId, budget_concept: plan.budget_concept,
        request_key: requestKey, request_sha256: requestHash, receipt, receipt_sha256: replay.hash(receipt) }, transaction, actorId);
      return { appointments, receipt, replayed: false };
    });
    for (const appointment of outcome.appointments) {
      try {
        await automation.enqueueExecutionForCita(appointment, { event_name: 'appointment_created', user_id: actorId, user_role: 'admin' });
        await automation.syncScheduledTriggersForCita(appointment, { user_id: actorId, user_role: 'admin' });
      } catch (error) { console.error('[budget-concept-schedule] No se pudo activar la automatización:', error.code || 'unavailable'); }
    }
    return { ...outcome.receipt, replayed: outcome.replayed,
      ...(durable ? { booking_request_key: requestKey, booking_request_sha256: requestHash } : {}) };
  }
  return { resources, preview, create };
}
let singleton;
const current = () => singleton ||= createService();
module.exports = { createService, resources: input => current().resources(input), preview: input => current().preview(input), create: input => current().create(input) };
