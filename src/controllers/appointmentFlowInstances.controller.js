'use strict';

const db = require('../../models');
const runtime = require('../services/appointmentFlowRuntime.service');

const AppointmentFlowInstance = db.AppointmentFlowInstance;
const AppointmentFlowTemplate = db.AppointmentFlowTemplate;

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapInstance(row) {
  if (!row) return null;
  const item = row?.toJSON ? row.toJSON() : row;

  return {
    id: item.id,
    cita_id: item.cita_id,
    clinica_id: item.clinica_id,
    paciente_id: item.paciente_id ?? null,
    tratamiento_id: item.tratamiento_id ?? null,
    template_id: item.template_id,
    template_version: item.template_version ?? null,
    template_name: item?.template?.name || null,
    status: item.status,
    current_step_index: item.current_step_index ?? null,
    current_step_type: item.current_step_type ?? null,
    current_step_label: item.current_step_label ?? null,
    flow_status: item.status,
    current_state: item.current_state ?? null,
    agenda_icon: item.agenda_icon ?? null,
    next_action_at: item.next_action_at ?? null,
    last_transition_at: item.last_transition_at ?? null,
    last_error: item.last_error ?? null,
    error_message: item.last_error ?? null,
    completed_at: item.completed_at ?? null,
    context_json: item.context_json ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function mapLog(row) {
  const item = row?.toJSON ? row.toJSON() : row;
  return {
    id: item.id,
    flow_instance_id: item.flow_instance_id,
    cita_id: item.cita_id,
    step_index: item.step_index ?? null,
    step_type: item.step_type ?? null,
    step_label: item.step_label ?? null,
    event_type: item.event_type,
    status_before: item.status_before ?? null,
    status_after: item.status_after ?? null,
    payload: item.payload ?? null,
    created_at: item.created_at,
  };
}

exports.getByAppointment = async (req, res) => {
  try {
    const citaId = toNumberOrNull(req.params?.citaId);
    if (!citaId) {
      return res.status(400).json({
        success: false,
        error: 'invalid_cita_id',
        message: 'citaId inválido',
      });
    }

    await runtime.ensureAndGetByAppointmentId(citaId, {
      event_name: 'fetch_state',
      user_id: req.userData?.userId || null,
    });

    const row = await AppointmentFlowInstance.findOne({
      where: { cita_id: citaId },
      include: [
        {
          model: AppointmentFlowTemplate,
          as: 'template',
          attributes: ['id', 'name', 'version'],
          required: false,
        },
      ],
    });

    return res.status(200).json({
      success: true,
      data: mapInstance(row),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'get_instance_failed',
      message: error.message,
    });
  }
};

exports.syncByAppointment = async (req, res) => {
  try {
    const citaId = toNumberOrNull(req.params?.citaId);
    if (!citaId) {
      return res.status(400).json({
        success: false,
        error: 'invalid_cita_id',
        message: 'citaId inválido',
      });
    }

    const instance = await runtime.ensureAndGetByAppointmentId(citaId, {
      event_name: 'manual_sync',
      user_id: req.userData?.userId || null,
    });

    if (!instance) {
      return res.status(200).json({
        success: true,
        data: null,
        message: 'La cita no tiene flujo de cita asignado',
      });
    }

    const row = await AppointmentFlowInstance.findByPk(instance.id, {
      include: [
        {
          model: AppointmentFlowTemplate,
          as: 'template',
          attributes: ['id', 'name', 'version'],
          required: false,
        },
      ],
    });

    return res.status(200).json({
      success: true,
      data: mapInstance(row),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'sync_instance_failed',
      message: error.message,
    });
  }
};

exports.getLogs = async (req, res) => {
  try {
    const instanceId = toNumberOrNull(req.params?.id);
    if (!instanceId) {
      return res.status(400).json({
        success: false,
        error: 'invalid_instance_id',
        message: 'id inválido',
      });
    }

    const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
    const logs = await runtime.getInstanceLogs(instanceId, limit);

    return res.status(200).json({
      success: true,
      data: logs.map(mapLog),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'get_logs_failed',
      message: error.message,
    });
  }
};
