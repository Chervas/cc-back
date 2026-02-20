'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { getIO } = require('./socket.service');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const Conversation = db.Conversation;
const Message = db.Message;
const Notification = db.Notification;
const UsuarioClinica = db.UsuarioClinica;

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function getByPath(obj, path) {
  if (!path) return undefined;
  const safePath = String(path)
    .replace(/^context\./, '')
    .replace(/^\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');

  const chunks = safePath.split('.').filter(Boolean);
  let current = obj;

  for (const chunk of chunks) {
    if (current === undefined || current === null) return undefined;
    current = current[chunk];
  }

  return current;
}

function resolveTemplateValue(value, context) {
  if (typeof value !== 'string') return value;
  const fullTemplate = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);

  if (fullTemplate) {
    return getByPath(context, fullTemplate[1]);
  }

  if (value.startsWith('context.')) {
    return getByPath(context, value);
  }

  return value;
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readFirstIntFromPaths(context, paths) {
  for (const path of paths) {
    const value = getByPath(context, path);
    const parsed = toIntOrNull(value);
    if (parsed) return parsed;
  }
  return null;
}

function resolveRuntimeTargets(execution, context) {
  const triggerType = normalizeKey(execution?.trigger_entity_type);
  const triggerEntityId = toIntOrNull(execution?.trigger_entity_id);

  const clinicId = toIntOrNull(execution?.clinic_id) || readFirstIntFromPaths(context, [
    'trigger.data.clinic_id',
    'trigger.data.clinica_id',
    'clinic.id',
    'clinic.id_clinica',
    'appointment.clinic_id',
    'appointment.clinica_id',
    'conversation.clinic_id',
    'lead.clinica_id',
  ]);

  let appointmentId = readFirstIntFromPaths(context, [
    'appointment.id',
    'appointment.id_cita',
    'cita.id',
    'cita.id_cita',
    'trigger.data.appointment_id',
    'trigger.data.cita_id',
    'trigger.data.id_cita',
  ]);
  if (!appointmentId && ['appointment', 'appointment_created', 'cita', 'cita_creada'].includes(triggerType)) {
    appointmentId = triggerEntityId;
  }

  let leadIntakeId = readFirstIntFromPaths(context, [
    'lead.id',
    'lead.lead_intake_id',
    'lead.id_lead',
    'trigger.data.lead_intake_id',
    'trigger.data.lead_id',
    'trigger.data.id_lead',
  ]);
  if (!leadIntakeId && ['lead', 'lead_intake', 'leadintake', 'lead_nuevo'].includes(triggerType)) {
    leadIntakeId = triggerEntityId;
  }

  let conversationId = readFirstIntFromPaths(context, [
    'conversation.id',
    'trigger.data.conversation_id',
    'trigger.data.chat_conversation_id',
    'trigger.data.conversationId',
  ]);
  if (!conversationId && ['conversation', 'chat_conversation', 'whatsapp_conversation'].includes(triggerType)) {
    conversationId = triggerEntityId;
  }

  const patientId = readFirstIntFromPaths(context, [
    'patient.id',
    'patient.id_paciente',
    'appointment.paciente_id',
    'trigger.data.patient_id',
    'trigger.data.paciente_id',
  ]);

  return {
    clinic_id: clinicId,
    appointment_id: appointmentId,
    lead_intake_id: leadIntakeId,
    conversation_id: conversationId,
    patient_id: patientId,
  };
}

function normalizeAppointmentStatus(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  const map = {
    pendiente: 'pendiente',
    agendada: 'pendiente',
    confirmada: 'confirmada',
    confirmado: 'confirmada',
    cancelada: 'cancelada',
    cancelado: 'cancelada',
    completada: 'completada',
    completado: 'completada',
    realizada: 'completada',
    no_asistio: 'no_asistio',
    no_show: 'no_asistio',
    no_showed: 'no_asistio',
    ausente: 'no_asistio',
  };
  return map[key] || null;
}

function normalizeLeadStatus(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  const map = {
    nuevo: 'nuevo',
    contactado: 'contactado',
    esperando_info: 'esperando_info',
    info_recibida: 'info_recibida',
    citado: 'citado',
    acudio_cita: 'acudio_cita',
    convertido: 'convertido',
    descartado: 'descartado',
  };
  return map[key] || null;
}

function appendText(base, text) {
  const cleanBase = cleanString(base);
  const cleanText = cleanString(text);
  if (!cleanText) return cleanBase || null;
  if (!cleanBase) return cleanText;
  return `${cleanBase}\n${cleanText}`;
}

function parseDueDateOffset(rawOffset) {
  const value = cleanString(rawOffset);
  if (!value) return null;
  const match = value.match(/^(\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days)$/i);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const ms = resolveDurationMs(amount, unit);
  return ms > 0 ? new Date(Date.now() + ms) : null;
}

function resolveRoleCode(raw) {
  const key = normalizeKey(raw);
  if (!key) return null;
  if (['1', 'owner', 'propietario', 'administrador', 'admin'].includes(key)) return 'propietario';
  if (['2', 'staff', 'personal', 'personaldeclinica', 'clinic_staff', 'recepcion', 'recepcion_comercial_ventas'].includes(key)) {
    return 'personaldeclinica';
  }
  if (['3', 'patient', 'paciente'].includes(key)) return 'paciente';
  return null;
}

async function resolveTaskAssigneeUserIds({ clinicId, assigneeType, assigneeId, roleCode, subrole }) {
  if (!clinicId) return [];

  const normalizedAssigneeType = normalizeKey(assigneeType) || 'role';
  if (normalizedAssigneeType === 'user') {
    const userId = toIntOrNull(assigneeId);
    if (!userId) return [];
    const membership = await UsuarioClinica.findOne({
      where: { id_clinica: clinicId, id_usuario: userId },
      attributes: ['id_usuario'],
      raw: true,
    });
    return membership ? [userId] : [];
  }

  const effectiveRole = roleCode || resolveRoleCode(assigneeId);
  const where = { id_clinica: clinicId };
  if (effectiveRole) {
    where.rol_clinica = effectiveRole;
  } else {
    where.rol_clinica = { [Op.in]: ['propietario', 'personaldeclinica'] };
  }

  const normalizedSubrole = cleanString(subrole);
  if (normalizedSubrole) {
    where.subrol_clinica = normalizedSubrole;
  }

  const rows = await UsuarioClinica.findAll({
    where,
    attributes: ['id_usuario'],
    raw: true,
    limit: 50,
  });

  return Array.from(new Set(rows.map((row) => toIntOrNull(row.id_usuario)).filter(Boolean)));
}

async function handleChangeStatus(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const requestedStatus = resolveTemplateValue(config?.new_status, context);
  const rawStatus = cleanString(requestedStatus);
  if (!rawStatus) {
    throw new Error('change_status_missing_new_status');
  }

  const appointmentStatus = normalizeAppointmentStatus(rawStatus);
  const leadStatus = normalizeLeadStatus(rawStatus);
  const agendaIcon = cleanString(resolveTemplateValue(config?.agenda_icon, context));
  const now = new Date().toISOString();

  if (targets.appointment_id) {
    const appointment = await CitaPaciente.findByPk(targets.appointment_id);
    if (!appointment) {
      throw new Error(`appointment_not_found:${targets.appointment_id}`);
    }
    if (!appointmentStatus) {
      throw new Error(`invalid_appointment_status:${rawStatus}`);
    }

    const previousStatus = cleanString(appointment.estado);
    const updates = { estado: appointmentStatus };
    if (agendaIcon) {
      const iconLine = `[${now}] Icono agenda: ${agendaIcon}`;
      updates.nota = appendText(appointment.nota, iconLine);
    }
    await appointment.update(updates);

    return {
      kind: 'success',
      output: {
        target_type: 'appointment',
        target_id: appointment.id_cita,
        previous_status: previousStatus,
        new_status: appointmentStatus,
        agenda_icon: agendaIcon,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  if (targets.lead_intake_id) {
    const lead = await LeadIntake.findByPk(targets.lead_intake_id);
    if (!lead) {
      throw new Error(`lead_not_found:${targets.lead_intake_id}`);
    }
    if (!leadStatus) {
      throw new Error(`invalid_lead_status:${rawStatus}`);
    }

    const previousStatus = cleanString(lead.status_lead);
    await lead.update({ status_lead: leadStatus });

    return {
      kind: 'success',
      output: {
        target_type: 'lead',
        target_id: lead.id,
        previous_status: previousStatus,
        new_status: leadStatus,
        agenda_icon: null,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  throw new Error('change_status_target_not_found');
}

async function handleWriteNote(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const contentValue = resolveTemplateValue(config?.content, context);
  const content = cleanString(contentValue);
  if (!content) {
    throw new Error('write_note_empty_content');
  }

  const timestamp = new Date().toISOString();
  const noteLine = `[${timestamp}] ${content}`;
  const result = {
    content,
    written: false,
    writes: 0,
    targets,
  };

  if (targets.conversation_id) {
    const conversation = await Conversation.findByPk(targets.conversation_id);
    if (conversation) {
      const msg = await Message.create({
        conversation_id: conversation.id,
        sender_id: null,
        direction: 'inbound',
        content: noteLine,
        message_type: 'event',
        status: 'sent',
        sent_at: new Date(),
        metadata: {
          source: 'automations_v2',
          kind: 'automation_note',
          execution_id: runtime?.execution?.id || null,
          node_id: cleanString(node?.id),
        },
      });
      conversation.last_message_at = new Date();
      await conversation.save();

      const io = getIO();
      if (io && conversation.clinic_id) {
        io.to(`clinic:${conversation.clinic_id}`).emit('message:created', {
          id: msg.id,
          conversation_id: String(conversation.id),
          content: msg.content,
          direction: msg.direction,
          message_type: msg.message_type,
          status: msg.status,
          sent_at: msg.sent_at,
          metadata: msg.metadata || null,
        });
      }

      result.written = true;
      result.writes += 1;
      result.message_id = msg.id;
    }
  }

  if (targets.lead_intake_id) {
    const lead = await LeadIntake.findByPk(targets.lead_intake_id);
    if (lead) {
      await lead.update({
        notas_internas: appendText(lead.notas_internas, noteLine),
      });
      result.written = true;
      result.writes += 1;
      result.lead_id = lead.id;
    }
  }

  if (targets.appointment_id) {
    const appointment = await CitaPaciente.findByPk(targets.appointment_id);
    if (appointment) {
      await appointment.update({
        nota: appendText(appointment.nota, noteLine),
      });
      result.written = true;
      result.writes += 1;
      result.appointment_id = appointment.id_cita;
    }
  }

  if (!result.written) {
    result.status = 'skipped_no_target';
  } else {
    result.status = 'ok';
  }

  return {
    kind: 'success',
    output: result,
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

async function handleCreateTask(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const clinicId = toIntOrNull(targets.clinic_id);
  if (!clinicId) {
    throw new Error('create_task_missing_clinic_id');
  }

  const title = cleanString(resolveTemplateValue(config?.title, context)) || 'Tarea de automatización';
  const description = cleanString(resolveTemplateValue(config?.description, context));
  const assigneeType = cleanString(resolveTemplateValue(config?.assignee_type, context)) || 'role';
  const assigneeId = resolveTemplateValue(config?.assignee_id, context);
  const roleCode = resolveRoleCode(
    resolveTemplateValue(config?.role_code, context)
      || resolveTemplateValue(config?.role, context)
      || resolveTemplateValue(config?.assignee_role, context)
  );
  const subrole = cleanString(resolveTemplateValue(config?.subrole, context));
  const dueDate = parseDueDateOffset(resolveTemplateValue(config?.due_date_offset, context));

  const userIds = await resolveTaskAssigneeUserIds({
    clinicId,
    assigneeType,
    assigneeId,
    roleCode,
    subrole,
  });

  if (!userIds.length) {
    throw new Error('create_task_no_assignees');
  }

  const message = description || title;
  const createdNotifications = [];
  for (const userId of userIds) {
    const notification = await Notification.create({
      userId,
      role: roleCode || null,
      subrole: subrole || null,
      category: 'general',
      event: 'automation.task_created',
      title,
      message,
      icon: 'heroicons_outline:clipboard-document-list',
      level: 'info',
      data: {
        source: 'automations_v2',
        execution_id: runtime?.execution?.id || null,
        node_id: cleanString(node?.id),
        trigger_type: cleanString(runtime?.execution?.trigger_type),
        trigger_entity_type: cleanString(runtime?.execution?.trigger_entity_type),
        trigger_entity_id: toIntOrNull(runtime?.execution?.trigger_entity_id),
        due_at: dueDate ? dueDate.toISOString() : null,
      },
      clinicaId: clinicId,
    });
    createdNotifications.push(notification);
  }

  return {
    kind: 'success',
    output: {
      task_id: createdNotifications[0]?.id || null,
      assignee_user_ids: userIds,
      notifications_created: createdNotifications.length,
      due_at: dueDate ? dueDate.toISOString() : null,
      status: 'created',
    },
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

function mergeNodeOutput(context, nodeId, patch) {
  const nextContext = clone(context) || {};
  nextContext.outputs = nextContext.outputs && typeof nextContext.outputs === 'object' ? nextContext.outputs : {};
  const prev = nextContext.outputs[nodeId] && typeof nextContext.outputs[nodeId] === 'object'
    ? nextContext.outputs[nodeId]
    : {};
  nextContext.outputs[nodeId] = {
    ...prev,
    ...patch,
  };
  return nextContext;
}

function readOutputTarget(node, key) {
  const outputs = node?.outputs && typeof node.outputs === 'object' ? node.outputs : {};
  if (!(key in outputs)) return null;
  const raw = outputs[key];
  const target = cleanString(raw);
  return target || null;
}

function resolveDurationMs(duration, unit) {
  const qty = Number(duration);
  if (!Number.isFinite(qty) || qty < 0) return 0;

  const normalized = String(unit || '').toLowerCase();
  if (normalized.startsWith('second')) return qty * 1000;
  if (normalized.startsWith('minute')) return qty * 60 * 1000;
  if (normalized.startsWith('hour')) return qty * 60 * 60 * 1000;
  if (normalized.startsWith('day')) return qty * 24 * 60 * 60 * 1000;
  return qty * 1000;
}

function evaluateFieldCheck(config, context) {
  const left = resolveTemplateValue(config?.field, context);
  const right = resolveTemplateValue(config?.value, context);
  const operator = String(config?.operator || 'equals').toLowerCase();

  if (operator === 'exists') {
    return left !== undefined && left !== null && left !== '';
  }

  if (operator === 'equals') {
    return String(left) === String(right);
  }

  if (operator === 'not_equals') {
    return String(left) !== String(right);
  }

  if (operator === 'contains') {
    return String(left || '').toLowerCase().includes(String(right || '').toLowerCase());
  }

  if (operator === 'greater_than') {
    return Number(left) > Number(right);
  }

  if (operator === 'less_than') {
    return Number(left) < Number(right);
  }

  return false;
}

function evaluateResponseExists(config, context) {
  const listensTo = cleanString(config?.listens_to_node_id);
  if (!listensTo) return false;

  const output = context?.outputs?.[listensTo];
  const responseText = output?.response_text;
  return responseText !== undefined && responseText !== null && String(responseText).trim() !== '';
}

function parseWaitUntilExpression(expression, context) {
  const resolved = resolveTemplateValue(expression, context);
  if (!resolved) return null;

  if (resolved instanceof Date && !Number.isNaN(resolved.getTime())) {
    return resolved;
  }

  const asDate = new Date(resolved);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate;
  }

  return null;
}

async function processNode(node, context, runtime = {}) {
  const nodeType = cleanString(node?.type) || 'unknown';
  const config = node?.config && typeof node.config === 'object' ? node.config : {};

  switch (nodeType) {
    case 'action/write_note': {
      return handleWriteNote(node, context, runtime);
    }

    case 'action/change_status': {
      return handleChangeStatus(node, context, runtime);
    }

    case 'action/send_whatsapp': {
      return {
        kind: 'success',
        output: {
          message_id: `stub_wa_${Date.now()}`,
          status: 'queued_stub',
          template_id: config?.template_id || null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/send_email': {
      return {
        kind: 'success',
        output: {
          message_id: `stub_mail_${Date.now()}`,
          status: 'queued_stub',
          template_id: config?.template_id || null,
          subject: resolveTemplateValue(config?.subject, context) || null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'action/create_task': {
      return handleCreateTask(node, context, runtime);
    }

    case 'action/api_call': {
      return {
        kind: 'success',
        output: {
          status_code: 202,
          response_body: { status: 'stubbed' },
          response_headers: {},
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    case 'delay/fixed': {
      const ms = resolveDurationMs(config?.duration ?? 0, config?.unit || 'seconds');
      const waitUntil = new Date(Date.now() + ms);
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason: 'fixed_delay',
        },
        waiting_meta: {
          type: nodeType,
          next_node_id: readOutputTarget(node, 'on_complete'),
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_until': {
      const waitUntil = parseWaitUntilExpression(config?.datetime_expression, context) || new Date();
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason: 'wait_until',
        },
        waiting_meta: {
          type: nodeType,
          next_node_id: readOutputTarget(node, 'on_complete'),
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_response': {
      const timeoutMs = resolveDurationMs(config?.timeout_duration ?? 60, config?.timeout_unit || 'minutes');
      const waitUntil = timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : null;
      return {
        kind: 'waiting',
        output: {
          waits_for_response: true,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          timeout_at: waitUntil ? waitUntil.toISOString() : null,
        },
        waiting_meta: {
          type: nodeType,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          on_response: readOutputTarget(node, 'on_response'),
          on_timeout: readOutputTarget(node, 'on_timeout'),
        },
        wait_until: waitUntil,
      };
    }

    case 'condition/field_check': {
      const decision = evaluateFieldCheck(config, context);
      return {
        kind: 'success',
        output: {
          decision,
          operator: config?.operator || 'equals',
        },
        next_node_id: decision
          ? readOutputTarget(node, 'on_true')
          : readOutputTarget(node, 'on_false'),
      };
    }

    case 'condition/response_check': {
      const hasResponse = evaluateResponseExists(config, context);
      return {
        kind: 'success',
        output: {
          has_response: hasResponse,
        },
        next_node_id: hasResponse
          ? readOutputTarget(node, 'on_response')
          : readOutputTarget(node, 'on_no_response'),
      };
    }

    default:
      return {
        kind: 'success',
        output: {
          status: 'noop_stub',
          node_type: nodeType,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
  }
}

async function resumeWaitingNode(execution, node, context, { mode, responseText }) {
  const nodeType = cleanString(node?.type) || '';

  if (nodeType === 'delay/wait_response') {
    const useResponse = mode === 'response';
    const nextNode = useResponse
      ? readOutputTarget(node, 'on_response')
      : readOutputTarget(node, 'on_timeout');

    let nextContext = context;
    if (useResponse) {
      nextContext = mergeNodeOutput(nextContext, node.id, {
        response_text: responseText ?? null,
        responded_at: new Date().toISOString(),
      });
    }

    await execution.update({
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context: nextContext,
      last_error: null,
    });

    return { resumed: true, context: nextContext };
  }

  if (nodeType === 'delay/fixed' || nodeType === 'delay/wait_until') {
    const nextNode = readOutputTarget(node, 'on_complete');
    await execution.update({
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context,
      last_error: null,
    });
    return { resumed: true, context };
  }

  await execution.update({
    status: 'running',
    wait_until: null,
    waiting_meta: null,
    last_error: null,
  });

  return { resumed: true, context };
}

async function runExecution(executionId, options = {}) {
  const maxSteps = Number.isInteger(options.maxSteps) ? options.maxSteps : 100;
  const resumeMode = cleanString(options.resumeMode) || null;
  const responseText = options.responseText ?? null;

  const execution = await FlowExecutionV2.findByPk(executionId, {
    include: [{
      model: AutomationFlowTemplateV2,
      as: 'templateVersion',
    }],
  });

  if (!execution) {
    throw new Error('execution_not_found');
  }

  const template = execution.templateVersion;
  if (!template) {
    await execution.update({ status: 'failed', last_error: 'template_version_not_found' });
    return execution;
  }

  const nodes = Array.isArray(template.nodes) ? template.nodes : [];
  const nodeMap = new Map(nodes.map((node) => [cleanString(node?.id), node]));

  let context = clone(execution.context) || {};
  if (!context.outputs || typeof context.outputs !== 'object') {
    context.outputs = {};
  }

  if (execution.status === 'waiting' && resumeMode) {
    if (
      resumeMode === 'timeout'
      && execution.wait_until
      && new Date(execution.wait_until).getTime() > Date.now()
    ) {
      return execution;
    }

    const waitingNodeId = cleanString(execution.current_node_id);
    const waitingNode = waitingNodeId ? nodeMap.get(waitingNodeId) : null;

    if (!waitingNode) {
      await execution.update({ status: 'failed', last_error: 'waiting_node_not_found' });
      return execution;
    }

    const resumeInfo = await resumeWaitingNode(execution, waitingNode, context, {
      mode: resumeMode,
      responseText,
    });

    context = resumeInfo.context;
  }

  let localStatus = execution.status;
  let currentNodeId = cleanString(execution.current_node_id) || cleanString(template.entry_node_id);

  for (let step = 0; step < maxSteps; step += 1) {
    if (localStatus !== 'running') break;

    if (!currentNodeId) {
      await execution.update({
        status: 'completed',
        current_node_id: null,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      });
      localStatus = 'completed';
      break;
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await execution.update({
        status: 'failed',
        current_node_id: null,
        context,
        last_error: `node_not_found:${currentNodeId}`,
      });
      localStatus = 'failed';
      break;
    }

    const startedAt = new Date();
    const log = await FlowExecutionLogV2.create({
      flow_execution_id: execution.id,
      node_id: currentNodeId,
      node_type: cleanString(node.type),
      status: 'running',
      started_at: startedAt,
      audit_snapshot: {
        started_at: startedAt.toISOString(),
      },
    });

    try {
      const result = await processNode(node, context, { execution });
      const finishedAt = new Date();

      if (result.kind === 'waiting') {
        context = mergeNodeOutput(context, currentNodeId, {
          ...(result.output || {}),
          status: 'waiting',
          at: finishedAt.toISOString(),
        });

        await log.update({
          status: 'success',
          finished_at: finishedAt,
          audit_snapshot: {
            kind: 'waiting',
            wait_until: result.wait_until ? result.wait_until.toISOString() : null,
            waiting_meta: result.waiting_meta || null,
          },
        });

        await execution.update({
          status: 'waiting',
          current_node_id: currentNodeId,
          context,
          wait_until: result.wait_until || null,
          waiting_meta: result.waiting_meta || null,
          last_error: null,
        });

        localStatus = 'waiting';
        break;
      }

      context = mergeNodeOutput(context, currentNodeId, {
        ...(result.output || {}),
        status: 'success',
        at: finishedAt.toISOString(),
      });

      const nextNodeId = cleanString(result.next_node_id);

      await log.update({
        status: 'success',
        finished_at: finishedAt,
        audit_snapshot: {
          kind: 'success',
          next_node_id: nextNodeId,
        },
      });

      if (!nextNodeId) {
        await execution.update({
          status: 'completed',
          current_node_id: null,
          context,
          wait_until: null,
          waiting_meta: null,
          last_error: null,
        });
        localStatus = 'completed';
        break;
      }

      currentNodeId = nextNodeId;
      await execution.update({
        status: 'running',
        current_node_id: currentNodeId,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      });
    } catch (error) {
      const finishedAt = new Date();
      const errorMessage = cleanString(error?.message) || 'node_execution_error';
      const onFailNode = readOutputTarget(node, 'on_fail');

      context = mergeNodeOutput(context, currentNodeId, {
        status: 'error',
        error_message: errorMessage,
        at: finishedAt.toISOString(),
      });

      await log.update({
        status: 'error',
        finished_at: finishedAt,
        error_message: errorMessage,
        audit_snapshot: {
          kind: 'error',
          on_fail: onFailNode,
        },
      });

      if (onFailNode) {
        currentNodeId = onFailNode;
        await execution.update({
          status: 'running',
          current_node_id: currentNodeId,
          context,
          last_error: errorMessage,
        });
      } else {
        await execution.update({
          status: 'failed',
          current_node_id: null,
          context,
          last_error: errorMessage,
        });
        localStatus = 'failed';
        break;
      }
    }
  }

  if (localStatus === 'running') {
    await execution.update({
      status: 'dead_letter',
      last_error: 'max_steps_exceeded',
      context,
    });
  }

  await execution.reload();
  return execution;
}

module.exports = {
  runExecution,
};
