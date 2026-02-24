'use strict';

const db = require('../../models');
const runtime = require('../services/appointmentFlowRuntime.service');
const appointmentAutomationV2Runtime = require('../services/appointmentAutomationV2Runtime.service');

const AppointmentFlowInstance = db.AppointmentFlowInstance;
const AppointmentFlowTemplate = db.AppointmentFlowTemplate;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const CitaPaciente = db.CitaPaciente;

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

function mapInstanceV2(row) {
  if (!row) return null;
  const item = row?.toJSON ? row.toJSON() : row;
  const template = item?.templateVersion || null;
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  const currentNodeId = item.current_node_id || null;
  const currentNode = currentNodeId
    ? nodes.find((node) => String(node?.id || '') === String(currentNodeId))
    : null;
  const waitUntil = item.wait_until || item.waiting_meta?.wait_until || null;

  return {
    id: item.id,
    cita_id: item.trigger_entity_id,
    clinica_id: item.clinic_id ?? null,
    paciente_id: item?.context?.appointment?.paciente_id ?? item?.context?.trigger?.data?.paciente_id ?? null,
    tratamiento_id: item?.context?.appointment?.tratamiento_id ?? item?.context?.trigger?.data?.tratamiento_id ?? null,
    template_id: item.template_version_id,
    template_version: template?.version ?? null,
    template_name: template?.name || null,
    status: item.status,
    current_step_index: null,
    current_step_type: currentNode?.type || null,
    current_step_label: currentNode?.label || currentNodeId || null,
    flow_status: item.status,
    current_state: item.status,
    agenda_icon: null,
    next_action_at: waitUntil,
    last_transition_at: item.updated_at || item.created_at || null,
    last_error: item.last_error ?? null,
    error_message: item.last_error ?? null,
    completed_at: item.status === 'completed' ? (item.updated_at || item.created_at || null) : null,
    context_json: item.context ?? null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
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

function mapNodeTypeLabel(nodeType) {
  const key = String(nodeType || '').trim();
  const labels = {
    'action/change_status': 'Cambiar estado',
    'action/write_note': 'Escribir nota',
    'action/create_task': 'Crear tarea',
    'action/send_whatsapp': 'Enviar WhatsApp',
    'action/send_email': 'Enviar email',
    'delay/fixed': 'Espera fija',
    'delay/wait_until': 'Esperar hasta fecha',
    'delay/wait_response': 'Esperar respuesta',
    'condition/field_check': 'Condición por campo',
    'condition/response_check': 'Condición por respuesta',
    'condition/ai_analysis': 'Análisis IA',
  };
  return labels[key] || key || 'Nodo';
}

function mapLogV2(row, execution) {
  const item = row?.toJSON ? row.toJSON() : row;
  const startedAt = item.started_at ? new Date(item.started_at) : null;
  const finishedAt = item.finished_at ? new Date(item.finished_at) : null;
  const durationMs = startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null;
  const nodeId = String(item.node_id || '').trim();
  const stepIndex = /^N(\d+)$/.test(nodeId) ? Number(nodeId.slice(1)) - 1 : null;
  const templateNodes = Array.isArray(execution?.templateVersion?.nodes) ? execution.templateVersion.nodes : [];
  const nodeDef = nodeId ? templateNodes.find((node) => String(node?.id || '').trim() === nodeId) : null;
  const nodeLabel = String(nodeDef?.label || nodeDef?.name || '').trim();
  const nodeTypeLabel = mapNodeTypeLabel(item.node_type);
  const statusMap = {
    success: 'success',
    error: 'failed',
    running: 'running',
  };

  return {
    id: item.id,
    flow_instance_id: item.flow_execution_id,
    cita_id: execution?.trigger_entity_id ?? null,
    step_index: Number.isFinite(stepIndex) ? stepIndex : null,
    step_type: item.node_type ?? null,
    step_label: nodeLabel || nodeId || null,
    event_type: 'node_execution',
    status_before: null,
    status_after: item.status || null,
    payload: item.audit_snapshot ?? null,
    created_at: item.started_at || item.created_at,
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    status: statusMap[item.status] || 'info',
    message: nodeLabel || nodeTypeLabel || (nodeId ? `Nodo ${nodeId}` : 'Ejecución de nodo'),
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

    const v2Execution = await appointmentAutomationV2Runtime.getLatestExecutionByAppointmentId(citaId);
    if (v2Execution) {
      return res.status(200).json({
        success: true,
        data: mapInstanceV2(v2Execution),
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

    const cita = await CitaPaciente.findByPk(citaId);
    if (cita) {
      await appointmentAutomationV2Runtime.enqueueExecutionForCita(cita, {
        event_name: req.body?.event_name || null,
        user_id: req.userData?.userId || null,
        user_name: req.userData?.name || req.userData?.nombre || req.userData?.email || null,
        user_role: req.userData?.role || req.userData?.rol || 'admin',
      });

      const v2Execution = await appointmentAutomationV2Runtime.getLatestExecutionByAppointmentId(citaId);
      if (v2Execution) {
        return res.status(200).json({
          success: true,
          data: mapInstanceV2(v2Execution),
        });
      }
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

    const v2Execution = await FlowExecutionV2.findOne({
      where: {
        id: instanceId,
        trigger_entity_type: 'appointment',
      },
      include: [
        {
          model: AutomationFlowTemplateV2,
          as: 'templateVersion',
          attributes: ['id', 'template_key', 'version', 'name', 'nodes'],
          required: false,
        },
      ],
    });
    if (v2Execution) {
      const logsV2 = await FlowExecutionLogV2.findAll({
        where: { flow_execution_id: instanceId },
        order: [['id', 'ASC']],
        limit,
      });
      return res.status(200).json({
        success: true,
        data: logsV2.map((row) => mapLogV2(row, v2Execution)),
      });
    }

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
