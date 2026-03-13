'use strict';

const db = require('../../models');

const AppointmentFlowTemplate = db.AppointmentFlowTemplate;
const AppointmentFlowInstance = db.AppointmentFlowInstance;
const AppointmentFlowInstanceLog = db.AppointmentFlowInstanceLog;
const CitaPaciente = db.CitaPaciente;
const Tratamiento = db.Tratamiento;
const { normalizeCitaStatus } = require('../lib/status-catalog');

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeEstado(estado) {
  return normalizeCitaStatus(estado) || 'pendiente';
}

function mapEstadoToFlowStatus(estado) {
  if (['cancelada'].includes(estado)) return 'cancelled';
  if (['completada', 'no_asistio'].includes(estado)) return 'completed';
  return 'running';
}

function mapEstadoToAgendaIcon(estado) {
  if (estado === 'info_enviada') return 'sent';
  if (estado === 'info_confirmada') return 'confirmed';
  if (estado === 'recordatorio_enviado') return 'reminder-sent';
  if (estado === 'recordatorio_confirmado') return 'reminder-confirmed';
  if (estado === 'reprogramada') return 'pending_confirmation';
  if (estado === 'cancelada') return 'not_confirmed';
  if (estado === 'no_asistio') return 'no_show';
  if (estado === 'completada') return 'completed';
  return 'pending_confirmation';
}

function getStepLabel(step, index) {
  if (step?.label && String(step.label).trim()) return String(step.label).trim();
  return `Paso ${index + 1}`;
}

function getStepRunAt(step, cita) {
  const inicio = toDateOrNull(cita?.inicio);
  const fin = toDateOrNull(cita?.fin) || inicio;
  const createdAt = toDateOrNull(cita?.created_at) || inicio;
  if (!inicio || !fin || !createdAt) return null;

  const offsetValue = Number.isFinite(Number(step?.offset_value)) ? Number(step.offset_value) : 0;
  const unit = String(step?.offset_unit || 'day').toLowerCase();
  const unitMs = unit === 'minute' ? 60000 : unit === 'hour' ? 3600000 : 86400000;
  const deltaMs = Math.max(0, offsetValue) * unitMs;
  const moment = String(step?.moment || 'after_booking').toLowerCase();

  if (moment === 'after_booking') return new Date(createdAt.getTime() + deltaMs);
  if (moment === 'days_before' || moment === 'hours_before') return new Date(inicio.getTime() - deltaMs);
  if (moment === 'day_of') return new Date(inicio.getTime() + deltaMs);
  if (moment === 'after_appointment') return new Date(fin.getTime() + deltaMs);
  return null;
}

function resolveProgress(template, cita) {
  const now = new Date();
  const estado = normalizeEstado(cita?.estado);
  const flowStatus = mapEstadoToFlowStatus(estado);
  const steps = Array.isArray(template?.steps) ? template.steps : [];

  if (!steps.length) {
    return {
      status: flowStatus === 'running' ? 'completed' : flowStatus,
      current_step_index: null,
      current_step_type: null,
      current_step_label: null,
      current_state: estado,
      agenda_icon: mapEstadoToAgendaIcon(estado),
      next_action_at: null,
      completed_at: flowStatus === 'running' ? now : now,
      context_json: {
        derived_from: 'empty_template',
        cita_estado: estado,
      },
    };
  }

  const schedule = steps.map((step, index) => ({
    index,
    step,
    run_at: getStepRunAt(step, cita),
  }));

  const future = schedule.find((item) => item.run_at && item.run_at.getTime() >= now.getTime()) || null;
  const past = [...schedule].reverse().find((item) => item.run_at && item.run_at.getTime() <= now.getTime()) || null;
  const current = flowStatus === 'running' ? (past || future || schedule[0]) : (past || schedule[schedule.length - 1]);

  const currentStep = current?.step || null;
  const currentState = (currentStep?.type === 'set_state' && currentStep?.new_state)
    ? String(currentStep.new_state)
    : estado;
  const agendaIcon = currentStep?.agenda_icon || mapEstadoToAgendaIcon(estado);

  return {
    status: flowStatus,
    current_step_index: current ? current.index : null,
    current_step_type: currentStep?.type || null,
    current_step_label: current ? getStepLabel(currentStep, current.index) : null,
    current_state: currentState,
    agenda_icon: agendaIcon,
    next_action_at: future?.run_at || null,
    completed_at: ['completed', 'cancelled'].includes(flowStatus) ? now : null,
    context_json: {
      cita_estado: estado,
      step_count: steps.length,
      next_step_index: future?.index ?? null,
      timeline: schedule.map((item) => ({
        index: item.index,
        type: item.step?.type || null,
        label: getStepLabel(item.step, item.index),
        run_at: item.run_at ? item.run_at.toISOString() : null,
      })),
    },
  };
}

async function resolveTemplateForCita(cita, transaction = null) {
  const tratamientoId = toNumberOrNull(cita?.tratamiento_id);
  if (!tratamientoId) return null;

  const tratamiento = await Tratamiento.findByPk(tratamientoId, {
    attributes: ['id_tratamiento', 'appointment_flow_template_id'],
    transaction: transaction || undefined,
  });

  const templateId = toNumberOrNull(tratamiento?.appointment_flow_template_id);
  if (!templateId) return null;

  return AppointmentFlowTemplate.findOne({
    where: { id: templateId, is_active: true },
    transaction: transaction || undefined,
  });
}

async function createLog(instance, payload, transaction = null) {
  if (!instance?.id) return null;
  return AppointmentFlowInstanceLog.create(
    {
      flow_instance_id: instance.id,
      cita_id: instance.cita_id,
      step_index: payload?.step_index ?? null,
      step_type: payload?.step_type ?? null,
      step_label: payload?.step_label ?? null,
      event_type: payload?.event_type || 'sync',
      status_before: payload?.status_before ?? null,
      status_after: payload?.status_after ?? null,
      payload: payload?.payload ?? null,
      created_at: new Date(),
    },
    { transaction: transaction || undefined }
  );
}

async function syncInstanceForCita(cita, options = {}) {
  if (!cita?.id_cita) return null;

  const eventName = options?.event_name || 'sync';
  const transaction = options?.transaction || null;
  const userId = toNumberOrNull(options?.user_id);

  const template = await resolveTemplateForCita(cita, transaction);
  if (!template) return null;

  const progress = resolveProgress(template, cita);
  const where = { cita_id: Number(cita.id_cita) };

  let instance = await AppointmentFlowInstance.findOne({
    where,
    transaction: transaction || undefined,
  });

  const baseData = {
    cita_id: Number(cita.id_cita),
    clinica_id: Number(cita.clinica_id),
    paciente_id: toNumberOrNull(cita.paciente_id),
    tratamiento_id: toNumberOrNull(cita.tratamiento_id),
    template_id: Number(template.id),
    template_version: template.version || null,
    status: progress.status,
    current_step_index: progress.current_step_index,
    current_step_type: progress.current_step_type,
    current_step_label: progress.current_step_label,
    current_state: progress.current_state,
    agenda_icon: progress.agenda_icon,
    next_action_at: progress.next_action_at,
    last_transition_at: new Date(),
    context_json: progress.context_json,
    completed_at: progress.completed_at,
    last_error: null,
  };

  if (!instance) {
    instance = await AppointmentFlowInstance.create(
      {
        ...baseData,
        started_at: new Date(),
        created_by: userId,
      },
      { transaction: transaction || undefined }
    );

    await createLog(
      instance,
      {
        event_type: 'created',
        status_before: null,
        status_after: instance.status,
        step_index: instance.current_step_index,
        step_type: instance.current_step_type,
        step_label: instance.current_step_label,
        payload: {
          event_name: eventName,
          trigger: 'appointment',
          cita_estado: normalizeEstado(cita.estado),
        },
      },
      transaction
    );
    return instance;
  }

  const prevStatus = instance.status;
  await instance.update(baseData, { transaction: transaction || undefined });

  await createLog(
    instance,
    {
      event_type: 'synced',
      status_before: prevStatus,
      status_after: instance.status,
      step_index: instance.current_step_index,
      step_type: instance.current_step_type,
      step_label: instance.current_step_label,
      payload: {
        event_name: eventName,
        trigger: 'appointment',
        cita_estado: normalizeEstado(cita.estado),
      },
    },
    transaction
  );

  return instance;
}

async function ensureAndGetByAppointmentId(citaId, options = {}) {
  const numericId = toNumberOrNull(citaId);
  if (!numericId) return null;

  const cita = await CitaPaciente.findByPk(numericId, {
    transaction: options?.transaction || undefined,
  });
  if (!cita) return null;

  return syncInstanceForCita(cita, {
    event_name: options?.event_name || 'fetch',
    user_id: options?.user_id || null,
    transaction: options?.transaction || null,
  });
}

async function listInstancesByAppointmentIds(citaIds) {
  const ids = Array.from(
    new Set((Array.isArray(citaIds) ? citaIds : []).map((id) => toNumberOrNull(id)).filter(Boolean))
  );
  if (!ids.length) return [];

  return AppointmentFlowInstance.findAll({
    where: { cita_id: ids.length === 1 ? ids[0] : { [db.Sequelize.Op.in]: ids } },
    attributes: [
      'id',
      'cita_id',
      'template_id',
      'template_version',
      'status',
      'current_step_index',
      'current_step_type',
      'current_step_label',
      'current_state',
      'agenda_icon',
      'next_action_at',
      'last_transition_at',
      'last_error',
      'completed_at',
    ],
    order: [['id', 'DESC']],
  });
}

async function getInstanceLogs(instanceId, limit = 100) {
  const numericId = toNumberOrNull(instanceId);
  if (!numericId) return [];

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return AppointmentFlowInstanceLog.findAll({
    where: { flow_instance_id: numericId },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit: safeLimit,
  });
}

module.exports = {
  syncInstanceForCita,
  ensureAndGetByAppointmentId,
  listInstancesByAppointmentIds,
  getInstanceLogs,
};
