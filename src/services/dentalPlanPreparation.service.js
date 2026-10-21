'use strict';

const C = require('../lib/clinical-episode-contract');
const D = require('../lib/dental-plan-contract');
const dependencies = require('../lib/dental-dependencies');
const { careState } = require('../lib/appointment-care');
const { resolveClinicTimezone } = require('../lib/availability-calendar');

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const plain = value => value?.toJSON ? value.toJSON() : value;

/** A projection of existing evidence. Never starts care or prepares documents. */
function createDentalPlanPreparationService({ db, core,
  now = () => new Date(),
  assessConsent = require('./appointmentConsentEligibility.service').assessAppointmentClinicalConsent,
  assessPrivacy = require('./appointmentPrivacyEligibility.service').assessPrivacyBeforeStart,
  registrationDocuments = require('./appointmentRegistrationDocuments.service').registrationDocuments,
  assertProtocolConsents = require('./dentalProtocolEvidence.service').assertProtocolConsents,
} = {}) {
  const plans = core || require('./dentalPlans.service').createDentalPlanService({ db });

  async function read(options) {
    const caps = await plans.authorize(options);
    if (options.query?.version !== undefined) D.fail('preparation_current_only', 'La preparación consulta el estado actual de la reserva. Las referencias históricas conservan sus propias versiones.');
    const sessionId = D.id(options.query?.session_id);
    const appointmentId = options.query?.appointment_id === undefined ? null : C.integer(options.query.appointment_id);

    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const selected = await plans.scopedPlan({ ...options, transaction });
      // Same patient→plan ordering as mutations; shared locks keep the evidence
      // projection coherent without changing, creating or revising any row.
      await db.Paciente.findByPk(selected.patient_id, { attributes: ['id_paciente'], transaction, lock: transaction.LOCK.SHARE });
      const row = await db.DentalPlan.findOne({ where: { id: selected.id, public_id: selected.public_id, clinic_id: selected.clinic_id, patient_id: selected.patient_id }, transaction, lock: transaction.LOCK.SHARE });
      if (!row) D.fail('plan_not_found', 'Plan dental no encontrado.', 404);
      const state = parse(row.state);
      const session = state.sessions.find(item => item.id === sessionId && item.status !== 'absorbed');
      if (!session) D.fail('session_not_found', 'Selecciona una sesión activa de este plan.', 404);
      let appointment = null;
      const reservation = appointmentId === null ? null : state.reservations.find(item => Number(item.appointment_id) === appointmentId && item.session_id === sessionId);
      if (appointmentId !== null) {
        if (!reservation) D.fail('reservation_scope_invalid', 'La reserva no pertenece a esta sesión.', 404);
        appointment = await db.CitaPaciente.findOne({ where: { id_cita: appointmentId, clinica_id: row.clinic_id, paciente_id: row.patient_id }, transaction });
        if (!appointment) D.fail('appointment_not_found', 'La reserva no está disponible en este paciente y clínica.', 404);
      }
      const actIds = reservation ? reservation.act_ids : session.act_ids;
      const acts = actIds.map(id => state.acts.find(act => act.id === id && act.status !== 'cancelled')).filter(Boolean);
      if (!acts.length || acts.length !== actIds.length || acts.length > 100) D.fail('preparation_scope_invalid', 'Selecciona trabajo activo de una reserva o una sesión de hasta 100 actos.', 409);
      const clinic = await db.Clinica.findByPk(row.clinic_id, { transaction });
      const timeZone = resolveClinicTimezone(clinic), at = now();
      const issues = [], unknown = new Set();
      const add = (code, label, responsible_role, kind, ids = actIds, id, severity = 'blocking', category = kind) => {
        issues.push({ code, label, responsible_role, severity, act_ids: [...ids], action: { kind, ...(id ? { id: String(id) } : {}) }, category });
      };
      const unavailable = (code, label, kind, ids = actIds) => {
        unknown.add(code); add(code, label, 'clinical', kind, ids, undefined, 'unknown');
      };
      const checks = { review: 'ready', dependencies: 'ready', evidence: 'ready', laboratory: 'ready', documents: 'ready', care: 'ready' };

      if (!['reviewed', 'booked', 'done'].includes(session.status)) add('session_review_required', 'Falta la revisión clínica de la sesión.', 'clinical', 'review_session', actIds, sessionId);
      if ((state.protocol_warnings || []).some(rule => !(session.protocol_acknowledgements || []).includes(rule.code))) add('protocol_review_required', 'Hay reglas clínicas que necesitan revisión del profesional.', 'clinical', 'review_session', actIds, sessionId);

      try {
        const pending = dependencies.dependencyIssues(state, { actIds, startAt: at, timeZone, execution: true });
        for (const issue of pending) add('dependency_' + issue.reason,
          issue.reason === 'clinical_wait' ? 'Todavía no se cumple una espera clínica.' : 'Falta completar un acto previo del tratamiento.',
          'clinical', 'dependencies', [issue.to_act_id], issue.id, issue.action === 'warn' ? 'warning' : 'blocking');
      } catch { unavailable('dependencies_unavailable', 'No se han podido comprobar las dependencias clínicas.', 'dependencies'); }

      let tools = null, toolsKnown = false;
      try {
        tools = await plans.readTools(row, transaction); toolsKnown = true;
        const orders = (tools?.lab_orders || []).filter(order => order.needed_session_id ? order.needed_session_id === sessionId : (order.act_ids || []).some(id => actIds.includes(id)));
        const evidence = (tools?.evidences || []).filter(item => item.required === true && ((item.session_ids || []).includes(sessionId) || (item.act_ids || []).some(id => actIds.includes(id))));
        for (const order of orders.filter(order => order.status !== 'approved')) {
          const clinical = ['received', 'rejected'].includes(order.status);
          const label = order.status === 'received' ? 'Pedido recibido, pendiente de conformidad clínica.' : order.status === 'rejected' ? 'El pedido necesita corrección y una nueva revisión.' : order.status === 'requested' ? 'Falta recibir el pedido de laboratorio.' : 'Falta registrar la solicitud del pedido de laboratorio.';
          add('laboratory_' + order.status, label, clinical ? 'clinical' : 'logistics', 'laboratory', order.needed_session_id === sessionId ? actIds : (order.act_ids || []).filter(id => actIds.includes(id)), order.id);
        }
        for (const item of evidence.filter(item => item.clinical_status !== 'approved' || item.status === 'archived')) add('evidence_review_required', 'Falta una prueba requerida vigente y validada clínicamente.', 'clinical', 'evidence', (item.session_ids || []).includes(sessionId) ? actIds : (item.act_ids || []).filter(id => actIds.includes(id)), item.id);
        // Inspect every protocol requirement independently: the execution guard
        // intentionally stops at its first blocker, whereas this summary must
        // also show an absent RX when laboratory is already known to be pending.
        const protocolTools = { ...tools,
          lab_orders: (tools?.lab_orders || []).filter(order => order.status === 'approved'),
          evidences: (tools?.evidences || []).map(item => ({ ...item, required: false })),
        };
        for (const act of acts) {
          for (const requirement of (state.protocol_requirements || []).filter(item => item.act_ids.includes(act.id))) {
            try { dependencies.assertToolsReady(protocolTools, sessionId, [act.id], [requirement]); }
            catch (error) {
              if (error.code === 'dental_laboratory_required') {
                if (!issues.some(issue => issue.action.kind === 'laboratory' && issue.act_ids.includes(act.id))) add('laboratory_required', 'El protocolo necesita un pedido validado para este acto.', 'logistics', 'laboratory', [act.id]);
              } else if (error.code === 'dental_evidence_required') {
                if (!issues.some(issue => issue.action.kind === 'evidence' && issue.act_ids.includes(act.id))) add('evidence_required', 'El protocolo necesita una prueba aportada y validada para este acto.', 'clinical', 'evidence', [act.id]);
              } else unavailable('materials_unavailable', 'No se han podido comprobar todos los materiales de este acto.', 'evidence', [act.id]);
            }
          }
        }
      } catch { unavailable('materials_unavailable', 'No se han podido comprobar las pruebas y el laboratorio.', 'evidence'); checks.laboratory = 'unknown'; }

      const assess = async (code, label, evaluator, isAllowed, responsible = 'clinical', ids = actIds) => {
        try {
          const result = await evaluator();
          if (!isAllowed(result)) add(code, label, responsible, 'documentation', ids, appointmentId || undefined, 'blocking', 'documents');
        } catch (error) {
          if (error.code === 'dental_consent_required') { add(code, label, 'clinical', 'documentation', ids, appointmentId || undefined, 'blocking', 'documents'); return; }
          // Configuration/validity failures are unresolved evidence, never green.
          unavailable(code + '_unavailable', 'Hay documentación clínica pendiente de verificar.', 'documentation', ids);
          checks.documents = 'unknown';
        }
      };

      if (appointment) {
        const options = { db, appointment, transaction, now: at };
        await assess('clinical_consent_required', 'Faltan consentimientos clínicos con firma vigente.', () => assessConsent(options), result => result?.allowed === true);
        await assess('privacy_required', 'Falta comprobar la protección de datos previa al inicio.', () => assessPrivacy(options), result => result?.allowed === true, 'administration');
        await assess('registration_documents_required', 'Faltan documentos de alta obligatorios.', () => registrationDocuments({ ...options, requiredOnly: true }), result => result && (!result.required_before_first_care || result.items.every(item => !item.required || ['signed', 'completed'].includes(item.state))), 'administration');
        const care = careState(plain(appointment), at, { timeZone });
        if (['cancelada', 'no_asistio'].includes(appointment.estado)) add('appointment_inactive', 'La reserva está cancelada o el paciente no ha acudido.', 'logistics', 'care', actIds, appointmentId);
        else if (care.legacy_attendance) add('care_legacy_attendance', 'La asistencia histórica no acredita inicio clínico de esta reserva.', 'clinical', 'care', actIds, appointmentId);
        else if (!care.started_at) add(care.arrived_at ? 'care_start_required' : 'care_arrival_required', care.arrived_at ? 'El profesional debe iniciar la atención de la reserva.' : 'Recepción debe registrar la llegada del paciente.', care.arrived_at ? 'clinical' : 'logistics', 'care', actIds, appointmentId);
      } else {
        unavailable('appointment_start_not_evaluated', session.appointment_ids.length ? 'Selecciona una reserva para comprobar su documentación y atención.' : 'Sin reserva: la documentación de inicio y la atención no se han evaluado.', 'care');
        checks.documents = 'unknown';
        for (const act of acts) await assess('clinical_consent_required', 'Faltan consentimientos clínicos con firma vigente para este acto.', () => assessConsent({ db, transaction, now: at, appointment: { id_cita: null, clinica_id: row.clinic_id, paciente_id: row.patient_id, tratamiento_id: act.treatment_id, import_metadata: null } }), result => result?.allowed === true, 'clinical', [act.id]);
      }
      await assess('protocol_document_required', 'El protocolo necesita documentación clínica válida para los actos seleccionados.', () => assertProtocolConsents({ db, row, state, actIds, transaction, appointmentId, startAt: appointment?.inicio, now: at }).then(() => true), result => result === true);

      for (const issue of issues) {
        const category = issue.category === 'review_session' ? 'review' : issue.category === 'documentation' ? 'documents' : issue.category;
        if (category in checks && issue.severity !== 'warning') checks[category] = issue.severity === 'blocking' ? 'pending' : checks[category] === 'pending' ? 'pending' : 'unknown';
      }
      const unique = [...new Map(issues.map(issue => [JSON.stringify([issue.code, issue.action, issue.act_ids]), issue])).values()];
      return { plan_id: row.public_id, plan_version: Number(row.version_number), clinic_id: Number(row.clinic_id), patient_id: Number(row.patient_id), session_id: sessionId, appointment_id: appointmentId, tools_version: toolsKnown ? tools?.version || 0 : null, act_ids: [...actIds],
        status: unique.some(issue => issue.severity === 'blocking') ? 'pending' : unknown.size ? 'unknown' : 'ready', checked_at: at.toISOString(),
        coverage: { complete: unknown.size === 0, unknown_codes: [...unknown] }, checks,
        issues: unique.map(({ category, ...issue }) => issue), capabilities: { clinical_view: !!caps.clinical_view, clinical_manage: !!caps.clinical_manage, logistics_manage: !!caps.logistics_manage } };
    });
  }
  return { read };
}

const read = input => createDentalPlanPreparationService({ db: require('../../models') }).read(input);
module.exports = { createDentalPlanPreparationService, read };
