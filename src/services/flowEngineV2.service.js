'use strict';

const { Op } = require('sequelize');
const axios = require('axios');
const db = require('../../models');
const { getIO } = require('./socket.service');
const { queues } = require('./queue.service');
const { normalizeCitaStatus, normalizeLeadStatus } = require('../lib/status-catalog');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const Conversation = db.Conversation;
const Message = db.Message;
const Notification = db.Notification;
const UsuarioClinica = db.UsuarioClinica;
const Clinica = db.Clinica;
const ClinicMetaAsset = db.ClinicMetaAsset;
const WhatsappTemplate = db.WhatsappTemplate;
const whatsappService = require('./whatsapp.service');
const UPDATE_LEAD_INFO_MODES = new Set([
  'set_required',
  'set_received',
  'append_received',
  'clear_required',
  'clear_received',
  'clear_all',
]);
const AI_FIELD_TYPES = new Set(['string', 'number', 'boolean']);
const AI_ANALYSIS_MODES = new Set(['auto', 'quick_qa', 'complex_reasoning']);
const FIELD_CHECK_LEFT_REF_SOURCES = new Set(['node_output', 'trigger_data', 'context', 'manual']);
const FIELD_CHECK_VALUE_TYPES = new Set(['string', 'number', 'boolean']);
const FIELD_CHECK_OPERATOR_TYPE_COMPAT = {
  string: ['equals', 'not_equals', 'contains', 'exists'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'exists'],
  boolean: ['equals', 'not_equals', 'exists'],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function appendMultilineText(baseText, nextText) {
  const base = cleanString(baseText);
  const next = cleanString(nextText);
  if (!next) return base || '';
  if (!base) return next;
  return `${base}\n${next}`;
}

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function formatAutomationTimestamp(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date).replace(',', '');
  } catch (_err) {
    return date.toISOString();
  }
}

function formatDateEs(rawDate) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function formatTimeEs(rawDate) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function extractWhatsappTemplateBodyText(template) {
  const components = Array.isArray(template?.components) ? template.components : [];
  const bodyParts = components
    .filter((comp) => String(comp?.type || '').toUpperCase() === 'BODY')
    .map((comp) => cleanString(comp?.text))
    .filter(Boolean);

  if (bodyParts.length) {
    return bodyParts.join('\n');
  }

  return null;
}

function renderWhatsappTemplatePreviewText(template, templateParams = {}) {
  const rawText = extractWhatsappTemplateBodyText(template);
  if (!rawText) {
    return `[Plantilla WhatsApp] ${cleanString(template?.name) || 'Sin nombre'}`;
  }

  return rawText.replace(/{{\s*(\d+)\s*}}/g, (_match, idx) => {
    const key = String(idx);
    const value = cleanString(templateParams?.[key]);
    return value || `{{${key}}}`;
  });
}

function getMadridDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type) => Number(parts.find((part) => part.type === type)?.value || '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function buildDateFromMadridParts(parts) {
  const desired = {
    year: Number(parts?.year),
    month: Number(parts?.month),
    day: Number(parts?.day),
    hour: Number(parts?.hour || 0),
    minute: Number(parts?.minute || 0),
    second: Number(parts?.second || 0),
  };

  const guess = new Date(Date.UTC(
    desired.year,
    Math.max(0, desired.month - 1),
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  ));

  const actual = getMadridDateParts(guess);
  const desiredMinutes = Date.UTC(
    desired.year,
    Math.max(0, desired.month - 1),
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  ) / 60000;
  const actualMinutes = Date.UTC(
    actual.year,
    Math.max(0, actual.month - 1),
    actual.day,
    actual.hour,
    actual.minute,
    actual.second
  ) / 60000;

  return new Date(guess.getTime() + ((desiredMinutes - actualMinutes) * 60000));
}

function addMadridDays(parts, days) {
  const utcAnchor = new Date(Date.UTC(parts.year, Math.max(0, parts.month - 1), parts.day + days, 12, 0, 0));
  return getMadridDateParts(utcAnchor);
}

function isHourWithinQuietWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

function computeQuietHoursDelayMs({
  now = new Date(),
  enabled = true,
  startHour = 22,
  endHour = 7,
}) {
  if (!enabled) {
    return { delayMs: 0, scheduledAt: null };
  }

  const madridNow = getMadridDateParts(now);
  const inQuietWindow = isHourWithinQuietWindow(madridNow.hour, startHour, endHour);
  if (!inQuietWindow) {
    return { delayMs: 0, scheduledAt: null };
  }

  const targetBase = madridNow.hour >= startHour
    ? addMadridDays(madridNow, 1)
    : madridNow;
  const scheduledAt = buildDateFromMadridParts({
    ...targetBase,
    hour: endHour,
    minute: 0,
    second: 0,
  });
  const delayMs = Math.max(0, scheduledAt.getTime() - now.getTime());

  return { delayMs, scheduledAt };
}

function emitMessageCreatedToConversationRooms(conversation, message) {
  const io = getIO();
  if (!io || !conversation || !message) return;

  const rooms = new Set();
  if (conversation.clinic_id) rooms.add(`clinic:${conversation.clinic_id}`);
  if (conversation.assignee_id) rooms.add(`user:${conversation.assignee_id}`);

  const payload = {
    id: message.id,
    conversation_id: String(conversation.id),
    content: message.content,
    direction: message.direction,
    message_type: message.message_type,
    status: message.status,
    sent_at: message.sent_at,
    metadata: message.metadata || null,
  };

  if (rooms.size === 0) {
    io.emit('message:created', payload);
    return;
  }

  rooms.forEach((room) => io.to(room).emit('message:created', payload));
}

function buildDisplayName(...parts) {
  return parts
    .map((part) => cleanString(part))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function mergeContextObject(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base || {};
  if (!base || typeof base !== 'object' || Array.isArray(base)) return clone(patch) || {};
  return {
    ...base,
    ...patch,
  };
}

async function enrichContextForTemplateResolution(context, targets = {}) {
  const out = clone(context) || {};
  const appointmentId = toIntOrNull(targets.appointment_id);
  const patientId = toIntOrNull(targets.patient_id);
  const clinicId = toIntOrNull(targets.clinic_id);
  const leadIntakeId = toIntOrNull(targets.lead_intake_id);

  if (appointmentId) {
    const appointment = await CitaPaciente.findByPk(appointmentId, {
      attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'estado', 'inicio', 'fin', 'titulo', 'motivo'],
      raw: true,
    });
    if (appointment) {
      const appointmentPatch = {
        id: toIntOrNull(appointment.id_cita),
        id_cita: toIntOrNull(appointment.id_cita),
        clinic_id: toIntOrNull(appointment.clinica_id),
        clinica_id: toIntOrNull(appointment.clinica_id),
        patient_id: toIntOrNull(appointment.paciente_id),
        paciente_id: toIntOrNull(appointment.paciente_id),
        lead_intake_id: toIntOrNull(appointment.lead_intake_id),
        estado: cleanString(appointment.estado),
        status: cleanString(appointment.estado),
        inicio: appointment.inicio || null,
        fin: appointment.fin || null,
        fecha: formatDateEs(appointment.inicio),
        hora: formatTimeEs(appointment.inicio),
        titulo: cleanString(appointment.titulo),
        motivo: cleanString(appointment.motivo),
      };

      out.appointment = mergeContextObject(out.appointment, appointmentPatch);
      out.cita = mergeContextObject(out.cita, {
        ...appointmentPatch,
      });
    }
  }

  const effectivePatientId = patientId
    || toIntOrNull(out?.appointment?.paciente_id)
    || toIntOrNull(out?.cita?.paciente_id)
    || toIntOrNull(out?.trigger?.data?.paciente_id)
    || toIntOrNull(out?.trigger?.data?.patient_id);

  if (effectivePatientId) {
    const patient = await db.Paciente.findByPk(effectivePatientId, {
      attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'],
      raw: true,
    });
    if (patient) {
      const fullName = buildDisplayName(patient.nombre, patient.apellidos);
      const patientPatch = {
        id: toIntOrNull(patient.id_paciente),
        id_paciente: toIntOrNull(patient.id_paciente),
        clinic_id: toIntOrNull(patient.clinica_id),
        clinica_id: toIntOrNull(patient.clinica_id),
        nombre: cleanString(patient.nombre),
        apellidos: cleanString(patient.apellidos),
        nombre_completo: fullName || null,
        telefono: cleanString(patient.telefono_movil),
        telefono_movil: cleanString(patient.telefono_movil),
        email: cleanString(patient.email),
      };
      out.patient = mergeContextObject(out.patient, patientPatch);
      out.paciente = mergeContextObject(out.paciente, {
        ...patientPatch,
      });
    }
  }

  const effectiveClinicId = clinicId
    || toIntOrNull(out?.appointment?.clinica_id)
    || toIntOrNull(out?.cita?.clinica_id)
    || toIntOrNull(out?.patient?.clinica_id)
    || toIntOrNull(out?.paciente?.clinica_id)
    || toIntOrNull(out?.trigger?.data?.clinica_id)
    || toIntOrNull(out?.trigger?.data?.clinic_id);

  if (effectiveClinicId) {
    const clinic = await Clinica.findByPk(effectiveClinicId, {
      attributes: ['id_clinica', 'nombre_clinica'],
      raw: true,
    });
    if (clinic) {
      const clinicPatch = {
        id: toIntOrNull(clinic.id_clinica),
        id_clinica: toIntOrNull(clinic.id_clinica),
        clinic_id: toIntOrNull(clinic.id_clinica),
        clinica_id: toIntOrNull(clinic.id_clinica),
        nombre: cleanString(clinic.nombre_clinica),
        nombre_clinica: cleanString(clinic.nombre_clinica),
      };
      out.clinic = mergeContextObject(out.clinic, clinicPatch);
      out.clinica = mergeContextObject(out.clinica, {
        ...clinicPatch,
      });
    }
  }

  const effectiveLeadIntakeId = leadIntakeId
    || toIntOrNull(out?.appointment?.lead_intake_id)
    || toIntOrNull(out?.cita?.lead_intake_id)
    || toIntOrNull(out?.trigger?.data?.lead_intake_id)
    || toIntOrNull(out?.trigger?.data?.lead_id);

  if (effectiveLeadIntakeId) {
    const lead = await LeadIntake.findByPk(effectiveLeadIntakeId, {
      attributes: ['id', 'clinica_id', 'nombre', 'telefono', 'email', 'status_lead'],
      raw: true,
    });
    if (lead) {
      const leadPatch = {
        id: toIntOrNull(lead.id),
        lead_intake_id: toIntOrNull(lead.id),
        clinica_id: toIntOrNull(lead.clinica_id),
        clinic_id: toIntOrNull(lead.clinica_id),
        nombre: cleanString(lead.nombre),
        telefono: cleanString(lead.telefono),
        email: cleanString(lead.email),
        status: cleanString(lead.status_lead),
        status_lead: cleanString(lead.status_lead),
      };
      out.lead = mergeContextObject(out.lead, leadPatch);
    }
  }

  if (!out.trigger || typeof out.trigger !== 'object') {
    out.trigger = {};
  }
  if (!out.trigger.data || typeof out.trigger.data !== 'object') {
    out.trigger.data = {};
  }
  out.trigger.data = {
    ...(out.trigger.data || {}),
    appointment_id: toIntOrNull(out?.appointment?.id_cita) || toIntOrNull(out?.cita?.id_cita) || null,
    cita_id: toIntOrNull(out?.appointment?.id_cita) || toIntOrNull(out?.cita?.id_cita) || null,
    patient_id: toIntOrNull(out?.patient?.id_paciente) || toIntOrNull(out?.paciente?.id_paciente) || null,
    paciente_id: toIntOrNull(out?.patient?.id_paciente) || toIntOrNull(out?.paciente?.id_paciente) || null,
    clinic_id: toIntOrNull(out?.clinic?.id_clinica) || toIntOrNull(out?.clinica?.id_clinica) || null,
    clinica_id: toIntOrNull(out?.clinic?.id_clinica) || toIntOrNull(out?.clinica?.id_clinica) || null,
    lead_intake_id: toIntOrNull(out?.lead?.id) || null,
    lead_id: toIntOrNull(out?.lead?.id) || null,
  };

  return out;
}

function buildExecutionSocketPayload(execution, extra = {}) {
  const template = execution?.templateVersion || null;
  const payload = {
    execution_id: toIntOrNull(execution?.id),
    template_version_id: toIntOrNull(execution?.template_version_id),
    status: cleanString(execution?.status) || null,
    current_node_id: cleanString(execution?.current_node_id),
    wait_until: execution?.wait_until || null,
    last_error: cleanString(execution?.last_error),
    trigger_type: cleanString(execution?.trigger_type),
    trigger_entity_type: cleanString(execution?.trigger_entity_type),
    trigger_entity_id: toIntOrNull(execution?.trigger_entity_id),
    clinic_id: toIntOrNull(execution?.clinic_id),
    group_id: toIntOrNull(execution?.group_id),
    updated_at: execution?.updated_at || new Date().toISOString(),
  };

  if (template) {
    payload.template = {
      id: toIntOrNull(template.id),
      template_key: cleanString(template.template_key),
      version: toIntOrNull(template.version),
      name: cleanString(template.name),
      trigger_type: cleanString(template.trigger_type),
    };
  }

  return { ...payload, ...extra };
}

function emitExecutionEvent(execution, eventName = 'flow_execution:updated', extra = {}) {
  const io = getIO();
  if (!io) return;
  const payload = buildExecutionSocketPayload(execution, extra);
  const clinicId = toIntOrNull(payload.clinic_id);
  if (clinicId) {
    io.to(`clinic:${clinicId}`).emit(eventName, payload);
    return;
  }
  io.emit(eventName, payload);
}

function emitExecutionLogEvent(execution, log, extra = {}) {
  const io = getIO();
  if (!io) return;

  const payload = {
    execution_id: toIntOrNull(execution?.id),
    clinic_id: toIntOrNull(execution?.clinic_id),
    group_id: toIntOrNull(execution?.group_id),
    log: {
      id: toIntOrNull(log?.id),
      node_id: cleanString(log?.node_id),
      node_type: cleanString(log?.node_type),
      status: cleanString(log?.status),
      error_message: cleanString(log?.error_message),
      started_at: log?.started_at || null,
      finished_at: log?.finished_at || null,
      audit_snapshot: log?.audit_snapshot ?? null,
    },
    ...extra,
  };

  const clinicId = toIntOrNull(payload.clinic_id);
  if (clinicId) {
    io.to(`clinic:${clinicId}`).emit('flow_execution:log', payload);
    return;
  }
  io.emit('flow_execution:log', payload);
}

async function updateExecutionAndEmit(execution, patch, eventName = 'flow_execution:updated', extra = {}) {
  await execution.update(patch);
  emitExecutionEvent(execution, eventName, extra);
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

  // Interpolación inline: permite mezclar texto libre con múltiples {{variables}}.
  // Ejemplo:
  // "Mensaje: {{context.last_prompt}}\nRespuesta: {{context.last_response}}"
  if (value.includes('{{') && value.includes('}}')) {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, pathExpr) => {
      const resolved = getByPath(context, pathExpr);
      if (resolved === undefined || resolved === null) return '';
      if (typeof resolved === 'object') {
        try {
          return JSON.stringify(resolved);
        } catch (_err) {
          return '';
        }
      }
      return String(resolved);
    });
  }

  return value;
}

function normalizeAiAnalysisMode(rawMode) {
  const mode = cleanString(rawMode) || 'auto';
  if (AI_ANALYSIS_MODES.has(mode)) {
    return mode;
  }
  return 'auto';
}

function normalizeOutputFieldEntries(rawFields) {
  const parsed = typeof rawFields === 'string'
    ? (() => {
        try { return JSON.parse(rawFields); } catch (_err) { return null; }
      })()
    : rawFields;
  const fields = Array.isArray(parsed) ? parsed : [];

  return fields
    .map((field) => {
      const name = cleanString(field?.name);
      const typeRaw = cleanString(field?.type) || 'string';
      const type = AI_FIELD_TYPES.has(typeRaw) ? typeRaw : 'string';
      const description = cleanString(field?.description) || '';
      if (!name) return null;
      return { name, type, description };
    })
    .filter(Boolean);
}

function normalizeOutputFieldsToFormat(rawFields) {
  const out = {};
  const fields = normalizeOutputFieldEntries(rawFields);
  for (const field of fields) {
    out[field.name] = { type: field.type };
  }
  return out;
}

function normalizeAiOutputFormat(rawFormat) {
  let parsed = rawFormat;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (_err) {
      parsed = null;
    }
  }

  const out = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [rawKey, rawDef] of Object.entries(parsed)) {
      const key = cleanString(rawKey);
      const rawType = typeof rawDef === 'string' ? rawDef : rawDef?.type;
      const type = cleanString(rawType);
      if (!key) continue;
      out[key] = AI_FIELD_TYPES.has(type || '') ? type : 'string';
    }
  }

  if (!Object.keys(out).length) {
    out.decision = 'string';
    out.motivo = 'string';
  }

  return out;
}

function parseAiJsonContent(rawContent) {
  if (rawContent && typeof rawContent === 'object' && !Array.isArray(rawContent)) {
    return rawContent;
  }
  const content = cleanString(rawContent);
  if (!content) return null;

  const directCandidate = content
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(directCandidate);
  } catch (_err) {
    // Try extracting the first JSON object block.
  }

  const firstBrace = directCandidate.indexOf('{');
  const lastBrace = directCandidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const objectCandidate = directCandidate.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(objectCandidate);
    } catch (_err) {
      return null;
    }
  }

  return null;
}

function coerceAiOutputByFormat(rawOutput, outputFormat) {
  const output = {};
  const source = rawOutput && typeof rawOutput === 'object' ? rawOutput : {};
  for (const [key, type] of Object.entries(outputFormat || {})) {
    const value = source[key];
    if (type === 'number') {
      const parsed = Number(value);
      output[key] = Number.isFinite(parsed) ? parsed : 0;
      continue;
    }
    if (type === 'boolean') {
      output[key] = parseBool(value, false);
      continue;
    }
    output[key] = cleanString(value) || '';
  }
  return output;
}

function pickGroqModel({ analysisMode, prompt, inputText, outputFormat }) {
  const fastModel = cleanString(process.env.GROQ_MODEL_FAST) || 'llama-3.1-8b-instant';
  const complexModel = cleanString(process.env.GROQ_MODEL_COMPLEX) || 'llama-3.1-70b-versatile';

  if (analysisMode === 'quick_qa') return fastModel;
  if (analysisMode === 'complex_reasoning') return complexModel;

  const totalChars = String(prompt || '').length + String(inputText || '').length;
  const outputFields = Object.keys(outputFormat || {}).length;
  const complexityKeywords = /cita|appointment|historial|database|base de datos|sql|clasifica|analiza|resume|extrae|diagnost/i;
  const joined = `${prompt || ''} ${inputText || ''}`;
  const isComplex = totalChars > 900 || outputFields > 3 || complexityKeywords.test(joined);
  return isComplex ? complexModel : fastModel;
}

function buildAiSystemPrompt(outputFormat, outputFields = []) {
  const hasFieldDescriptions = Array.isArray(outputFields) && outputFields.length > 0;
  const fields = hasFieldDescriptions
    ? outputFields
      .map((field) => {
        if (!field?.name) return null;
        const desc = cleanString(field.description);
        return desc
          ? `- ${field.name} (${field.type}): ${desc}`
          : `- ${field.name} (${field.type})`;
      })
      .filter(Boolean)
      .join('\n')
    : Object.entries(outputFormat || {})
      .map(([key, type]) => `- ${key} (${type})`)
      .join('\n');

  return [
    'Eres un motor de análisis para automatizaciones clínicas.',
    'Responde exclusivamente con JSON válido, sin markdown ni texto adicional.',
    'Debes devolver exactamente los campos indicados con sus tipos.',
    'Si no dispones de un dato, devuelve un valor vacío válido para su tipo.',
    'Campos esperados:',
    fields || '- decision: string',
  ].join('\n');
}

function buildAiSimulatedOutput(outputFormat, analysisMode, model) {
  const base = {};
  for (const [key, type] of Object.entries(outputFormat || {})) {
    if (type === 'number') {
      base[key] = 0;
      continue;
    }
    if (type === 'boolean') {
      base[key] = false;
      continue;
    }
    base[key] = key === 'decision' ? 'simulado' : '';
  }
  return {
    ...base,
    _ai_provider: 'groq',
    _ai_model: model,
    _ai_analysis_mode: analysisMode,
    _ai_simulated: true,
  };
}

async function runGroqAiAnalysis({ prompt, inputText, outputFormat, outputFields, analysisMode, maxTokens }) {
  const apiKey = cleanString(process.env.GROQ_API_KEY);
  if (!apiKey) {
    throw new Error('groq_api_key_not_configured');
  }

  const baseUrl = (cleanString(process.env.GROQ_API_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const timeoutMs = Math.max(1000, Number.parseInt(String(process.env.GROQ_TIMEOUT_MS || '20000'), 10) || 20000);
  const normalizedMode = normalizeAiAnalysisMode(analysisMode);
  const normalizedFormat = normalizeAiOutputFormat(outputFormat);
  const normalizedOutputFields = normalizeOutputFieldEntries(outputFields);
  const model = pickGroqModel({
    analysisMode: normalizedMode,
    prompt,
    inputText,
    outputFormat: normalizedFormat,
  });

  const resolvedMaxTokens = Number(maxTokens);
  const finalMaxTokens = Number.isFinite(resolvedMaxTokens) && resolvedMaxTokens > 0
    ? Math.min(4096, Math.floor(resolvedMaxTokens))
    : 700;

  let response;
  try {
    response = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0.1,
        max_tokens: finalMaxTokens,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: buildAiSystemPrompt(normalizedFormat, normalizedOutputFields),
          },
          {
            role: 'user',
            content: `Instrucción:\n${prompt}\n\nTexto a analizar:\n${inputText}`,
          },
        ],
      },
      {
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    const statusCode = err?.response?.status;
    const providerMessage = cleanString(
      err?.response?.data?.error?.message
      || err?.response?.data?.message
      || err?.message
    ) || 'groq_request_failed';
    throw new Error(`groq_request_failed:${statusCode || 'network'}:${providerMessage}`);
  }

  const rawContent = response?.data?.choices?.[0]?.message?.content;
  const parsedJson = parseAiJsonContent(rawContent);
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
    throw new Error('groq_invalid_json_response');
  }

  const coercedOutput = coerceAiOutputByFormat(parsedJson, normalizedFormat);
  return {
    ...coercedOutput,
    _ai_provider: 'groq',
    _ai_model: model,
    _ai_analysis_mode: normalizedMode,
    _ai_usage: response?.data?.usage || null,
  };
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

async function backfillRuntimeTargets(execution, targets = {}) {
  const out = { ...(targets || {}) };
  const triggerType = normalizeKey(execution?.trigger_entity_type);
  const triggerEntityId = toIntOrNull(execution?.trigger_entity_id);

  const hydrateFromAppointment = async (appointmentId) => {
    if (!appointmentId) return;
    const appointment = await CitaPaciente.findByPk(appointmentId, {
      attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id'],
      raw: true,
    });
    if (!appointment) return;
    out.appointment_id = out.appointment_id || toIntOrNull(appointment.id_cita);
    out.clinic_id = out.clinic_id || toIntOrNull(appointment.clinica_id);
    out.patient_id = out.patient_id || toIntOrNull(appointment.paciente_id);
    out.lead_intake_id = out.lead_intake_id || toIntOrNull(appointment.lead_intake_id);
  };

  if (out.appointment_id && (!out.clinic_id || !out.patient_id || !out.lead_intake_id)) {
    await hydrateFromAppointment(out.appointment_id);
  }

  if (triggerEntityId) {
    if (['appointment', 'appointment_created', 'cita', 'cita_creada'].includes(triggerType)) {
      out.appointment_id = out.appointment_id || triggerEntityId;
      await hydrateFromAppointment(out.appointment_id);
    } else if (['patient', 'paciente'].includes(triggerType)) {
      const patient = await db.Paciente.findByPk(triggerEntityId, {
        attributes: ['id_paciente', 'clinica_id'],
        raw: true,
      });
      if (patient) {
        out.patient_id = out.patient_id || toIntOrNull(patient.id_paciente);
        out.clinic_id = out.clinic_id || toIntOrNull(patient.clinica_id);
      }
    } else if (['lead', 'lead_intake', 'leadintake', 'lead_nuevo'].includes(triggerType)) {
      const lead = await LeadIntake.findByPk(triggerEntityId, {
        attributes: ['id', 'clinica_id'],
        raw: true,
      });
      if (lead) {
        out.lead_intake_id = out.lead_intake_id || toIntOrNull(lead.id);
        out.clinic_id = out.clinic_id || toIntOrNull(lead.clinica_id);
      }
    } else if (['conversation', 'chat_conversation', 'whatsapp_conversation'].includes(triggerType)) {
      const conversation = await Conversation.findByPk(triggerEntityId, {
        attributes: ['id', 'clinic_id', 'patient_id'],
        raw: true,
      });
      if (conversation) {
        out.conversation_id = out.conversation_id || toIntOrNull(conversation.id);
        out.clinic_id = out.clinic_id || toIntOrNull(conversation.clinic_id);
        out.patient_id = out.patient_id || toIntOrNull(conversation.patient_id);
      }
    }
  }

  out.clinic_id = out.clinic_id || toIntOrNull(execution?.clinic_id);
  return out;
}

function normalizeStatusTarget(value) {
  const key = normalizeKey(value);
  if (!key) return null;
  if (['appointment', 'cita'].includes(key)) return 'appointment';
  if (key === 'lead') return 'lead';
  return null;
}

function normalizeRecipientMode(value) {
  const normalized = normalizeKey(value);
  if (['manual_number', 'manualnumber', 'manual'].includes(normalized)) return 'manual_number';
  if (['context_lead', 'lead', 'lead_phone', 'leadphone'].includes(normalized)) return 'context_lead';
  if (['context_patient', 'patient', 'flow_phone', 'patient_phone', 'flowphone', 'patientphone'].includes(normalized)) {
    return 'context_patient';
  }
  return 'context_patient';
}

function toLowerSafe(value) {
  return String(value || '').trim().toLowerCase();
}

function isTemplateBlockedForSend(statusValue) {
  const status = toLowerSafe(statusValue);
  if (!status) return false;
  return ['rejected', 'disabled', 'deleted', 'archived'].includes(status);
}

function normalizeStringArray(value) {
  if (value === undefined || value === null) return [];

  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value
          .map((item) => cleanString(item))
          .filter(Boolean)
      )
    );
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return Array.from(
            new Set(
              parsed
                .map((item) => cleanString(item))
                .filter(Boolean)
            )
          );
        }
      } catch (_err) {
        // Fall through to comma parsing below.
      }
    }

    return Array.from(
      new Set(
        trimmed
          .split(',')
          .map((item) => cleanString(item))
          .filter(Boolean)
      )
    );
  }

  return [];
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

  const appointmentStatus = normalizeCitaStatus(rawStatus);
  const leadStatus = normalizeLeadStatus(rawStatus);
  const requestedTarget = normalizeStatusTarget(resolveTemplateValue(config?.target_entity, context));
  const agendaIcon = cleanString(resolveTemplateValue(config?.agenda_icon, context));
  const now = new Date().toISOString();

  const canUpdateAppointment = requestedTarget ? requestedTarget === 'appointment' : !!targets.appointment_id;
  const canUpdateLead = requestedTarget ? requestedTarget === 'lead' : !!targets.lead_intake_id;

  if (canUpdateAppointment) {
    if (!targets.appointment_id) {
      throw new Error('change_status_target_not_found:appointment');
    }
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
        target_entity: 'appointment',
        previous_status: previousStatus,
        new_status: appointmentStatus,
        agenda_icon: agendaIcon,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  if (canUpdateLead) {
    if (!targets.lead_intake_id) {
      throw new Error('change_status_target_not_found:lead');
    }
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
        target_entity: 'lead',
        previous_status: previousStatus,
        new_status: leadStatus,
        agenda_icon: null,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  throw new Error(`change_status_target_not_found${requestedTarget ? `:${requestedTarget}` : ''}`);
}

async function handleUpdateLeadInfo(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const explicitLeadId = toIntOrNull(resolveTemplateValue(config?.lead_id, context));
  const leadId = explicitLeadId || targets.lead_intake_id;
  if (!leadId) {
    throw new Error('update_lead_info_target_not_found:lead');
  }

  const lead = await LeadIntake.findByPk(leadId);
  if (!lead) {
    throw new Error(`lead_not_found:${leadId}`);
  }

  const mode = cleanString(resolveTemplateValue(config?.mode, context)) || 'set_required';
  if (!UPDATE_LEAD_INFO_MODES.has(mode)) {
    throw new Error(`update_lead_info_invalid_mode:${mode}`);
  }

  const inputRequired = normalizeStringArray(resolveTemplateValue(config?.info_requerida, context));
  const inputReceived = normalizeStringArray(resolveTemplateValue(config?.info_recibida_items, context));
  const autoTransition = parseBool(resolveTemplateValue(config?.auto_transition, context), true);

  const waitingStatus = normalizeLeadStatus(
    resolveTemplateValue(config?.status_when_waiting, context) || 'esperando_info'
  ) || 'esperando_info';
  const completeStatus = normalizeLeadStatus(
    resolveTemplateValue(config?.status_when_complete, context) || 'info_recibida'
  ) || 'info_recibida';

  const previousRequired = normalizeStringArray(lead.info_requerida);
  const previousReceived = normalizeStringArray(lead.info_recibida_items);
  const previousStatus = cleanString(lead.status_lead);

  let nextRequired = [...previousRequired];
  let nextReceived = [...previousReceived];

  switch (mode) {
    case 'set_required':
      nextRequired = inputRequired;
      break;
    case 'set_received':
      nextReceived = inputReceived;
      break;
    case 'append_received':
      nextReceived = normalizeStringArray([...previousReceived, ...inputReceived]);
      break;
    case 'clear_required':
      nextRequired = [];
      break;
    case 'clear_received':
      nextReceived = [];
      break;
    case 'clear_all':
      nextRequired = [];
      nextReceived = [];
      break;
    default:
      break;
  }

  let nextStatus = previousStatus;
  const clearMode = mode.startsWith('clear_');
  if (autoTransition && !clearMode) {
    const hasRequired = nextRequired.length > 0;
    const hasAllRequired = hasRequired && nextRequired.every((item) => nextReceived.includes(item));
    if (hasRequired) {
      nextStatus = hasAllRequired ? completeStatus : waitingStatus;
    } else if (nextReceived.length > 0) {
      nextStatus = completeStatus;
    }
  }

  const updatePayload = {
    info_requerida: nextRequired,
    info_recibida_items: nextReceived,
  };
  if (nextStatus && nextStatus !== previousStatus) {
    updatePayload.status_lead = nextStatus;
  }
  await lead.update(updatePayload);

  return {
    kind: 'success',
    output: {
      target_type: 'lead',
      target_id: lead.id,
      mode,
      auto_transition: autoTransition,
      previous_status: previousStatus,
      new_status: cleanString(lead.status_lead),
      previous_info_requerida: previousRequired,
      new_info_requerida: nextRequired,
      previous_info_recibida_items: previousReceived,
      new_info_recibida_items: nextReceived,
    },
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

async function handleWriteNote(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const contentValue = resolveTemplateValue(config?.content, context);
  const content = cleanString(contentValue);
  if (!content) {
    throw new Error('write_note_empty_content');
  }

  const timestamp = formatAutomationTimestamp(new Date());
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

async function resolveWhatsAppRecipient({ node, config, context, targets }) {
  const recipientMode = normalizeRecipientMode(resolveTemplateValue(config?.recipient_mode, context));
  let rawRecipient = null;

  if (recipientMode === 'manual_number') {
    rawRecipient =
      resolveTemplateValue(config?.recipient_to, context) ||
      resolveTemplateValue(config?.to, context) ||
      null;
  } else if (recipientMode === 'context_lead') {
    rawRecipient =
      resolveTemplateValue('{{lead.telefono}}', context) ||
      resolveTemplateValue(config?.phone_field, context) ||
      null;

    if (!rawRecipient && targets.lead_intake_id) {
      const lead = await LeadIntake.findByPk(targets.lead_intake_id, {
        attributes: ['telefono'],
      });
      rawRecipient = lead?.telefono || null;
    }
  } else {
    rawRecipient =
      resolveTemplateValue('{{paciente.telefono}}', context) ||
      resolveTemplateValue(config?.phone_field, context) ||
      null;

    if (!rawRecipient && targets.patient_id) {
      const patient = await db.Paciente.findByPk(targets.patient_id, {
        attributes: ['telefono_movil'],
      });
      rawRecipient = patient?.telefono_movil || null;
    }
  }

  const normalizedRecipient = whatsappService.normalizePhoneNumber(rawRecipient);
  if (!normalizedRecipient) {
    throw new Error('whatsapp_recipient_not_found');
  }

  return {
    recipient_mode: recipientMode,
    raw_recipient: cleanString(rawRecipient),
    recipient: normalizedRecipient,
  };
}

async function resolveSpecificSenderConfig({ senderOriginId, clinicId }) {
  const originId = toIntOrNull(senderOriginId);
  if (!originId) {
    throw new Error('whatsapp_sender_origin_missing');
  }

  const origin = await ClinicMetaAsset.findByPk(originId, {
    attributes: [
      'id',
      'assetType',
      'isActive',
      'assignmentScope',
      'clinicaId',
      'grupoClinicaId',
      'phoneNumberId',
      'waAccessToken',
      'wabaId',
      'additionalData',
      'metaAssetName',
    ],
  });

  if (!origin || origin.assetType !== 'whatsapp_phone_number' || !origin.isActive) {
    throw new Error('whatsapp_sender_origin_not_found');
  }

  let allowed = false;
  if (origin.assignmentScope === 'clinic') {
    allowed = !!clinicId && Number(origin.clinicaId) === Number(clinicId);
  } else if (origin.assignmentScope === 'group') {
    const clinic = clinicId
      ? await Clinica.findOne({
          where: { id_clinica: clinicId },
          attributes: ['grupoClinicaId'],
          raw: true,
        })
      : null;
    allowed = !!clinic?.grupoClinicaId && Number(clinic.grupoClinicaId) === Number(origin.grupoClinicaId);
  } else {
    allowed = !!clinicId && Number(origin.clinicaId) === Number(clinicId);
  }

  if (!allowed) {
    throw new Error('whatsapp_sender_origin_scope_mismatch');
  }

  return {
    phoneNumberId: cleanString(origin.phoneNumberId),
    accessToken: cleanString(origin.waAccessToken),
    wabaId: cleanString(origin.wabaId),
    assignmentScope: cleanString(origin.assignmentScope),
    clinicaId: toIntOrNull(origin.clinicaId) || clinicId || null,
    grupoClinicaId: toIntOrNull(origin.grupoClinicaId),
    additionalData: origin.additionalData || {},
    originLabel: cleanString(origin.metaAssetName),
    originId: origin.id,
  };
}

async function resolveWhatsAppSenderConfig({ config, context, clinicId }) {
  const senderMode = toLowerSafe(resolveTemplateValue(config?.sender_mode, context)) || 'clinic_default';
  if (senderMode === 'specific_origin') {
    const senderOriginId = toIntOrNull(resolveTemplateValue(config?.sender_origin_id, context));
    const specific = await resolveSpecificSenderConfig({
      senderOriginId,
      clinicId,
    });
    if (!specific?.accessToken || !specific?.phoneNumberId) {
      throw new Error('whatsapp_sender_origin_missing_credentials');
    }
    return {
      sender_mode: 'specific_origin',
      sender_origin_id: specific.originId,
      clinic_config: specific,
    };
  }

  const clinicConfig = await whatsappService.getClinicConfig(clinicId);
  if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
    throw new Error('whatsapp_config_missing');
  }

  return {
    sender_mode: 'clinic_default',
    sender_origin_id: null,
    clinic_config: clinicConfig,
  };
}

function resolveTemplateVariables(config, context) {
  const raw = config?.variables;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    const resolved = resolveTemplateValue(value, context);
    if (resolved === undefined || resolved === null || resolved === '') continue;
    output[key] = String(resolved);
  }
  return output;
}

async function handleSendWhatsapp(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const execution = runtime?.execution || null;
  let targets = resolveRuntimeTargets(execution, context);
  targets = await backfillRuntimeTargets(execution, targets);
  const clinicId = toIntOrNull(targets.clinic_id);
  if (!clinicId) {
    throw new Error('whatsapp_clinic_not_found');
  }

  const templateId = toIntOrNull(resolveTemplateValue(config?.template_id, context));
  if (!templateId) {
    throw new Error('whatsapp_template_id_missing');
  }

  const template = await WhatsappTemplate.findByPk(templateId, {
    attributes: ['id', 'name', 'language', 'status', 'components'],
  });
  if (!template) {
    throw new Error(`whatsapp_template_not_found:${templateId}`);
  }

  const templateStatus = toLowerSafe(template.status);
  if (isTemplateBlockedForSend(templateStatus)) {
    throw new Error(`whatsapp_template_blocked:${template.status}`);
  }

  const templateContext = await enrichContextForTemplateResolution(context, targets);
  const recipientData = await resolveWhatsAppRecipient({ node, config, context: templateContext, targets });
  const senderData = await resolveWhatsAppSenderConfig({ config, context: templateContext, clinicId });
  const templateParams = resolveTemplateVariables(config, templateContext);
  const previewText = renderWhatsappTemplatePreviewText(template, templateParams);
  const quietHoursEnabled = parseBool(resolveTemplateValue(config?.quiet_hours_enabled, context), true);
  const quietWindow = computeQuietHoursDelayMs({
    now: new Date(),
    enabled: quietHoursEnabled,
    startHour: 22,
    endHour: 7,
  });

  const targetPatientId = toIntOrNull(targets.patient_id);
  let conversation = null;

  // 1) Si tenemos paciente objetivo, priorizar siempre su propia conversación en la clínica.
  if (targetPatientId) {
    conversation = await Conversation.findOne({
      where: {
        clinic_id: clinicId,
        channel: 'whatsapp',
        patient_id: targetPatientId,
      },
      order: [['id', 'DESC']],
    });
  }

  // 2) Fallback por teléfono, pero sin cruzar con otro paciente.
  if (!conversation) {
    const phoneWhere = {
      clinic_id: clinicId,
      channel: 'whatsapp',
      contact_id: recipientData.recipient,
    };

    if (targetPatientId) {
      phoneWhere[Op.or] = [
        { patient_id: null },
        { patient_id: targetPatientId },
      ];
    }

    conversation = await Conversation.findOne({
      where: phoneWhere,
      order: [['id', 'DESC']],
    });
  }

  // 3) Si no existe, crear conversación del paciente objetivo.
  if (!conversation) {
    conversation = await Conversation.create({
      clinic_id: clinicId,
      channel: 'whatsapp',
      contact_id: recipientData.recipient,
      patient_id: targetPatientId,
      unread_count: 0,
      last_message_at: new Date(),
    });
  } else if (!conversation.patient_id && targetPatientId) {
    // 4) Si era conversación sin paciente, vincularla.
    await conversation.update({ patient_id: targetPatientId });
  }

  const senderClinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'nombre_clinica'],
    raw: true,
  });

  let recipientPatientId = toIntOrNull(conversation?.patient_id) || targetPatientId;
  let recipientPatientName = null;
  if (recipientPatientId) {
    const patient = await db.Paciente.findByPk(recipientPatientId, {
      attributes: ['id_paciente', 'nombre', 'apellidos', 'clinica_id'],
      raw: true,
    });
    if (patient) {
      let belongsToClinic = Number(patient.clinica_id) === Number(clinicId);
      if (!belongsToClinic && db.PacienteClinica) {
        const relation = await db.PacienteClinica.findOne({
          where: {
            paciente_id: recipientPatientId,
            clinica_id: clinicId,
          },
          attributes: ['id'],
          raw: true,
        });
        belongsToClinic = !!relation;
      }
      if (belongsToClinic) {
        recipientPatientName = buildDisplayName(patient.nombre, patient.apellidos) || cleanString(patient.nombre) || null;
      } else {
        recipientPatientId = null;
      }
    } else {
      recipientPatientId = null;
    }
  }

  const limitStatus = await whatsappService.checkOutboundLimit({
    clinicConfig: senderData.clinic_config,
    conversation,
  });
  if (limitStatus?.limitReached) {
    throw new Error('whatsapp_limit_reached');
  }

  const flowName =
    cleanString(runtime?.execution?.templateVersion?.name)
    || cleanString(runtime?.execution?.template_name)
    || `Flujo #${toIntOrNull(runtime?.execution?.id) || ''}`.trim();
  const eventMessageContent = `Mensaje enviado automáticamente por activarse el flujo ${flowName ? `"${flowName}"` : ''}. El paciente no ve este texto, solo el mensaje a continuación.`;
  const messageContent = previewText;
  const nowIso = new Date().toISOString();

  const eventMsg = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'outbound',
    content: eventMessageContent,
    message_type: 'event',
    status: 'sent',
    sent_at: new Date(),
    metadata: {
      source: 'automations_v2',
      kind: 'automation_flow_event',
      reason: 'flow_send_whatsapp',
      execution_id: runtime?.execution?.id || null,
      node_id: cleanString(node?.id),
      flow_name: flowName || null,
      template_id: template.id,
      template_name: template.name,
      generated_at: nowIso,
    },
  });

  const metadata = {
    source: 'automations_v2',
    kind: 'flow_send_whatsapp',
    execution_id: execution?.id || null,
    node_id: cleanString(node?.id),
    flow_name: flowName || null,
    flow_reason: 'flow_send_whatsapp',
    template_id: template.id,
    template_name: template.name,
    template_language: cleanString(resolveTemplateValue(config?.language_code, context)) || template.language || 'es_ES',
    template_params: templateParams,
    preview_text: previewText,
    recipient_mode: recipientData.recipient_mode,
    recipient: recipientData.recipient,
    sender_mode: senderData.sender_mode,
    sender_origin_id: senderData.sender_origin_id,
    phoneNumberId: senderData.clinic_config?.phoneNumberId || null,
    phoneId: senderData.clinic_config?.phoneNumberId || null,
    wabaId: senderData.clinic_config?.wabaId || null,
    quiet_hours_enabled: quietHoursEnabled,
    quiet_hours_window: '22:00-07:00',
    limitMode: !!limitStatus?.limitedMode,
    limitSnapshot: limitStatus?.limitedMode
      ? {
          count: limitStatus.count,
          limit: limitStatus.limit,
        }
      : null,
  };

  const msg = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'outbound',
    content: messageContent,
    message_type: 'template',
    status: 'pending',
    sent_at: new Date(),
    metadata,
  });
  emitMessageCreatedToConversationRooms(conversation, eventMsg);
  emitMessageCreatedToConversationRooms(conversation, msg);

  if (quietWindow.delayMs > 0) {
    try {
      await queues.outboundWhatsApp.add(
        'send',
        {
          messageId: msg.id,
          conversationId: conversation.id,
          to: recipientData.recipient,
          body: messageContent,
          useTemplate: true,
          templateName: template.name,
          templateLanguage: metadata.template_language,
          templateParams,
          templateComponents: null,
          clinicConfig: senderData.clinic_config,
        },
        { delay: quietWindow.delayMs }
      );
    } catch (enqueueErr) {
      const enqueueError = enqueueErr?.message || 'enqueue_failed';
      await msg.update({
        status: 'failed',
        metadata: {
          ...(msg.metadata || {}),
          enqueue_error: enqueueError,
        },
      });
      const io = getIO();
      if (io) {
        const room = conversation?.clinic_id ? `clinic:${conversation.clinic_id}` : null;
        const payload = {
          id: msg.id,
          conversation_id: conversation.id,
          status: 'failed',
          error: enqueueError,
        };
        if (room) io.to(room).emit('message:updated', payload);
        else io.emit('message:updated', payload);
      }
      throw new Error(`whatsapp_enqueue_failed:${enqueueError}`);
    }

    await msg.update({
      status: 'pending',
      metadata: {
        ...(msg.metadata || {}),
        scheduled_for: quietWindow.scheduledAt ? quietWindow.scheduledAt.toISOString() : null,
        queued_by_quiet_hours: true,
      },
    });
    await conversation.update({ last_message_at: new Date() });

    return {
      kind: 'success',
      output: {
        message_id: msg.id,
        event_message_id: eventMsg.id,
        status: 'scheduled',
        template_id: template.id,
        template_name: template.name,
        message_preview: previewText,
        recipient_mode: recipientData.recipient_mode,
        recipient: recipientData.recipient,
        sender_mode: senderData.sender_mode,
        sender_origin_id: senderData.sender_origin_id,
        conversation_id: conversation.id,
        phone_number_id: senderData.clinic_config?.phoneNumberId || null,
        limited_mode: !!limitStatus?.limitedMode,
        quiet_hours_applied: true,
        scheduled_for: quietWindow.scheduledAt ? quietWindow.scheduledAt.toISOString() : null,
        sender_clinic_id: clinicId,
        sender_clinic_name: cleanString(senderClinic?.nombre_clinica),
        recipient_patient_id: recipientPatientId,
        recipient_patient_name: recipientPatientName,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  try {
    const waResponse = await whatsappService.sendMessage({
      to: recipientData.recipient,
      body: messageContent,
      useTemplate: true,
      templateName: template.name,
      templateLanguage: metadata.template_language,
      templateParams,
      templateComponents: null,
      clinicConfig: senderData.clinic_config,
    });

    await msg.update({
      status: 'sent',
      metadata: {
        ...(msg.metadata || {}),
        wa_response: waResponse,
        wamid: waResponse?.messages?.[0]?.id || null,
        phoneId: senderData.clinic_config?.phoneNumberId || msg?.metadata?.phoneId || null,
      },
      sent_at: new Date(),
    });

    await conversation.update({ last_message_at: new Date() });
    const io = getIO();
    if (io) {
      const room = conversation?.clinic_id ? `clinic:${conversation.clinic_id}` : null;
      const payload = {
        id: msg.id,
        conversation_id: conversation.id,
        status: 'sent',
      };
      if (room) io.to(room).emit('message:updated', payload);
      else io.emit('message:updated', payload);
    }
  } catch (sendErr) {
    const providerError = sendErr?.response?.data || sendErr?.message || 'whatsapp_send_failed';
    await msg.update({
      status: 'failed',
      metadata: {
        ...(msg.metadata || {}),
        error: providerError,
      },
    });

    try {
      const nestedError = providerError?.error?.error || providerError?.error || {};
      const errorCode = nestedError?.code || null;
      const errorMessage = nestedError?.message || cleanString(sendErr?.message) || 'whatsapp_send_failed';
      if (errorCode === 133010 && senderData?.clinic_config?.phoneNumberId) {
        const asset = await ClinicMetaAsset.findOne({
          where: {
            assetType: 'whatsapp_phone_number',
            phoneNumberId: senderData.clinic_config.phoneNumberId,
            isActive: true,
          },
        });
        if (asset) {
          const additionalData = asset.additionalData || {};
          additionalData.registration = {
            ...(additionalData.registration || {}),
            status: 'not_registered',
            requiresPin: true,
            lastAttemptAt: new Date().toISOString(),
            lastErrorCode: errorCode,
            lastErrorMessage: errorMessage,
          };
          asset.additionalData = additionalData;
          await asset.save();
        }
      }
    } catch (_regErr) {
      // No bloquea el flujo: la causa principal del error ya se propagará.
    }

    const io = getIO();
    if (io) {
      const room = conversation?.clinic_id ? `clinic:${conversation.clinic_id}` : null;
      const payload = {
        id: msg.id,
        conversation_id: conversation.id,
        status: 'failed',
        error: providerError,
      };
      if (room) io.to(room).emit('message:updated', payload);
      else io.emit('message:updated', payload);
    }

    const nestedError = providerError?.error?.error || providerError?.error || {};
    const providerMessage = cleanString(nestedError?.message) || cleanString(sendErr?.message) || 'whatsapp_send_failed';
    throw new Error(`whatsapp_send_failed:${providerMessage}`);
  }

  return {
    kind: 'success',
    output: {
      message_id: msg.id,
      event_message_id: eventMsg.id,
      status: 'sent',
      template_id: template.id,
      template_name: template.name,
      message_preview: previewText,
      recipient_mode: recipientData.recipient_mode,
      recipient: recipientData.recipient,
      sender_mode: senderData.sender_mode,
      sender_origin_id: senderData.sender_origin_id,
      conversation_id: conversation.id,
      phone_number_id: senderData.clinic_config?.phoneNumberId || null,
      limited_mode: !!limitStatus?.limitedMode,
      quiet_hours_applied: false,
      scheduled_for: null,
      sender_clinic_id: clinicId,
      sender_clinic_name: cleanString(senderClinic?.nombre_clinica),
      recipient_patient_id: recipientPatientId,
      recipient_patient_name: recipientPatientName,
    },
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
  const notificationRole = roleCode || '';
  const notificationSubrole = subrole || '';
  const createdNotifications = [];
  for (const userId of userIds) {
    const notification = await Notification.create({
      userId,
      role: notificationRole,
      subrole: notificationSubrole,
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

function deepMergeObject(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMergeObject(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeContextPatch(context, patch) {
  const nextContext = clone(context) || {};
  return deepMergeObject(nextContext, patch);
}

function sanitizeAuditValue(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= 3) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 10).map((item) => sanitizeAuditValue(item, depth + 1));
    if (value.length > 10) out.push(`[+${value.length - 10} items]`);
    return out;
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value);
    for (const [key, val] of entries.slice(0, 20)) {
      out[key] = sanitizeAuditValue(val, depth + 1);
    }
    if (entries.length > 20) {
      out.__truncated_keys = entries.length - 20;
    }
    return out;
  }
  return String(value);
}

function summarizeNodeOutputForAudit(context, nodeId) {
  return sanitizeAuditValue(context?.outputs?.[nodeId] ?? null);
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

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on', 'si', 'sí'].includes(normalized);
}

function isFieldCheckOperatorCompatible(operator, valueType) {
  const normalizedType = cleanString(valueType) || 'string';
  const allowed = FIELD_CHECK_OPERATOR_TYPE_COMPAT[normalizedType];
  if (!allowed) return true;
  return allowed.includes(operator);
}

function evaluateFieldCheck(config, context) {
  const leftRef = config?.left_ref;
  if (!leftRef || typeof leftRef !== 'object') {
    throw new Error('field_check_left_ref_required');
  }

  const source = cleanString(leftRef.source);
  if (!source || !FIELD_CHECK_LEFT_REF_SOURCES.has(source)) {
    throw new Error(`field_check_invalid_source:${source || 'empty'}`);
  }

  const path = cleanString(leftRef.path);
  if (!path) {
    throw new Error('field_check_left_ref_path_required');
  }

  let left;
  switch (source) {
    case 'node_output': {
      const nodeId = cleanString(leftRef.node_id);
      if (!nodeId) throw new Error('field_check_node_id_required');
      left = getByPath(context, `outputs.${nodeId}.${path}`);
      break;
    }
    case 'trigger_data':
      left = getByPath(context, `trigger.data.${path}`);
      if (left === undefined) left = getByPath(context, path);
      break;
    case 'context':
      left = getByPath(context, path);
      break;
    case 'manual': {
      const templatePath = path.includes('{{') ? path : `{{${path}}}`;
      left = resolveTemplateValue(templatePath, context);
      break;
    }
    default:
      throw new Error(`field_check_invalid_source:${source}`);
  }

  const operator = String(config?.operator || 'equals').toLowerCase();
  if (operator === 'exists') {
    return left !== undefined && left !== null && left !== '';
  }

  const valueTypeRaw = cleanString(leftRef.value_type) || 'string';
  const valueType = FIELD_CHECK_VALUE_TYPES.has(valueTypeRaw) ? valueTypeRaw : 'string';
  if (!isFieldCheckOperatorCompatible(operator, valueType)) {
    throw new Error(`field_check_operator_incompatible:${operator}:${valueType}`);
  }

  let right = config?.right_value;
  if (typeof right === 'string') {
    right = resolveTemplateValue(right, context);
  }

  if (valueType === 'number') {
    const leftNum = Number(left);
    const rightNum = Number(right);
    if (!Number.isFinite(leftNum) || !Number.isFinite(rightNum)) {
      throw new Error('field_check_number_cast_failed');
    }
    if (operator === 'equals') return leftNum === rightNum;
    if (operator === 'not_equals') return leftNum !== rightNum;
    if (operator === 'greater_than') return leftNum > rightNum;
    if (operator === 'less_than') return leftNum < rightNum;
    return false;
  }

  if (valueType === 'boolean') {
    const leftBool = toBool(left);
    const rightBool = toBool(right);
    if (operator === 'equals') return leftBool === rightBool;
    if (operator === 'not_equals') return leftBool !== rightBool;
    return false;
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

function isSimulationRuntime(runtime = {}, context = {}) {
  if (parseBool(runtime?.simulation, false)) return true;
  if (parseBool(context?.__simulation, false)) return true;
  if (parseBool(getByPath(context, 'trigger.data.__simulation'), false)) return true;
  return false;
}

async function processNode(node, context, runtime = {}) {
  const nodeType = cleanString(node?.type) || 'unknown';
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const simulation = isSimulationRuntime(runtime, context);

  if (nodeType.startsWith('trigger/')) {
    return {
      kind: 'success',
      output: {
        trigger_type: cleanString(nodeType.slice('trigger/'.length)),
        status: 'trigger_passed',
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  switch (nodeType) {
    case 'action/write_note': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            content: cleanString(resolveTemplateValue(config?.content, context)) || null,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleWriteNote(node, context, runtime);
    }

    case 'action/change_status': {
      if (simulation) {
        const targetEntity = normalizeStatusTarget(resolveTemplateValue(config?.target_entity, context)) || null;
        const nextStatus = cleanString(resolveTemplateValue(config?.new_status, context)) || null;
        const contextPatch = {};
        if (targetEntity === 'appointment' && nextStatus) {
          contextPatch.appointment = {
            ...(context?.appointment && typeof context.appointment === 'object' ? context.appointment : {}),
            estado: nextStatus,
            status: nextStatus,
          };
        }
        if (targetEntity === 'lead' && nextStatus) {
          contextPatch.lead = {
            ...(context?.lead && typeof context.lead === 'object' ? context.lead : {}),
            status_lead: nextStatus,
            status: nextStatus,
          };
        }
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            target_entity: targetEntity,
            new_status: nextStatus,
            agenda_icon: cleanString(resolveTemplateValue(config?.agenda_icon, context)) || null,
          },
          context_patch: contextPatch,
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleChangeStatus(node, context, runtime);
    }

    case 'action/update_lead_info': {
      if (simulation) {
        const mode = cleanString(resolveTemplateValue(config?.mode, context)) || 'set_required';
        const requiredList = normalizeStringArray(resolveTemplateValue(config?.info_requerida, context));
        const receivedList = normalizeStringArray(resolveTemplateValue(config?.info_recibida_items, context));
        const leadPatch = {};
        if (['set_required', 'clear_required', 'clear_all'].includes(mode)) {
          leadPatch.info_requerida = mode === 'set_required' ? requiredList : [];
        }
        if (['set_received', 'append_received', 'clear_received', 'clear_all'].includes(mode)) {
          const previous = normalizeStringArray(context?.lead?.info_recibida_items);
          if (mode === 'append_received') {
            leadPatch.info_recibida_items = normalizeStringArray([...previous, ...receivedList]);
          } else if (mode === 'set_received') {
            leadPatch.info_recibida_items = receivedList;
          } else {
            leadPatch.info_recibida_items = [];
          }
        }
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            mode,
          },
          context_patch: {
            lead: {
              ...(context?.lead && typeof context.lead === 'object' ? context.lead : {}),
              ...leadPatch,
            },
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleUpdateLeadInfo(node, context, runtime);
    }

    case 'action/send_whatsapp': {
      if (simulation) {
        const recipientMode = normalizeRecipientMode(resolveTemplateValue(config?.recipient_mode, context));
        const senderMode = toLowerSafe(resolveTemplateValue(config?.sender_mode, context)) || 'clinic_default';
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            template_id: toIntOrNull(resolveTemplateValue(config?.template_id, context)),
            recipient_mode: recipientMode,
            sender_mode: senderMode,
            sender_origin_id: senderMode === 'specific_origin'
              ? (toIntOrNull(resolveTemplateValue(config?.sender_origin_id, context)) || null)
              : null,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleSendWhatsapp(node, context, runtime);
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
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            title: cleanString(resolveTemplateValue(config?.title, context)) || 'Tarea de automatización',
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
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

    case 'control/join': {
      return {
        kind: 'success',
        output: {
          status: 'joined',
          mode: cleanString(resolveTemplateValue(config?.mode, context)) || 'any',
        },
        next_node_id: readOutputTarget(node, 'on_joined') || readOutputTarget(node, 'on_success'),
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
      const responseBufferEnabled = parseBool(resolveTemplateValue(config?.response_buffer_enabled, context), true);
      return {
        kind: 'waiting',
        output: {
          waits_for_response: true,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          timeout_at: waitUntil ? waitUntil.toISOString() : null,
          response_buffer_enabled: responseBufferEnabled,
        },
        waiting_meta: {
          type: nodeType,
          listens_to_node_id: cleanString(config?.listens_to_node_id),
          on_response: readOutputTarget(node, 'on_response'),
          on_timeout: readOutputTarget(node, 'on_timeout'),
          response_buffer_enabled: responseBufferEnabled,
        },
        wait_until: waitUntil,
      };
    }

    case 'condition/ai_analysis': {
      if (
        config?.prompt !== undefined
        || config?.input_text !== undefined
        || config?.output_format !== undefined
        || config?.analysis_mode !== undefined
        || config?.provider !== undefined
        || config?.model !== undefined
      ) {
        throw new Error('ai_analysis_legacy_config_not_supported');
      }

      const resolvedInstruction = cleanString(resolveTemplateValue(config?.instruction, context));
      if (!resolvedInstruction) {
        throw new Error('ai_analysis_instruction_required');
      }

      const sourceEntries = Array.isArray(config?.context_sources) ? config.context_sources : [];
      if (!sourceEntries.length) {
        throw new Error('ai_analysis_context_sources_required');
      }

      const resolvedSources = sourceEntries
        .map((source) => {
          const key = cleanString(source?.key) || 'input';
          const path = cleanString(source?.path);
          if (!path) return null;
          return {
            key,
            value: resolveTemplateValue(path, context),
          };
        })
        .filter((source) => source && source.value !== undefined && source.value !== null);

      if (!resolvedSources.length) {
        throw new Error('ai_analysis_context_sources_empty');
      }

      const inputText = resolvedSources
        .map((source) => {
          const rendered = typeof source.value === 'object'
            ? JSON.stringify(source.value)
            : String(source.value);
          return `${source.key}: ${rendered}`;
        })
        .join('\n');

      if (!cleanString(inputText)) {
        throw new Error('ai_analysis_context_empty');
      }

      const normalizedOutputFields = normalizeOutputFieldEntries(config?.output_fields);
      if (!normalizedOutputFields.length) {
        throw new Error('ai_analysis_output_fields_required');
      }

      const outputFormat = normalizeOutputFieldsToFormat(normalizedOutputFields);
      const outputFormatSimple = normalizeAiOutputFormat(outputFormat);
      const analysisMode = normalizeAiAnalysisMode(resolveTemplateValue(config?.mode, context));
      const selectedModel = pickGroqModel({
        analysisMode,
        prompt: resolvedInstruction,
        inputText,
        outputFormat: outputFormatSimple,
      });

      if (simulation) {
        return {
          kind: 'success',
          output: buildAiSimulatedOutput(outputFormatSimple, analysisMode, selectedModel),
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }

      const aiOutput = await runGroqAiAnalysis({
        prompt: resolvedInstruction,
        inputText,
        outputFormat,
        outputFields: normalizedOutputFields,
        analysisMode,
        maxTokens: resolveTemplateValue(config?.max_tokens, context),
      });

      return {
        kind: 'success',
        output: aiOutput,
        next_node_id: readOutputTarget(node, 'on_success'),
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
      const listensTo = cleanString(node?.config?.listens_to_node_id);
      const listenedOutput = listensTo ? getByPath(context, `outputs.${listensTo}`) : null;
      const listenedMessagePreview = cleanString(
        listenedOutput?.message_preview
        || listenedOutput?.content
        || listenedOutput?.body
      );
      const respondedAt = new Date().toISOString();
      nextContext = mergeNodeOutput(nextContext, node.id, {
        response_text: responseText ?? null,
        response_lines: String(responseText || '')
          .split(/\r?\n/)
          .map((line) => cleanString(line))
          .filter(Boolean),
        listens_to_node_id: listensTo,
        listened_message_preview: listenedMessagePreview,
        responded_at: respondedAt,
      });
      // Alias de contexto para simplificar plantillas IA sin depender de IDs de nodos.
      nextContext = {
        ...(nextContext || {}),
        last_response: responseText ?? null,
        last_prompt: listenedMessagePreview || null,
        last_response_context: {
          response_text: responseText ?? null,
          listened_message_preview: listenedMessagePreview || null,
          wait_node_id: node.id,
          listens_to_node_id: listensTo || null,
          responded_at: respondedAt,
        },
      };
    }

    await updateExecutionAndEmit(execution, {
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context: nextContext,
      last_error: null,
    }, 'flow_execution:resumed', { resume_mode: mode || 'response' });

    return { resumed: true, context: nextContext };
  }

  if (nodeType === 'delay/fixed' || nodeType === 'delay/wait_until') {
    const nextNode = readOutputTarget(node, 'on_complete');
    await updateExecutionAndEmit(execution, {
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context,
      last_error: null,
    }, 'flow_execution:resumed', { resume_mode: mode || 'timeout' });
    return { resumed: true, context };
  }

  await updateExecutionAndEmit(execution, {
    status: 'running',
    wait_until: null,
    waiting_meta: null,
    last_error: null,
  }, 'flow_execution:resumed', { resume_mode: mode || 'timeout' });

  return { resumed: true, context };
}

async function runExecution(executionId, options = {}) {
  const maxSteps = Number.isInteger(options.maxSteps) ? options.maxSteps : 100;
  const resumeMode = cleanString(options.resumeMode) || null;

  const execution = await FlowExecutionV2.findByPk(executionId, {
    include: [{
      model: AutomationFlowTemplateV2,
      as: 'templateVersion',
    }],
  });

  if (!execution) {
    throw new Error('execution_not_found');
  }

  emitExecutionEvent(execution, 'flow_execution:engine_start');

  const template = execution.templateVersion;
  if (!template) {
    await updateExecutionAndEmit(
      execution,
      { status: 'failed', last_error: 'template_version_not_found' },
      'flow_execution:updated'
    );
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

    const responseText = options.responseText ?? getByPath(execution.waiting_meta, 'pending_response_text') ?? null;

    const waitingNodeId = cleanString(execution.current_node_id);
    const waitingNode = waitingNodeId ? nodeMap.get(waitingNodeId) : null;

    if (!waitingNode) {
      await updateExecutionAndEmit(
        execution,
        { status: 'failed', last_error: 'waiting_node_not_found' },
        'flow_execution:updated'
      );
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
      await updateExecutionAndEmit(execution, {
        status: 'completed',
        current_node_id: null,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      }, 'flow_execution:completed');
      localStatus = 'completed';
      break;
    }

    const node = nodeMap.get(currentNodeId);
    if (!node) {
      await updateExecutionAndEmit(execution, {
        status: 'failed',
        current_node_id: null,
        context,
        last_error: `node_not_found:${currentNodeId}`,
      }, 'flow_execution:updated');
      localStatus = 'failed';
      break;
    }

    const startedAt = new Date();
    const nodeOutputBefore = summarizeNodeOutputForAudit(context, currentNodeId);
    const log = await FlowExecutionLogV2.create({
      flow_execution_id: execution.id,
      node_id: currentNodeId,
      node_type: cleanString(node.type),
      status: 'running',
      started_at: startedAt,
      audit_snapshot: {
        started_at: startedAt.toISOString(),
        node_output_before: nodeOutputBefore,
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
        const nodeOutputAfter = summarizeNodeOutputForAudit(context, currentNodeId);

        await log.update({
          status: 'success',
          finished_at: finishedAt,
          audit_snapshot: {
            kind: 'waiting',
            wait_until: result.wait_until ? result.wait_until.toISOString() : null,
            waiting_meta: result.waiting_meta || null,
            node_output_before: nodeOutputBefore,
            node_output_after: nodeOutputAfter,
          },
        });
        emitExecutionLogEvent(execution, log, { kind: 'waiting' });

        await updateExecutionAndEmit(execution, {
          status: 'waiting',
          current_node_id: currentNodeId,
          context,
          wait_until: result.wait_until || null,
          waiting_meta: result.waiting_meta || null,
          last_error: null,
        }, 'flow_execution:updated');

        localStatus = 'waiting';
        break;
      }

      if (result.context_patch && typeof result.context_patch === 'object') {
        context = mergeContextPatch(context, result.context_patch);
      }

      context = mergeNodeOutput(context, currentNodeId, {
        ...(result.output || {}),
        status: 'success',
        at: finishedAt.toISOString(),
      });
      const nodeOutputAfter = summarizeNodeOutputForAudit(context, currentNodeId);

      const nextNodeId = cleanString(result.next_node_id);

      await log.update({
        status: 'success',
        finished_at: finishedAt,
        audit_snapshot: {
          kind: 'success',
          next_node_id: nextNodeId,
          node_output_before: nodeOutputBefore,
          node_output_after: nodeOutputAfter,
        },
      });
      emitExecutionLogEvent(execution, log, { kind: 'success' });

      if (!nextNodeId) {
        await updateExecutionAndEmit(execution, {
          status: 'completed',
          current_node_id: null,
          context,
          wait_until: null,
          waiting_meta: null,
          last_error: null,
        }, 'flow_execution:completed');
        localStatus = 'completed';
        break;
      }

      currentNodeId = nextNodeId;
      await updateExecutionAndEmit(execution, {
        status: 'running',
        current_node_id: currentNodeId,
        context,
        wait_until: null,
        waiting_meta: null,
        last_error: null,
      }, 'flow_execution:updated');
    } catch (error) {
      const finishedAt = new Date();
      const errorMessage = cleanString(error?.message) || 'node_execution_error';
      const onFailNode = readOutputTarget(node, 'on_fail');

      context = mergeNodeOutput(context, currentNodeId, {
        status: 'error',
        error_message: errorMessage,
        at: finishedAt.toISOString(),
      });
      const nodeOutputAfter = summarizeNodeOutputForAudit(context, currentNodeId);

      await log.update({
        status: 'error',
        finished_at: finishedAt,
        error_message: errorMessage,
        audit_snapshot: {
          kind: 'error',
          on_fail: onFailNode,
          node_output_before: nodeOutputBefore,
          node_output_after: nodeOutputAfter,
        },
      });
      emitExecutionLogEvent(execution, log, { kind: 'error' });

      if (onFailNode) {
        currentNodeId = onFailNode;
        await updateExecutionAndEmit(execution, {
          status: 'running',
          current_node_id: currentNodeId,
          context,
          last_error: errorMessage,
        }, 'flow_execution:updated');
      } else {
        await updateExecutionAndEmit(execution, {
          status: 'failed',
          current_node_id: null,
          context,
          last_error: errorMessage,
        }, 'flow_execution:failed');
        localStatus = 'failed';
        break;
      }
    }
  }

  if (localStatus === 'running') {
    await updateExecutionAndEmit(execution, {
      status: 'dead_letter',
      last_error: 'max_steps_exceeded',
      context,
    }, 'flow_execution:dead_letter');
  }

  await execution.reload();
  return execution;
}

module.exports = {
  runExecution,
};
