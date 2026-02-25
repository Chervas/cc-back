'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');

const Tratamiento = db.Tratamiento;
const Clinica = db.Clinica;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const { getIO } = require('./socket.service');

const APPOINTMENT_TRIGGER_TYPES = new Set([
  'appointment_created',
  'appointment_confirmed',
  'appointment_no_show',
  'appointment_rescheduled',
]);

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeEventName(eventName) {
  const normalized = cleanString(eventName).toLowerCase();
  return APPOINTMENT_TRIGGER_TYPES.has(normalized) ? normalized : null;
}

function mapEstadoToEvent(estado) {
  const normalized = cleanString(estado).toLowerCase();
  if (normalized === 'confirmada') return 'appointment_confirmed';
  if (normalized === 'reprogramada') return 'appointment_rescheduled';
  if (normalized === 'no_asistio') return 'appointment_no_show';
  return null;
}

function buildIdempotencyKey({ triggerType, citaId, templateVersionId, windowIdentifier }) {
  const parts = [
    cleanString(triggerType) || 'appointment_created',
    cleanString(citaId) || '0',
    cleanString(templateVersionId) || '0',
  ];
  const windowId = cleanString(windowIdentifier);
  if (windowId) parts.push(windowId);
  return parts.join(':');
}

function pickPreferredExecution(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const active = rows.find((row) => ['running', 'waiting', 'paused'].includes(cleanString(row.status)));
  return active || rows[0];
}

async function resolveTemplateForCitaEvent(cita, eventName) {
  const tratamientoId = toIntOrNull(cita?.tratamiento_id);
  if (!tratamientoId) return null;

  const tratamiento = await Tratamiento.findByPk(tratamientoId, {
    attributes: [
      'id_tratamiento',
      'appointment_automation_template_key',
      'appointment_automation_template_version',
    ],
  });
  if (!tratamiento) return null;

  const templateKey = cleanString(tratamiento.appointment_automation_template_key);
  const templateVersion = toIntOrNull(tratamiento.appointment_automation_template_version);
  if (!templateKey) return null;

  const where = {
    template_key: templateKey,
    published_at: { [db.Sequelize.Op.ne]: null },
    is_active: true,
    trigger_type: eventName,
  };
  if (templateVersion) where.version = templateVersion;

  return AutomationFlowTemplateV2.findOne({
    where,
    order: [['version', 'DESC']],
  });
}

async function resolveClinicScope(cita) {
  const clinicId = toIntOrNull(cita?.clinica_id);
  if (!clinicId) {
    return { clinic_id: null, group_id: null };
  }

  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
  });

  return {
    clinic_id: clinicId,
    group_id: toIntOrNull(clinic?.grupoClinicaId),
  };
}

function buildExecutionContext({ cita, eventName }) {
  return {
    trigger: {
      type: eventName,
      data: {
        cita_id: toIntOrNull(cita?.id_cita),
        appointment_id: toIntOrNull(cita?.id_cita),
        clinica_id: toIntOrNull(cita?.clinica_id),
        clinic_id: toIntOrNull(cita?.clinica_id),
        paciente_id: toIntOrNull(cita?.paciente_id),
        tratamiento_id: toIntOrNull(cita?.tratamiento_id),
        estado: cleanString(cita?.estado).toLowerCase() || null,
        inicio: cita?.inicio || null,
        fin: cita?.fin || null,
      },
    },
    appointment: {
      id_cita: toIntOrNull(cita?.id_cita),
      clinica_id: toIntOrNull(cita?.clinica_id),
      paciente_id: toIntOrNull(cita?.paciente_id),
      tratamiento_id: toIntOrNull(cita?.tratamiento_id),
      estado: cleanString(cita?.estado).toLowerCase() || null,
      inicio: cita?.inicio || null,
      fin: cita?.fin || null,
    },
    outputs: {},
  };
}

async function enqueueExecutionForCita(cita, options = {}) {
  const citaId = toIntOrNull(cita?.id_cita);
  if (!citaId) {
    return { success: false, skipped: true, reason: 'invalid_cita' };
  }

  const eventName = normalizeEventName(options.event_name) || mapEstadoToEvent(cita?.estado) || 'appointment_created';

  const template = await resolveTemplateForCitaEvent(cita, eventName);
  if (!template || !APPOINTMENT_TRIGGER_TYPES.has(cleanString(template.trigger_type))) {
    return { success: false, skipped: true, reason: 'no_template_for_event' };
  }

  const idempotencyKey = cleanString(options.idempotency_key) || buildIdempotencyKey({
    triggerType: eventName,
    citaId,
    templateVersionId: template.id,
    windowIdentifier: options.window_identifier,
  });

  const existing = await FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
  if (existing) {
    return { success: true, deduplicated: true, execution: existing, template };
  }

  const scope = await resolveClinicScope(cita);
  const requestedBy = toIntOrNull(options.user_id) || toIntOrNull(template.created_by) || 1;
  const context = buildExecutionContext({ cita, eventName });

  const createdExecution = await FlowExecutionV2.create({
    idempotency_key: idempotencyKey,
    template_version_id: template.id,
    engine_version: template.engine_version || 'v2',
    status: 'running',
    context,
    current_node_id: template.entry_node_id,
    trigger_type: eventName,
    trigger_entity_type: 'appointment',
    trigger_entity_id: citaId,
    clinic_id: scope.clinic_id,
    group_id: scope.group_id,
    created_by: requestedBy,
  });
  const io = getIO();
  if (io) {
    const clinicId = toIntOrNull(createdExecution.clinic_id);
    const payload = {
      execution_id: createdExecution.id,
      template_version_id: createdExecution.template_version_id,
      status: createdExecution.status,
      current_node_id: createdExecution.current_node_id,
      clinic_id: clinicId,
      group_id: createdExecution.group_id || null,
      trigger_type: createdExecution.trigger_type,
      trigger_entity_type: createdExecution.trigger_entity_type,
      trigger_entity_id: createdExecution.trigger_entity_id,
      created_at: createdExecution.created_at,
    };
    if (clinicId) io.to(`clinic:${clinicId}`).emit('flow_execution:created', payload);
    else io.emit('flow_execution:created', payload);
  }

  const queueJob = await jobRequestsService.enqueueJobRequest({
    type: 'automations_v2_execute',
    priority: 'high',
    origin: 'appointment_automation_v2',
    payload: { execution_id: createdExecution.id },
    requestedBy,
    requestedByName: cleanString(options.user_name) || null,
    requestedByRole: cleanString(options.user_role) || 'system',
  });
  jobScheduler.triggerImmediate(queueJob.id).catch(() => {});

  return {
    success: true,
    deduplicated: false,
    execution: createdExecution,
    template,
    queue_job_id: queueJob.id,
  };
}

async function getExecutionsByAppointmentId(citaId, limit = 25) {
  const numericCitaId = toIntOrNull(citaId);
  if (!numericCitaId) return [];

  const rows = await FlowExecutionV2.findAll({
    where: {
      trigger_entity_type: 'appointment',
      trigger_entity_id: numericCitaId,
    },
    include: [
      {
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type', 'nodes'],
        required: false,
      },
    ],
    order: [['updated_at', 'DESC']],
    limit: Math.max(1, Math.min(100, Number(limit) || 25)),
  });

  return rows;
}

async function getLatestExecutionByAppointmentId(citaId) {
  const rows = await getExecutionsByAppointmentId(citaId, 50);
  return pickPreferredExecution(rows);
}

async function getExecutionLogs(executionId, limit = 100) {
  const numericExecutionId = toIntOrNull(executionId);
  if (!numericExecutionId) return [];

  return FlowExecutionLogV2.findAll({
    where: { flow_execution_id: numericExecutionId },
    order: [['id', 'ASC']],
    limit: Math.max(1, Math.min(500, Number(limit) || 100)),
  });
}

module.exports = {
  APPOINTMENT_TRIGGER_TYPES,
  enqueueExecutionForCita,
  getExecutionsByAppointmentId,
  getLatestExecutionByAppointmentId,
  getExecutionLogs,
};
