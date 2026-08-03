'use strict';

const { Op } = require('sequelize');
const axios = require('axios');
const db = require('../../models');
const { getIO } = require('./socket.service');
const { emitNotificationCreated } = require('./notificationsRealtime.service');
const { queues } = require('./queue.service');
const jobRequestsService = require('./jobRequests.service');
const {
  resolveWhatsappServiceWindow,
} = require('./whatsappServiceWindow.service');
const {
  mergeClinicLinksIntoContext,
  resolveClinicGoogleLocalLinks,
} = require('./googleLocalLinks.service');
const { normalizeCitaStatus, normalizeLeadStatus } = require('../lib/status-catalog');
const { ADMIN_USER_IDS } = require('../lib/role-helpers');
const { normalizeAccessGuidance } = require('../lib/clinic-configuration');
const {
  buildAccessGuidanceTemplateComponents,
  buildAutomationWhatsappTransportJobOptions,
  evaluateAccessGuidanceVariantEligibility,
  isAccessGuidanceReminderBranchEnabled,
  selectAccessGuidanceTemplateBranch,
} = require('../lib/appointment-access-guidance-template');
const {
  extractWhatsappTemplatePlaceholderIndexes,
  buildWhatsappTemplateVariableContract,
  normalizeNamedBindings,
  normalizePositionalBindings,
  buildNamedBindingsFromPositional,
  buildPositionalBindingsFromNamed,
  buildEffectiveNamedBindings,
} = require('../lib/whatsapp-template-contract');
const {
  normalizeWhatsappLocale,
  resolveCatalogFamilyKey,
  resolveExecutionCommunicationLanguage,
} = require('../lib/whatsapp-template-locale');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const CitaPaciente = db.CitaPaciente;
const LeadIntake = db.LeadIntake;
const LeadContactAttempt = db.LeadContactAttempt;
const Conversation = db.Conversation;
const Message = db.Message;
const Notification = db.Notification;
const UsuarioClinica = db.UsuarioClinica;
const Usuario = db.Usuario;
const Clinica = db.Clinica;
const ClinicMetaAsset = db.ClinicMetaAsset;
const PublicMediaAsset = db.PublicMediaAsset;
const WhatsappTemplate = db.WhatsappTemplate;
const WhatsappTemplateCatalog = db.WhatsappTemplateCatalog;
const whatsappService = require('./whatsapp.service');
const whatsappConnectionStatusService = require('./whatsappConnectionStatus.service');
const marketingBulkSendsService = require('./marketingBulkSends.service');
const appointmentNotificationCleanup = require('./appointmentNotificationCleanup.service');
const { recordAppointmentStatusChange } = require('./appointmentActivity.service');
const businessProfileLocal = require('./businessProfileLocal.service');
const { resolveLeadAutoReplyWait } = require('./clinicOpeningHours.service');
const { evaluatePendingLeadContact } = require('./leadContactState.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const { buildConversationContext } = require('../lib/automation-conversation-context');
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
const FORM_SUBMISSION_MATCH_MODES = new Set(['url_contains', 'url_equals', 'form_id', 'selector']);
const FIELD_CHECK_LEFT_REF_SOURCES = new Set(['node_output', 'trigger_data', 'context', 'manual']);
const FIELD_CHECK_VALUE_TYPES = new Set(['string', 'number', 'boolean']);
const FIELD_CHECK_MODE_VALUES = new Set(['simple', 'appointment_booking_timing', 'lead_contact_state']);
const FIELD_CHECK_SWITCH_TYPE_VALUES = new Set(['appointment_booking']);
const FIELD_CHECK_APPOINTMENT_WINDOW_VALUES = new Set(['same_day', 'day_before', 'more_than_day_before']);
const PROTECTED_APPOINTMENT_STATUSES = new Set(['cancelada', 'completada', 'no_asistio']);
const APPOINTMENT_NOTIFICATION_RESOLVED_STATUSES = new Set([
  'info_confirmada',
  'recordatorio_confirmado',
  'cancelada',
  'reprogramada',
  'completada',
  'no_asistio',
]);
const DEFAULT_TIMEZONE = 'Europe/Madrid';
const POSITIVE_CONFIRMATION_REACTION_EMOJIS = new Set([
  '👍',
  '👍🏻',
  '👍🏼',
  '👍🏽',
  '👍🏾',
  '👍🏿',
  '✅',
  '✔️',
  '✔',
  '☑️',
  '☑',
  '👌',
  '👌🏻',
  '👌🏼',
  '👌🏽',
  '👌🏾',
  '👌🏿',
  '🙌',
  '🙌🏻',
  '🙌🏼',
  '🙌🏽',
  '🙌🏾',
  '🙌🏿',
]);
const FIELD_CHECK_OPERATOR_TYPE_COMPAT = {
  string: ['equals', 'not_equals', 'contains', 'exists'],
  number: ['equals', 'not_equals', 'greater_than', 'greater_than_or_equals', 'less_than', 'exists'],
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

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseClinicConfig(value) {
  if (!value) return null;
  if (isObject(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isObject(parsed) ? parsed : null;
    } catch (_err) {
      return null;
    }
  }
  return null;
}

function isValidTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (_err) {
    return false;
  }
}

function resolveClinicTimezoneFromContext(context) {
  const clinic = isObject(context?.clinic) ? context.clinic : (isObject(context?.clinica) ? context.clinica : null);
  const cfg = parseClinicConfig(clinic?.configuracion);
  const candidates = [
    cleanString(clinic?.timezone),
    cleanString(clinic?.time_zone),
    cleanString(clinic?.tz),
    cleanString(cfg?.timezone),
    cleanString(cfg?.timeZone),
    cleanString(cfg?.tz),
  ];
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return DEFAULT_TIMEZONE;
}

function detectCurrentRuntimeNamespace() {
  const explicit = cleanString(process.env.JOB_RUNTIME_NAMESPACE)
    || cleanString(process.env.RUNTIME_NAMESPACE);
  if (explicit) return explicit;

  const port = cleanString(process.env.PORT);
  if (port) return `port:${port}`;

  const cwd = cleanString(process.cwd());
  if (cwd) return `cwd:${cwd}`;

  return 'runtime:unknown';
}

const CURRENT_RUNTIME_NAMESPACE =
  (typeof jobRequestsService.getCurrentRuntimeNamespace === 'function'
    ? cleanString(jobRequestsService.getCurrentRuntimeNamespace())
    : null)
  || detectCurrentRuntimeNamespace();
const QUIET_HOURS_WHATSAPP_JOB_TYPE = 'automation_whatsapp_quiet_send';

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

function formatDateEs(rawDate, timeZone = DEFAULT_TIMEZONE) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function formatTimeEs(rawDate, timeZone = DEFAULT_TIMEZONE) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatAppointmentLocalDateTime(rawDate, timeZone = DEFAULT_TIMEZONE) {
  return {
    fecha: formatDateEs(rawDate, timeZone),
    hora: formatTimeEs(rawDate, timeZone),
  };
}

function formatPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const bag = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') bag[part.type] = part.value;
  });

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) === 24 ? 0 : Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function offsetMinutesForTimeZone(date, timeZone) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function normalizeHms(value, fallback = '00:00:00') {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function localDateTimeToUtc(fechaLocal, timeValue, timeZone) {
  if (!fechaLocal || typeof fechaLocal !== 'string') return null;
  const dateMatch = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const hms = normalizeHms(timeValue);
  if (!hms) return null;
  const timeMatch = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3]);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  let timestamp = naiveUtc;
  for (let index = 0; index < 2; index += 1) {
    const offsetMin = offsetMinutesForTimeZone(new Date(timestamp), timeZone);
    timestamp = naiveUtc - (offsetMin * 60000);
  }

  return new Date(timestamp);
}

function formatDateLocal(date, timeZone) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function addDaysToLocalDate(fechaLocal, deltaDays) {
  const match = String(fechaLocal || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  utc.setUTCDate(utc.getUTCDate() + Number(deltaDays || 0));
  const pad = (value) => String(value).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function normalizeWhatsappTemplateComponents(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const components = plain.components;
  if (Array.isArray(components)) return components;
  if (typeof components === 'string') {
    try {
      const parsed = JSON.parse(components);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }
  return [];
}

function extractWhatsappTemplateBodyText(template) {
  const components = normalizeWhatsappTemplateComponents(template);
  const bodyParts = components
    .filter((comp) => String(comp?.type || '').toUpperCase() === 'BODY')
    .map((comp) => cleanString(comp?.text))
    .filter(Boolean);

  if (bodyParts.length) {
    return bodyParts.join('\n');
  }

  return null;
}

function normalizeTemplateBodyForComparison(value) {
  return cleanString(value)?.replace(/\s+/g, ' ') || null;
}

function getWhatsappTemplateCatalogBodyText(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const catalog = plain.catalog?.get ? plain.catalog.get({ plain: true }) : plain.catalog;
  return cleanString(catalog?.body_text);
}

function matchesCurrentCatalogBody(template) {
  const catalogBody = normalizeTemplateBodyForComparison(getWhatsappTemplateCatalogBodyText(template));
  const templateBody = normalizeTemplateBodyForComparison(extractWhatsappTemplateBodyText(template));
  return !!catalogBody && !!templateBody && catalogBody === templateBody;
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

function resolveMadridDayPartGreeting(date = new Date()) {
  const madridNow = getMadridDateParts(date);
  const hour = Number(madridNow?.hour || 0);
  if (hour >= 6 && hour < 14) return 'Buenos días';
  if (hour >= 14 && hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
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

function normalizeOutsideSendWindowPolicy(value) {
  const normalized = toLowerSafe(value);
  if (normalized === 'discard' || normalized === 'skip') return 'discard';
  return 'schedule_next_window';
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

function buildPersonContext(nombre, apellidos, email = null) {
  const firstName = cleanString(nombre);
  const lastName = cleanString(apellidos);
  const fullName = buildDisplayName(firstName, lastName) || null;
  return {
    nombre: firstName,
    apellidos: lastName,
    nombre_completo: fullName || firstName || lastName || null,
    email: cleanString(email),
  };
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
      attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'created_by', 'doctor_id', 'estado', 'tipo_cita', 'inicio', 'fin', 'titulo', 'motivo', 'created_at'],
      raw: true,
    });
    if (appointment) {
      const existingAppointment = out?.appointment && typeof out.appointment === 'object' ? out.appointment : {};
      const existingTriggerData = out?.trigger?.data && typeof out.trigger.data === 'object' ? out.trigger.data : {};
      const creatorNameCandidate =
        cleanString(existingAppointment.usuario_nombre)
        || cleanString(existingTriggerData.usuario_nombre)
        || cleanString(existingTriggerData['usuario.nombre']);
      const creatorLastNameCandidate =
        cleanString(existingAppointment.usuario_apellidos)
        || cleanString(existingTriggerData.usuario_apellidos)
        || cleanString(existingTriggerData['usuario.apellidos']);
      const creatorEmailCandidate =
        cleanString(existingAppointment.usuario_email)
        || cleanString(existingTriggerData.usuario_email)
        || cleanString(existingTriggerData['usuario.email']);
      const professionalNameCandidate =
        cleanString(existingTriggerData.profesional_nombre)
        || cleanString(existingTriggerData['profesional.nombre']);
      const professionalLastNameCandidate =
        cleanString(existingTriggerData.profesional_apellidos)
        || cleanString(existingTriggerData['profesional.apellidos']);
      const professionalEmailCandidate =
        cleanString(existingTriggerData.profesional_email)
        || cleanString(existingTriggerData['profesional.email']);
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
        tipo_cita: cleanString(appointment.tipo_cita),
        appointment_type: cleanString(appointment.tipo_cita),
        inicio: appointment.inicio || null,
        fin: appointment.fin || null,
        created_at: appointment.created_at || appointment.createdAt || null,
        ...formatAppointmentLocalDateTime(appointment.inicio),
        titulo: cleanString(appointment.titulo),
        motivo: cleanString(appointment.motivo),
        usuario_nombre: creatorNameCandidate || null,
        usuario_apellidos: creatorLastNameCandidate || null,
        usuario_email: creatorEmailCandidate || null,
        doctor_id: toIntOrNull(appointment.doctor_id),
      };

      out.appointment = mergeContextObject(out.appointment, appointmentPatch);
      out.cita = mergeContextObject(out.cita, {
        ...appointmentPatch,
      });

      const creatorId = toIntOrNull(appointment.created_by);
      if (creatorId) {
        const creator = await Usuario.findByPk(creatorId, {
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
          raw: true,
        });
        if (creator) {
          const creatorContext = buildPersonContext(creator.nombre, creator.apellidos, creator.email_usuario);
          out.appointment = mergeContextObject(out.appointment, {
            usuario_nombre: creatorContext.nombre || null,
            usuario_apellidos: creatorContext.apellidos || null,
            usuario_email: creatorContext.email || null,
          });
          out.cita = mergeContextObject(out.cita, {
            usuario_nombre: creatorContext.nombre || null,
            usuario_apellidos: creatorContext.apellidos || null,
            usuario_email: creatorContext.email || null,
          });
          out.usuario = mergeContextObject(out.usuario, creatorContext);
        }
      } else if (creatorNameCandidate || creatorLastNameCandidate || creatorEmailCandidate) {
        out.usuario = mergeContextObject(
          out.usuario,
          buildPersonContext(creatorNameCandidate, creatorLastNameCandidate, creatorEmailCandidate)
        );
      }

      const professionalId = toIntOrNull(appointment.doctor_id);
      if (professionalId) {
        const professional = await Usuario.findByPk(professionalId, {
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
          raw: true,
        });
        if (professional) {
          out.profesional = mergeContextObject(
            out.profesional,
            buildPersonContext(professional.nombre, professional.apellidos, professional.email_usuario)
          );
        }
      } else if (professionalNameCandidate || professionalLastNameCandidate || professionalEmailCandidate) {
        out.profesional = mergeContextObject(
          out.profesional,
          buildPersonContext(professionalNameCandidate, professionalLastNameCandidate, professionalEmailCandidate)
        );
      }
    }
  }

  const effectivePatientId = patientId
    || toIntOrNull(out?.appointment?.paciente_id)
    || toIntOrNull(out?.cita?.paciente_id)
    || toIntOrNull(out?.trigger?.data?.paciente_id)
    || toIntOrNull(out?.trigger?.data?.patient_id);

  if (effectivePatientId) {
    const patient = await db.Paciente.findByPk(effectivePatientId, {
      attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email', 'idioma_preferido'],
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
        idioma_preferido: normalizeWhatsappLocale(patient.idioma_preferido, { fallback: 'es' }),
        preferred_language: normalizeWhatsappLocale(patient.idioma_preferido, { fallback: 'es' }),
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
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica', 'direccion', 'telefono', 'url_web', 'url_ficha_local', 'configuracion'],
      raw: true,
    });
    if (clinic) {
      const clinicConfiguration = parseClinicConfig(clinic.configuracion) || {};
      const accessGuidance = normalizeAccessGuidance(clinicConfiguration.access_guidance);
      const appointmentType = cleanString(
        out?.cita?.tipo_cita
        || out?.appointment?.tipo_cita
        || out?.trigger?.data?.tipo_cita
      );
      const clinicPatchBase = {
        id: toIntOrNull(clinic.id_clinica),
        id_clinica: toIntOrNull(clinic.id_clinica),
        clinic_id: toIntOrNull(clinic.id_clinica),
        clinica_id: toIntOrNull(clinic.id_clinica),
        group_id: toIntOrNull(clinic.grupoClinicaId),
        grupo_id: toIntOrNull(clinic.grupoClinicaId),
        nombre: cleanString(clinic.nombre_clinica),
        nombre_clinica: cleanString(clinic.nombre_clinica),
        direccion: cleanString(clinic.direccion),
        telefono: cleanString(clinic.telefono),
        url_web: cleanString(clinic.url_web),
        url_ficha_local: cleanString(clinic.url_ficha_local),
        timezone: resolveClinicTimezoneFromContext({ clinic }),
        configuracion: clinic.configuracion || null,
        access_guidance: accessGuidance,
        access_guidance_enabled: accessGuidance.enabled,
        access_guidance_reminder_enabled: isAccessGuidanceReminderBranchEnabled({
          appointmentType,
          accessGuidance,
        }),
        indicaciones_acceso: accessGuidance.directions,
        access_guidance_image_asset_id: accessGuidance.image_asset_id,
        access_guidance_image_url: accessGuidance.image_url,
      };
      const appointmentStart = out?.appointment?.inicio || out?.cita?.inicio;
      if (appointmentStart) {
        const appointmentLocalDateTime = formatAppointmentLocalDateTime(
          appointmentStart,
          clinicPatchBase.timezone
        );
        out.appointment = mergeContextObject(out.appointment, appointmentLocalDateTime);
        out.cita = mergeContextObject(out.cita, appointmentLocalDateTime);
      }
      const clinicLinks = await resolveClinicGoogleLocalLinks(clinic);
      const clinicPatch = mergeClinicLinksIntoContext(clinicPatchBase, clinicLinks);
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
    appointment_created_at: out?.appointment?.created_at || out?.cita?.created_at || null,
    created_at: out?.appointment?.created_at || out?.cita?.created_at || out?.trigger?.data?.created_at || null,
    patient_id: toIntOrNull(out?.patient?.id_paciente) || toIntOrNull(out?.paciente?.id_paciente) || null,
    paciente_id: toIntOrNull(out?.patient?.id_paciente) || toIntOrNull(out?.paciente?.id_paciente) || null,
    clinic_id: toIntOrNull(out?.clinic?.id_clinica) || toIntOrNull(out?.clinica?.id_clinica) || null,
    clinica_id: toIntOrNull(out?.clinic?.id_clinica) || toIntOrNull(out?.clinica?.id_clinica) || null,
    clinic_timezone: cleanString(out?.clinic?.timezone) || cleanString(out?.clinica?.timezone) || null,
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

function emitAppointmentSocketEvent(appointment, eventName = 'appointment:updated') {
  const io = getIO();
  if (!io || !appointment) return;

  const clinicId = toIntOrNull(appointment.clinica_id || appointment.clinic_id);
  const appointmentId = toIntOrNull(appointment.id_cita || appointment.id);
  if (!clinicId || !appointmentId) return;

  const payload = {
    appointment_id: appointmentId,
    clinic_id: clinicId,
    patient_id: toIntOrNull(appointment.paciente_id || appointment.patient_id),
    lead_intake_id: toIntOrNull(appointment.lead_intake_id),
    doctor_id: toIntOrNull(appointment.doctor_id),
    instalacion_id: toIntOrNull(appointment.instalacion_id),
    tratamiento_id: toIntOrNull(appointment.tratamiento_id),
    estado: cleanString(appointment.estado),
    inicio: appointment.inicio || null,
    fin: appointment.fin || null,
    updated_at: appointment.updated_at || appointment.updatedAt || new Date().toISOString(),
    created_at: appointment.created_at || appointment.createdAt || new Date().toISOString(),
  };

  io.to(`clinic:${clinicId}`).emit(eventName, payload);
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
  // "Mensaje: {{last_prompt}}\nRespuesta: {{last_response}}"
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
  const complexModel = cleanString(process.env.GROQ_MODEL_COMPLEX) || 'llama-3.3-70b-versatile';

  if (analysisMode === 'quick_qa') return fastModel;
  if (analysisMode === 'complex_reasoning') return complexModel;

  const totalChars = String(prompt || '').length + String(inputText || '').length;
  const outputFields = Object.keys(outputFormat || {}).length;
  const complexityKeywords = /cita|appointment|historial|database|base de datos|sql|clasifica|analiza|resume|extrae|diagnost/i;
  const joined = `${prompt || ''} ${inputText || ''}`;
  const isComplex = totalChars > 900 || outputFields > 3 || complexityKeywords.test(joined);
  return isComplex ? complexModel : fastModel;
}

function isGroqModelUnavailableError(err) {
  const statusCode = err?.response?.status;
  const providerMessage = cleanString(
    err?.response?.data?.error?.message
    || err?.response?.data?.message
    || err?.message
  ).toLowerCase();

  if (!providerMessage) return false;
  if (![400, 404].includes(Number(statusCode))) return false;

  return (
    providerMessage.includes('decommissioned')
    || providerMessage.includes('no longer supported')
    || providerMessage.includes('model_not_found')
    || providerMessage.includes('model not found')
    || providerMessage.includes('does not exist')
  );
}

function getGroqModelCandidates(primaryModel) {
  const fallbackEnv = cleanString(process.env.GROQ_MODEL_FALLBACKS);
  const fallbackFromEnv = fallbackEnv
    ? fallbackEnv.split(',').map((item) => cleanString(item)).filter(Boolean)
    : [];

  const defaults = [
    'llama-3.3-70b-versatile',
    'qwen/qwen3-32b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.1-8b-instant',
  ];

  const deduped = new Set([cleanString(primaryModel), ...fallbackFromEnv, ...defaults].filter(Boolean));
  return Array.from(deduped);
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
    'El texto del paciente puede estar en español, catalán o inglés. Clasifica la intención por el contenido real, con independencia del idioma de la plantilla enviada.',
    'No traduzcas ni inventes una intención basándote únicamente en el idioma configurado del paciente.',
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
    console.error('[ai_analysis] GROQ_API_KEY ausente en runtime activo', {
      pid: process.pid,
      cwd: process.cwd(),
      port: process.env.PORT || null,
      runtimeNamespace: process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE || null,
      hasBaseUrl: !!cleanString(process.env.GROQ_API_BASE_URL),
    });
    throw new Error('groq_api_key_not_configured');
  }

  const baseUrl = (cleanString(process.env.GROQ_API_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const timeoutMs = Math.max(1000, Number.parseInt(String(process.env.GROQ_TIMEOUT_MS || '20000'), 10) || 20000);
  const normalizedMode = normalizeAiAnalysisMode(analysisMode);
  const normalizedFormat = normalizeAiOutputFormat(outputFormat);
  const normalizedOutputFields = normalizeOutputFieldEntries(outputFields);
  const preferredModel = pickGroqModel({
    analysisMode: normalizedMode,
    prompt,
    inputText,
    outputFormat: normalizedFormat,
  });
  const modelCandidates = getGroqModelCandidates(preferredModel);

  const resolvedMaxTokens = Number(maxTokens);
  const finalMaxTokens = Number.isFinite(resolvedMaxTokens) && resolvedMaxTokens > 0
    ? Math.min(4096, Math.floor(resolvedMaxTokens))
    : 700;

  let response = null;
  let usedModel = preferredModel;
  let lastErr = null;

  for (const candidateModel of modelCandidates) {
    try {
      response = await axios.post(
        `${baseUrl}/chat/completions`,
        {
          model: candidateModel,
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
      usedModel = candidateModel;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isGroqModelUnavailableError(err)) {
        break;
      }
    }
  }

  if (!response) {
    const statusCode = lastErr?.response?.status;
    const providerMessage = cleanString(
      lastErr?.response?.data?.error?.message
      || lastErr?.response?.data?.message
      || lastErr?.message
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
    _ai_model: usedModel,
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

function readFirstIntFromOutputValues(context, keys) {
  const outputs = context?.outputs && typeof context.outputs === 'object'
    ? Object.values(context.outputs).filter((value) => value && typeof value === 'object')
    : [];

  for (const output of outputs) {
    for (const key of keys) {
      const parsed = toIntOrNull(output?.[key]);
      if (parsed) return parsed;
    }
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
  ]) || readFirstIntFromOutputValues(context, [
    'clinic_id',
    'clinica_id',
    'sender_clinic_id',
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
  if (!appointmentId && ['appointment', 'appointment_created'].includes(triggerType)) {
    appointmentId = triggerEntityId;
  }

  let leadIntakeId = readFirstIntFromPaths(context, [
    'lead.id',
    'lead.lead_intake_id',
    'lead.id_lead',
    'trigger.data.lead_intake_id',
    'trigger.data.lead_id',
    'trigger.data.id_lead',
  ]) || readFirstIntFromOutputValues(context, [
    'lead_id',
    'lead_intake_id',
    'recipient_lead_id',
  ]);
  if (!leadIntakeId && ['lead', 'lead_intake', 'leadintake', 'lead_nuevo'].includes(triggerType)) {
    leadIntakeId = triggerEntityId;
  }

  let conversationId = readFirstIntFromPaths(context, [
    'conversation.id',
    'trigger.data.conversation_id',
    'trigger.data.chat_conversation_id',
    'trigger.data.conversationId',
  ]) || readFirstIntFromOutputValues(context, [
    'conversation_id',
    'chat_conversation_id',
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
  ]) || readFirstIntFromOutputValues(context, [
    'patient_id',
    'paciente_id',
    'recipient_patient_id',
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
    if (['appointment', 'appointment_created'].includes(triggerType)) {
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

async function enrichConversationContext(context, targets = {}) {
  const baseContext = context && typeof context === 'object' ? context : {};
  const conversationContext = await buildConversationContext({
    Conversation,
    Message,
    conversationId: toIntOrNull(targets.conversation_id),
    clinicId: toIntOrNull(targets.clinic_id),
    leadId: toIntOrNull(targets.lead_intake_id),
    patientId: toIntOrNull(targets.patient_id),
  });

  if (!conversationContext?.conversation) {
    return baseContext;
  }

  return mergeContextPatch(baseContext, {
    conversation: {
      ...(baseContext?.conversation && typeof baseContext.conversation === 'object' ? baseContext.conversation : {}),
      ...conversationContext.conversation,
    },
    conversation_today: conversationContext.conversation_today || null,
    conversation_this_year: conversationContext.conversation_this_year || null,
    conversation_all_time: conversationContext.conversation_all_time || null,
  });
}

function findFirstConversationIdInOutputs(context = {}) {
  const outputs = context?.outputs && typeof context.outputs === 'object' ? context.outputs : {};
  for (const entry of Object.values(outputs)) {
    const conversationId = toIntOrNull(entry?.conversation_id);
    if (conversationId) {
      return conversationId;
    }
  }
  return null;
}

function buildSystemNavigationContext(context = {}, targets = {}) {
  const conversationId = toIntOrNull(
    getByPath(context, 'conversation.id')
    || findFirstConversationIdInOutputs(context)
    || targets.conversation_id
  );
  const patientId = toIntOrNull(
    getByPath(context, 'paciente.id')
    || getByPath(context, 'paciente.id_paciente')
    || getByPath(context, 'patient.id')
    || targets.patient_id
  );

  return {
    system: {
      patient_conversation_link: conversationId ? `/chat/${conversationId}` : null,
      patient_detail_link: patientId ? `/pacientes/detalle/${patientId}` : null,
    },
  };
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

function normalizeWhatsappMessageMode(value) {
  const normalized = normalizeKey(value);
  if (['manual', 'text', 'free_text', 'freetext'].includes(normalized)) return 'manual';
  return 'template';
}

function resolveWhatsappLanguageRouting(config, context) {
  const routing = isObject(config?.language_routing) ? config.language_routing : {};
  const enabled = parseBool(resolveTemplateValue(routing.enabled, context), false);
  const patientLanguage = resolveExecutionCommunicationLanguage(context);
  if (!enabled) {
    return {
      enabled: false,
      patient_language: patientLanguage,
      selected_language: null,
      config,
    };
  }

  if (patientLanguage === 'es') {
    return {
      enabled: true,
      patient_language: patientLanguage,
      selected_language: 'es',
      config,
    };
  }

  const variants = isObject(routing.variants) ? routing.variants : {};
  const variant = isObject(variants[patientLanguage]) ? variants[patientLanguage] : null;
  if (!variant) {
    throw new Error(`whatsapp_language_variant_missing:${patientLanguage}`);
  }

  return {
    enabled: true,
    patient_language: patientLanguage,
    selected_language: patientLanguage,
    config: {
      ...config,
      ...variant,
      language_routing: routing,
    },
  };
}

function resolveConfiguredCatalogFamilyKey(config, key = 'catalog_family_key') {
  return cleanString(config?.[key]);
}

function normalizeFormSubmissionMatchMode(value) {
  const normalized = normalizeKey(value);
  if (FORM_SUBMISSION_MATCH_MODES.has(normalized)) return normalized;
  return 'url_contains';
}

function toLowerSafe(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIntentText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPositiveConfirmationEmojiText(value) {
  const text = cleanString(value);
  if (!text) return false;
  const raw = text.normalize('NFC');
  if (!raw) return false;
  if (POSITIVE_CONFIRMATION_REACTION_EMOJIS.has(raw)) return true;

  const positiveEmojis = Array.from(POSITIVE_CONFIRMATION_REACTION_EMOJIS)
    .sort((a, b) => b.length - a.length);
  let remaining = raw;
  let consumedAny = false;

  for (const emoji of positiveEmojis) {
    if (remaining.includes(emoji)) {
      consumedAny = true;
      remaining = remaining.split(emoji).join('');
    }
  }

  remaining = remaining.replace(/[\s\uFE0F\u200D.!¡¿?,;:]+/g, '');
  return consumedAny && remaining.length === 0;
}

function buildDeterministicConfirmAppointmentTextOutput(context = {}) {
  const rawResponse = cleanString(
    context?.last_response_context?.response_text
    || context?.last_response
  );
  if (isPositiveConfirmationEmojiText(rawResponse)) {
    return {
      decision: 'confirmado',
      confianza: 0.99,
      motivo: `El paciente respondió con ${rawResponse}, interpretado como confirmación positiva.`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'confirm_appointment_positive_text',
      _ai_analysis_mode: 'rule',
    };
  }

  const text = normalizeIntentText(rawResponse);
  if (!text) return null;

  const hardNegativePatterns = [
    /\bno\s+(puedo|podre|podria|voy|ire|asistire|acudire|llego|llegare)\b/,
    /\bno\s+me\s+(va|viene)\s+(bien|genial|perfecto)\b/,
    /\bme\s+(va|viene)\s+mal\b/,
    /\bme\s+va\s+ma\b/,
    /\bno\s+tengo\s+disponibilidad\b/,
    /\bno\s+me\s+encaja\b/,
    /\bme\s+es\s+imposible\b/,
    /\bimposible\b/,
    /\bno\s+puede\s+ser\b/,
    /\bese\s+dia\s+no\b/,
    /\botro\s+dia\b/,
    /\bcambiar\b.*\b(cita|hora|dia|fecha)\b/,
    /\b(reprogramar|reprogramad[ao]s?|posponer|cancelar|anular)\b/,
    // Català
    /\bno\s+(puc|podre|podria|anire|vindre|assistire|arribare)\b/,
    /\bno\s+em\s+(va|ve)\s+be\b/,
    /\bem\s+(va|ve)\s+mal\b/,
    /\b(canviar|reprogramar|ajornar|cancel\s*la(?:r)?|anul\s*la(?:r)?)\b.*\b(cita|hora|dia|data)\b/,
    // English
    /\b(i\s+)?(can\s*t|cannot|won\s*t|will\s+not)\s+(make\s+it|come|attend|arrive|be\s+there)\b/,
    /\b(that|the)\s+(day|time)\s+(doesn\s*t|does\s+not)\s+work\b/,
    /\b(reschedule|postpone|cancel|move)\b.*\b(appointment|time|day|date)\b/,
  ];

  if (hardNegativePatterns.some((pattern) => pattern.test(text))) {
    return {
      decision: 'no_confirmado',
      confianza: 0.99,
      motivo: `La última respuesta del paciente indica que no tiene disponibilidad o pide cambiar la cita: "${rawResponse}".`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'confirm_appointment_negative_text',
      _ai_analysis_mode: 'rule',
    };
  }

  const doubtPatterns = [
    /\b(no\s+se|no\s+lo\s+se|no\s+estoy\s+segur[oa])\b/,
    /\bquizas\b/,
    /\bdepende\b/,
    /\btengo\s+dudas?\b/,
    /\bpuede\s+ser\b/,
    /\blo\s+miro\b/,
    /\bconfirmo\s+luego\b/,
    /\b(no\s+ho\s+se|no\s+n\s+estic\s+segur[ae]?|potser|dep[eè]n|tinc\s+dubtes?|ja\s+confirmare)\b/,
    /\b(i\s+don\s*t\s+know|not\s+sure|maybe|it\s+depends|i\s+ll\s+confirm\s+later)\b/,
  ];

  if (doubtPatterns.some((pattern) => pattern.test(text))) {
    return {
      decision: 'dudas',
      confianza: 0.9,
      motivo: `La última respuesta del paciente no confirma claramente la disponibilidad: "${rawResponse}".`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'confirm_appointment_doubt_text',
      _ai_analysis_mode: 'rule',
    };
  }

  const strongPositivePatterns = [
    /\b(confirmo|confirmado|confirmada|confirmadisimo|confirmadisima)\b/,
    /\b(nos vemos|alli estare|ahi estare|asistire|acudire)\b/,
    /\b(confirmo|confirmat|confirmada|ens\s+veiem|hi\s+sere|vindre|assistire)\b/,
    /\b(i\s+confirm|confirmed|see\s+you|i\s+ll\s+be\s+there|i\s+will\s+be\s+there|i\s+ll\s+attend)\b/,
  ];
  const hasStrongConfirmation = strongPositivePatterns.some((pattern) => pattern.test(text));
  const shortPositiveTexts = new Set([
    'si',
    'si confirmo',
    'confirmo',
    'confirmado',
    'confirmada',
    'ok',
    'okay',
    'vale',
    'perfecto',
    'genial',
    'de acuerdo',
    'recibido',
    'entendido',
    'nos vemos',
    'alli estare',
    'ahi estare',
    'd acord',
    'perfecte',
    'molt be',
    'ens veiem',
    'hi sere',
    'yes',
    'yes i confirm',
    'confirmed',
    'sure',
    'sounds good',
    'see you',
    'i ll be there',
  ]);
  const looksLikeQuestion = /[?¿]/.test(rawResponse);
  const tokenCount = text.split(/\s+/).filter(Boolean).length;
  const hasShortConfirmation = !looksLikeQuestion && tokenCount <= 4 && shortPositiveTexts.has(text);

  if (hasStrongConfirmation || hasShortConfirmation) {
    return {
      decision: 'confirmado',
      confianza: 0.95,
      motivo: `La última respuesta del paciente confirma la cita: "${rawResponse}".`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'confirm_appointment_positive_text',
      _ai_analysis_mode: 'rule',
    };
  }

  return null;
}

function buildDeterministicConfirmAppointmentOutput(context = {}) {
  const textDecision = buildDeterministicConfirmAppointmentTextOutput(context);
  if (textDecision) return textDecision;

  const responseContext = isObject(context?.last_response_context) ? context.last_response_context : {};
  const responseMediaKind = normalizeKey(responseContext.response_media_kind);
  if (responseMediaKind === 'sticker') {
    return {
      decision: 'incongruente',
      confianza: 0.2,
      motivo: 'El paciente respondió con un sticker. El modelo actual no analiza el contenido visual del sticker, por lo que no se puede confirmar la intención automáticamente.',
      _ai_provider: 'deterministic_rule',
      _ai_model: 'confirm_appointment_unreadable_sticker',
      _ai_analysis_mode: 'rule',
    };
  }

  const responseMessageType = normalizeKey(
    responseContext.response_message_type
    || responseContext.message_type
  );

  if (responseMessageType !== 'reaction') {
    return null;
  }

  const reactionEmoji = cleanString(responseContext.reaction_emoji);
  if (!reactionEmoji || !isPositiveConfirmationEmojiText(reactionEmoji)) {
    return null;
  }

  const targetPreview = cleanString(
    responseContext.reaction_target_message_preview
    || responseContext.listened_message_preview
    || context?.last_prompt
  );

  return {
    decision: 'confirmado',
    confianza: 0.99,
    motivo: targetPreview
      ? `Paciente reaccionó ${reactionEmoji} de forma positiva al mensaje "${targetPreview}".`
      : `Paciente reaccionó ${reactionEmoji} de forma positiva al último mensaje de la clínica.`,
    _ai_provider: 'deterministic_rule',
    _ai_model: 'confirm_appointment_positive_reaction',
    _ai_analysis_mode: 'rule',
  };
}

function buildDeterministicAppointmentUnconfirmedReplyOutput(context = {}) {
  const rawResponse = cleanString(
    context?.last_response_context?.response_text
    || context?.last_response
  );

  const positive = buildDeterministicConfirmAppointmentTextOutput(context);
  if (positive && cleanString(positive.decision).toLowerCase() === 'confirmado') {
    return {
      decision: 'confirmar',
      confianza: positive.confianza || 0.95,
      motivo: positive.motivo || 'El paciente confirma que acudirá a la cita.',
      _ai_provider: positive._ai_provider || 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_confirm',
      _ai_analysis_mode: 'rule',
    };
  }

  const text = normalizeIntentText(rawResponse);
  const responseContext = isObject(context?.last_response_context) ? context.last_response_context : {};
  const responseMediaKind = normalizeKey(responseContext.response_media_kind);
  const reactionEmoji = cleanString(responseContext.reaction_emoji);
  if (!text && isPositiveConfirmationEmojiText(reactionEmoji)) {
    return {
      decision: 'confirmar',
      confianza: 0.99,
      motivo: `El paciente reaccionó ${reactionEmoji} de forma positiva al aviso.`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_reaction_confirm',
      _ai_analysis_mode: 'rule',
    };
  }

  if (!text && responseMediaKind === 'sticker') {
    return {
      decision: 'duda',
      confianza: 0.2,
      motivo: 'El paciente respondió con un sticker. El modelo actual no analiza el contenido visual del sticker, por lo que recepción debe revisarlo.',
      _ai_provider: 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_unreadable_sticker',
      _ai_analysis_mode: 'rule',
    };
  }

  if (!text) {
    return {
      decision: 'duda',
      confianza: 0.2,
      motivo: 'No hay texto suficiente para confirmar o reprogramar.',
      _ai_provider: 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_empty',
      _ai_analysis_mode: 'rule',
    };
  }

  const cancelPatterns = [
    /\b(cancelar|cancela|cancelad[ao]s?|anular|anula|dar\s+de\s+baja)\b/,
    /\b(no\s+voy|no\s+ire|no\s+asistire|no\s+acudire)\b/,
    /\b(la\s+perdemos|no\s+la\s+quiero|mejor\s+no)\b/,
    /\b(cancel\s*la(?:r)?|anul\s*la(?:r)?|donar\s+de\s+baixa)\b/,
    /\b(no\s+(hi\s+anire|vindre|assistire))\b/,
    /\b(cancel|cancel\s+it|i\s+won\s*t\s+(come|attend)|i\s+will\s+not\s+(come|attend))\b/,
  ];
  if (cancelPatterns.some((pattern) => pattern.test(text))) {
    return {
      decision: 'cancelar',
      confianza: 0.95,
      motivo: `La respuesta del paciente indica cancelación: "${rawResponse}".`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_cancel',
      _ai_analysis_mode: 'rule',
    };
  }

  const reschedulePatterns = [
    /\b(reprogramar|reprograma|cambiar|cambio|mover|mueve|posponer|aplazar|otra\s+hora|otro\s+dia|otro\s+d[ií]a|mas\s+tarde|más\s+tarde)\b/,
    /\b(no\s+puedo|me\s+viene\s+mal|me\s+va\s+mal|no\s+me\s+encaja|imposible)\b/,
    /\b(reprogramar|canviar|moure|ajornar|una\s+altra\s+hora|un\s+altre\s+dia|mes\s+tard)\b/,
    /\b(no\s+puc|em\s+(va|ve)\s+mal|no\s+em\s+va\s+be)\b/,
    /\b(reschedule|change|move|postpone|another\s+time|another\s+day|later)\b/,
    /\b(can\s*t\s+make\s+it|cannot\s+make\s+it|doesn\s*t\s+work)\b/,
  ];
  if (reschedulePatterns.some((pattern) => pattern.test(text))) {
    return {
      decision: 'reprogramar',
      confianza: 0.92,
      motivo: `La respuesta del paciente pide cambiar la cita: "${rawResponse}".`,
      _ai_provider: 'deterministic_rule',
      _ai_model: 'appointment_unconfirmed_reply_reschedule',
      _ai_analysis_mode: 'rule',
    };
  }

  return {
    decision: 'duda',
    confianza: 0.35,
    motivo: `La respuesta no confirma ni pide reprogramar con claridad: "${rawResponse}".`,
    _ai_provider: 'deterministic_rule',
    _ai_model: 'appointment_unconfirmed_reply_unclear',
    _ai_analysis_mode: 'rule',
  };
}

function isTemplateBlockedForSend(statusValue) {
  const status = toLowerSafe(statusValue);
  return status !== 'approved';
}

function getWhatsappTemplateWabaId(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  return cleanString(plain.waba_id || plain.wabaId);
}

function scoreWhatsappTemplateCandidate(
  template,
  {
    clinicId = null,
    targetWabaId = '',
    requireCurrentCatalogBody = false,
    expectedLocale = null,
    expectedFamilyKey = null,
  } = {}
) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const catalog = plain.catalog?.get ? plain.catalog.get({ plain: true }) : plain.catalog;
  const rowClinicId = toIntOrNull(plain.clinic_id);
  const wabaId = getWhatsappTemplateWabaId(plain);
  const safeClinicId = toIntOrNull(clinicId);
  const safeTargetWabaId = cleanString(targetWabaId);
  const safeExpectedLocale = normalizeWhatsappLocale(expectedLocale);
  const templateLocale = normalizeWhatsappLocale(plain.language || catalog?.locale, { fallback: 'es' });
  const safeExpectedFamilyKey = cleanString(expectedFamilyKey);
  const templateFamilyKey = resolveCatalogFamilyKey(catalog);

  if (safeExpectedLocale && templateLocale !== safeExpectedLocale) return 0;
  if (safeExpectedFamilyKey && templateFamilyKey !== safeExpectedFamilyKey) return 0;

  if (requireCurrentCatalogBody && !matchesCurrentCatalogBody(template)) {
    return 0;
  }

  if (safeClinicId && rowClinicId && rowClinicId !== safeClinicId) {
    return 0;
  }

  if (safeTargetWabaId && wabaId && wabaId !== safeTargetWabaId) {
    return 0;
  }

  let score = isTemplateBlockedForSend(plain.status) ? 0 : 1000;

  if (safeTargetWabaId) {
    score += wabaId === safeTargetWabaId ? 300 : 10;
  }

  if (safeClinicId) {
    score += rowClinicId === safeClinicId ? 60 : 40;
  }

  score += Number(plain.id || 0) / 100000;
  return score;
}

function selectBestWhatsappTemplateCandidate(candidates, options = {}) {
  return (Array.isArray(candidates) ? candidates : [])
    .map((template) => ({
      template,
      score: scoreWhatsappTemplateCandidate(template, options),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.template || null;
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
  if (['1', 'owner', 'propietario'].includes(key)) return 'propietario';
  if (['administrador', 'admin', 'system_admin', 'global_admin'].includes(key)) return 'admin';
  if (['agencia', 'agency'].includes(key)) return 'agencia';
  if (['2', 'staff', 'personal', 'personaldeclinica', 'clinic_staff', 'recepcion', 'recepcion_comercial_ventas'].includes(key)) {
    return 'personaldeclinica';
  }
  if (['3', 'patient', 'paciente'].includes(key)) return 'paciente';
  return null;
}

function normalizeAssigneeRoleCodes(raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  return Array.from(new Set(
    values
      .map((value) => resolveRoleCode(value))
      .filter(Boolean)
  ));
}

async function resolveRoleAssigneeUserIds({ clinicId, effectiveRole, subrole }) {
  if (!clinicId) return [];

  if (effectiveRole === 'admin') {
    const membershipRows = await UsuarioClinica.findAll({
      where: {
        id_clinica: clinicId,
        rol_clinica: { [Op.in]: ['admin', 'administrador'] },
      },
      attributes: ['id_usuario'],
      raw: true,
      limit: 50,
    });

    return Array.from(
      new Set([
        ...ADMIN_USER_IDS,
        ...membershipRows.map((row) => toIntOrNull(row.id_usuario)).filter(Boolean),
      ])
    );
  }

  const where = { id_clinica: clinicId };
  if (effectiveRole) {
    where.rol_clinica = effectiveRole;
  } else {
    where.rol_clinica = { [Op.in]: ['propietario', 'personaldeclinica'] };
  }

  const normalizedSubrole = cleanString(subrole);
  if (normalizedSubrole && (!effectiveRole || effectiveRole === 'personaldeclinica')) {
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

async function resolveTaskAssigneeUserIds({ clinicId, assigneeType, assigneeId, roleCode, subrole }) {
  if (!clinicId) return [];

  const normalizedAssigneeType = normalizeKey(assigneeType) || 'role';
  if (normalizedAssigneeType === 'user') {
    const userId = toIntOrNull(assigneeId);
    if (!userId) return [];
    if (ADMIN_USER_IDS.includes(userId)) {
      return [userId];
    }
    const membership = await UsuarioClinica.findOne({
      where: { id_clinica: clinicId, id_usuario: userId },
      attributes: ['id_usuario'],
      raw: true,
    });
    return membership ? [userId] : [];
  }

  const effectiveRoles = roleCode
    ? [roleCode]
    : normalizeAssigneeRoleCodes(assigneeId);
  const roleTargets = effectiveRoles.length ? effectiveRoles : [null];
  const userIds = [];
  for (const effectiveRole of roleTargets) {
    const roleUserIds = await resolveRoleAssigneeUserIds({
      clinicId,
      effectiveRole,
      subrole,
    });
    userIds.push(...roleUserIds);
  }

  return Array.from(new Set(userIds.filter(Boolean)));
}

async function handleChangeStatus(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  let targets = resolveRuntimeTargets(runtime?.execution, context);
  targets = await backfillRuntimeTargets(runtime?.execution, targets);
  const requestedStatus = resolveTemplateValue(config?.new_status, context);
  const rawStatus = cleanString(requestedStatus);
  if (!rawStatus) {
    throw new Error('change_status_missing_new_status');
  }

  const appointmentStatus = normalizeCitaStatus(rawStatus);
  const leadStatus = normalizeLeadStatus(rawStatus);
  const requestedTarget = normalizeStatusTarget(resolveTemplateValue(config?.target_entity, context));

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
    if (PROTECTED_APPOINTMENT_STATUSES.has(previousStatus) && previousStatus !== appointmentStatus) {
      return {
        kind: 'success',
        output: {
          target_type: 'appointment',
          target_id: appointment.id_cita,
          target_entity: 'appointment',
          previous_status: previousStatus,
          requested_status: appointmentStatus,
          new_status: previousStatus,
          skipped: true,
          reason: 'appointment_status_protected',
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }

    await appointment.update({ estado: appointmentStatus });
    try {
      const templateVersion = runtime?.execution?.templateVersion || null;
      await recordAppointmentStatusChange({
        appointment,
        previousStatus,
        newStatus: appointmentStatus,
        source: 'automation_v2',
        metadata: {
          flow_execution_id: toIntOrNull(runtime?.execution?.id),
          flow_template_version_id: toIntOrNull(runtime?.execution?.template_version_id),
          flow_public_id: cleanString(templateVersion?.public_id),
          flow_name: cleanString(templateVersion?.name),
          flow_version: toIntOrNull(templateVersion?.version),
          node_id: cleanString(node?.id),
          trigger_type: cleanString(runtime?.execution?.trigger_type),
        },
      });
    } catch (activityError) {
      console.warn('[AutomationsV2] No se pudo registrar la transición de cita:', activityError.message || activityError);
    }
    if (APPOINTMENT_NOTIFICATION_RESOLVED_STATUSES.has(appointmentStatus)) {
      await appointmentNotificationCleanup.markAutomationNotificationsReadForAppointment(appointment.id_cita, {
        reason: `appointment_status_${appointmentStatus}`,
      });
    }
    emitAppointmentSocketEvent(appointment, 'appointment:updated');

    return {
      kind: 'success',
      output: {
        target_type: 'appointment',
        target_id: appointment.id_cita,
        target_entity: 'appointment',
        previous_status: previousStatus,
        new_status: appointmentStatus,
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

async function validateAccessGuidancePublicMediaAsset({ clinicId, accessGuidance }) {
  const normalized = normalizeAccessGuidance(accessGuidance);
  if (!PublicMediaAsset || !normalized.image_asset_id || !normalized.image_url) {
    return 'access_guidance_image_asset_unavailable';
  }
  let asset = null;
  try {
    asset = await PublicMediaAsset.findOne({
      where: {
        id: normalized.image_asset_id,
        scope_type: 'clinic',
        clinica_id: Number(clinicId),
        purpose: 'clinic_access_image',
        sensitivity: 'public',
        status: 'active',
      },
      attributes: ['id', 'public_url'],
      raw: true,
    });
  } catch (_) {
    return 'access_guidance_image_asset_validation_failed';
  }
  if (!asset) return 'access_guidance_image_asset_unavailable';
  if (cleanString(asset.public_url) !== cleanString(normalized.image_url)) {
    return 'access_guidance_image_asset_url_mismatch';
  }
  return null;
}

async function enqueueQuietHoursWhatsappJob({ messageId, conversationId, scheduledAt }) {
  const normalizedMessageId = toIntOrNull(messageId);
  const normalizedConversationId = toIntOrNull(conversationId);
  const nextRunAt = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt || '');
  if (!normalizedMessageId || !normalizedConversationId || !Number.isFinite(nextRunAt.getTime())) {
    throw new Error('automation_whatsapp_quiet_send_invalid_schedule');
  }

  const { job } = await jobRequestsService.enqueueUniqueJobRequest({
    type: QUIET_HOURS_WHATSAPP_JOB_TYPE,
    priority: 'high',
    status: 'waiting',
    origin: 'automations_v2_quiet_hours',
    maxAttempts: 5,
    nextRunAt,
    dedupeScope: `message:${normalizedMessageId}`,
    // El JobRequest no persiste destinatario, contenido ni credenciales. El
    // handler los recompone en el momento de entrega desde Message y assets.
    payload: {
      message_id: normalizedMessageId,
      conversation_id: normalizedConversationId,
      scheduled_for: nextRunAt.toISOString(),
    },
  });
  return job;
}

async function resolveScheduledWhatsappSenderConfig({ metadata, clinicId }) {
  const expectedPhoneNumberId = cleanString(metadata?.phoneNumberId || metadata?.phoneId);
  const expectedWabaId = cleanString(metadata?.wabaId);
  const assertSnapshotMatch = (config) => {
    if (expectedPhoneNumberId && cleanString(config?.phoneNumberId) !== expectedPhoneNumberId) {
      throw new Error('whatsapp_sender_snapshot_phone_mismatch');
    }
    if (expectedWabaId && cleanString(config?.wabaId) !== expectedWabaId) {
      throw new Error('whatsapp_sender_snapshot_waba_mismatch');
    }
    return config;
  };
  const senderOriginId = toIntOrNull(metadata?.sender_origin_id);
  if (senderOriginId) {
    const specific = await resolveSpecificSenderConfig({ senderOriginId, clinicId });
    if (!specific?.accessToken || !specific?.phoneNumberId) {
      throw new Error('whatsapp_sender_origin_missing_credentials');
    }
    return assertSnapshotMatch(specific);
  }

  const scheduledPhoneNumberId = expectedPhoneNumberId;
  if (scheduledPhoneNumberId) {
    const originalAsset = await ClinicMetaAsset.findOne({
      where: {
        assetType: 'whatsapp_phone_number',
        phoneNumberId: scheduledPhoneNumberId,
        isActive: true,
      },
      attributes: ['id'],
      order: [['updatedAt', 'DESC']],
      raw: true,
    });
    if (!originalAsset?.id) {
      throw new Error('whatsapp_sender_snapshot_unavailable');
    }
    const specific = await resolveSpecificSenderConfig({ senderOriginId: originalAsset.id, clinicId });
    if (!specific?.accessToken || !specific?.phoneNumberId) {
      throw new Error('whatsapp_sender_origin_missing_credentials');
    }
    return assertSnapshotMatch(specific);
  }

  const clinicConfig = await whatsappService.getClinicConfig(clinicId);
  if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
    throw new Error('whatsapp_config_missing');
  }
  return assertSnapshotMatch(clinicConfig);
}

async function enqueueAutomationWhatsappTransport({
  msg,
  conversation,
  recipient,
  dispatchKind,
  retryOnFailure = true,
}) {
  const messageId = toIntOrNull(msg?.id);
  const conversationId = toIntOrNull(conversation?.id || msg?.conversation_id);
  const normalizedRecipient = whatsappService.normalizePhoneNumber(recipient);
  if (!messageId || !conversationId || !normalizedRecipient) {
    throw new Error('automation_whatsapp_transport_payload_invalid');
  }

  const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  const transportJobOptions = buildAutomationWhatsappTransportJobOptions(messageId);
  const transportJobId = String(transportJobOptions.jobId);
  const dispatchedAt = new Date().toISOString();
  const normalizedDispatchKind = cleanString(dispatchKind) || 'immediate';

  // El snapshot y el id determinista se guardan antes de publicar el job. Asi
  // un worker rapido nunca puede ser pisado de sent a pending por el productor.
  await msg.update({
    status: 'pending',
    metadata: {
      ...metadata,
      automation_transport_dispatch_kind: normalizedDispatchKind,
      automation_transport_dispatched_at: dispatchedAt,
      automation_transport_job_id: transportJobId,
      enqueue_error: null,
      ...(normalizedDispatchKind === 'quiet_hours'
        ? {
            quiet_hours_job_dispatched_at: dispatchedAt,
            quiet_hours_transport_job_id: transportJobId,
          }
        : {
            immediate_transport_job_id: transportJobId,
          }),
    },
  });

  const transportJob = await queues.outboundWhatsApp.add('send', {
    messageId,
    conversationId,
    to: normalizedRecipient,
    body: msg.content || '',
    useTemplate: String(msg.message_type || '').toLowerCase() === 'template',
    templateName: cleanString(metadata.template_name),
    templateLanguage: cleanString(metadata.template_language) || 'es_ES',
    templateParams: metadata.template_params && typeof metadata.template_params === 'object'
      ? metadata.template_params
      : {},
    templateComponents: Array.isArray(metadata.template_components)
      ? metadata.template_components
      : null,
    retryOnFailure: retryOnFailure === true,
    resolveClinicConfigAtSend: true,
    clinicId: toIntOrNull(conversation?.clinic_id),
  }, transportJobOptions);

  return {
    transportJob,
    transportJobId: String(transportJob?.id || transportJobId),
  };
}

async function runScheduledWhatsappSendJob(payload = {}) {
  const messageId = toIntOrNull(payload.message_id || payload.messageId);
  if (!messageId) {
    throw new Error('automation_whatsapp_quiet_send requires payload.message_id');
  }

  const msg = await Message.findByPk(messageId);
  if (!msg) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'message_not_found', message_id: messageId },
    };
  }

  const currentStatus = toLowerSafe(msg.status);
  if (['sent', 'delivered', 'read'].includes(currentStatus)) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'already_sent', message_id: messageId },
    };
  }

  const metadata = msg.metadata && typeof msg.metadata === 'object' ? msg.metadata : {};
  const scheduledAt = new Date(payload.scheduled_for || metadata.scheduled_for || '');
  if (Number.isFinite(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now() + 1000) {
    return {
      status: 'waiting',
      nextAllowedAt: scheduledAt,
      result: { waiting: true, message_id: messageId, scheduled_for: scheduledAt.toISOString() },
    };
  }

  const conversationId = toIntOrNull(payload.conversation_id || payload.conversationId || msg.conversation_id);
  if (!conversationId || Number(msg.conversation_id) !== conversationId) {
    throw new Error('automation_whatsapp_quiet_send conversation mismatch');
  }
  const conversation = await Conversation.findByPk(conversationId);
  if (!conversation) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'conversation_not_found', message_id: messageId },
    };
  }

  const clinicId = toIntOrNull(conversation.clinic_id);
  const recipient = whatsappService.normalizePhoneNumber(metadata.recipient);
  if (!clinicId || !recipient) {
    throw new Error('automation_whatsapp_quiet_send missing clinic or recipient');
  }
  const { transportJobId } = await enqueueAutomationWhatsappTransport({
    msg,
    conversation,
    recipient,
    dispatchKind: 'quiet_hours',
    retryOnFailure: metadata.access_guidance_variant_requested === true,
  });

  return {
    status: 'completed',
    result: {
      message_id: messageId,
      conversation_id: conversationId,
      transport_job_id: transportJobId,
    },
  };
}

function resolveTemplateVariablesWithKeys(
  config,
  context,
  template = null,
  {
    namedKey = 'variables_named',
    positionalKey = 'variables',
  } = {}
) {
  const templateVariables = buildWhatsappTemplateVariableContract(template);
  const rawNamed = normalizeNamedBindings(config?.[namedKey]);
  const rawPositional = normalizePositionalBindings(config?.[positionalKey]);

  if (!templateVariables.length) {
    const legacyOutput = {};
    for (const [key, value] of Object.entries(rawPositional)) {
      const resolved = resolveTemplateValue(value, context);
      if (resolved === undefined || resolved === null || resolved === '') continue;
      legacyOutput[key] = String(resolved);
    }
    return legacyOutput;
  }

  const effectiveNamed = buildEffectiveNamedBindings(
    rawNamed,
    rawPositional,
    templateVariables
  );
  const positionalBindings = buildPositionalBindingsFromNamed(
    effectiveNamed,
    rawPositional,
    templateVariables
  );

  const output = {};
  for (const [key, value] of Object.entries(positionalBindings)) {
    const resolved = resolveTemplateValue(value, context);
    if (resolved === undefined || resolved === null || resolved === '') continue;
    output[key] = String(resolved);
  }
  return output;
}

function resolveTemplateVariables(config, context, template = null) {
  return resolveTemplateVariablesWithKeys(config, context, template, {
    namedKey: 'variables_named',
    positionalKey: 'variables',
  });
}

async function loadConfiguredWhatsappTemplate(
  config,
  context,
  {
    templateIdKey = 'template_id',
    templateNameKey = 'template_name',
    catalogTemplateIdKey = 'catalog_template_id',
    targetWabaId = '',
    requireCurrentCatalogBody = false,
    expectedLocale = null,
    expectedFamilyKey = null,
  } = {}
) {
  const templateId = toIntOrNull(resolveTemplateValue(config?.[templateIdKey], context));
  const templateName = cleanString(resolveTemplateValue(config?.[templateNameKey], context));
  const catalogTemplateId = toIntOrNull(resolveTemplateValue(config?.[catalogTemplateIdKey], context));
  const clinicId = toIntOrNull(
    context?.appointment?.clinica_id
      || context?.appointment?.clinic_id
      || context?.cita?.clinica_id
      || context?.cita?.clinic_id
      || context?.trigger?.data?.clinica_id
      || context?.trigger?.data?.clinic_id
      || context?.clinic?.id
      || context?.clinic_id
  );

  const baseQuery = {
    attributes: ['id', 'name', 'language', 'status', 'components', 'catalog_template_id', 'clinic_id', 'waba_id'],
    include: [{
      model: WhatsappTemplateCatalog,
      as: 'catalog',
      attributes: ['id', 'name', 'family_key', 'locale', 'variables', 'body_text'],
    }],
  };

  if (catalogTemplateId) {
    const candidates = await WhatsappTemplate.findAll({
      ...baseQuery,
      where: {
        catalog_template_id: catalogTemplateId,
        is_active: true,
      },
    });

    const selected = selectBestWhatsappTemplateCandidate(candidates, {
      clinicId,
      targetWabaId,
      requireCurrentCatalogBody,
      expectedLocale,
      expectedFamilyKey,
    });
    if (selected) return selected;
  }

  if (!templateId && !templateName) {
    return null;
  }

  const where = {};
  if (templateId && templateName) {
    where[Op.or] = [{ id: templateId }, { name: templateName }];
  } else if (templateId) {
    where.id = templateId;
  } else {
    where.name = templateName;
  }

  const requested = await WhatsappTemplate.findOne({
    ...baseQuery,
    where,
  });
  if (!requested) return null;
  if (scoreWhatsappTemplateCandidate(requested, {
    clinicId,
    targetWabaId,
    requireCurrentCatalogBody: false,
    expectedLocale,
    expectedFamilyKey,
  }) <= 0) {
    const requestedCatalogId = toIntOrNull(requested.catalog_template_id);
    if (!requestedCatalogId) return null;
    const candidates = await WhatsappTemplate.findAll({
      ...baseQuery,
      where: { catalog_template_id: requestedCatalogId, is_active: true },
    });
    return selectBestWhatsappTemplateCandidate(candidates, {
      clinicId,
      targetWabaId,
      requireCurrentCatalogBody,
      expectedLocale,
      expectedFamilyKey,
    });
  }
  if (requireCurrentCatalogBody && !matchesCurrentCatalogBody(requested)) {
    const requestedCatalogId = toIntOrNull(requested.catalog_template_id);
    if (requestedCatalogId) {
      const candidates = await WhatsappTemplate.findAll({
        ...baseQuery,
        where: {
          catalog_template_id: requestedCatalogId,
          is_active: true,
        },
      });
      return selectBestWhatsappTemplateCandidate(candidates, {
        clinicId,
        targetWabaId,
        requireCurrentCatalogBody,
        expectedLocale,
        expectedFamilyKey,
      });
    }
    return null;
  }

  const requestedWabaId = getWhatsappTemplateWabaId(requested);
  const requestedStatus = toLowerSafe(requested.status);
  const requestedCatalogId = toIntOrNull(requested.catalog_template_id);
  const needsCompatibleReplacement =
    requestedCatalogId
    && (
      isTemplateBlockedForSend(requestedStatus)
      || (cleanString(targetWabaId) && requestedWabaId && requestedWabaId !== cleanString(targetWabaId))
    );

  if (needsCompatibleReplacement) {
    const candidates = await WhatsappTemplate.findAll({
      ...baseQuery,
      where: {
        catalog_template_id: requestedCatalogId,
        is_active: true,
      },
    });
    const replacement = selectBestWhatsappTemplateCandidate(candidates, {
      clinicId,
      targetWabaId,
      requireCurrentCatalogBody,
      expectedLocale,
      expectedFamilyKey,
    });
    if (replacement) return replacement;
    if (cleanString(targetWabaId) && requestedWabaId && requestedWabaId !== cleanString(targetWabaId)) {
      return null;
    }
  }

  return requested;
}

function buildAutomationWhatsappDeliveryKey(execution, node) {
  const executionId = toIntOrNull(execution?.id);
  const nodeId = cleanString(node?.id);
  const deliverySlot = cleanString(node?.config?.delivery_slot)
    ?.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!executionId) return null;
  if (deliverySlot) return `flow:${executionId}:slot:${deliverySlot}`;
  if (!nodeId) return null;
  return `flow:${executionId}:node:${nodeId}`;
}

function buildAutomationWhatsappRowDeliveryKey(deliveryKey, messageType) {
  const normalizedDeliveryKey = cleanString(deliveryKey);
  if (!normalizedDeliveryKey) return null;
  return `${normalizedDeliveryKey}:${messageType === 'event' ? 'event' : 'outbound'}`;
}

async function findAutomationWhatsappMessageByDeliveryKey({
  conversationId = null,
  deliveryKey,
  messageType = 'template',
  transaction = null,
}) {
  const normalizedDeliveryKey = cleanString(deliveryKey);
  if (!normalizedDeliveryKey) return null;
  const messageTypes = Array.isArray(messageType) ? messageType : [messageType];
  const normalizedMessageTypes = messageTypes
    .map((value) => cleanString(value))
    .filter(Boolean);
  if (!normalizedMessageTypes.length) return null;
  const rowDeliveryKey = buildAutomationWhatsappRowDeliveryKey(
    normalizedDeliveryKey,
    normalizedMessageTypes.includes('event') ? 'event' : 'outbound'
  );
  const normalizedConversationId = toIntOrNull(conversationId);

  return Message.findOne({
    where: {
      ...(normalizedConversationId ? { conversation_id: normalizedConversationId } : {}),
      direction: 'outbound',
      message_type: normalizedMessageTypes.length === 1
        ? normalizedMessageTypes[0]
        : { [Op.in]: normalizedMessageTypes },
      [Op.or]: [
        { automation_delivery_key: rowDeliveryKey },
        db.Sequelize.where(
          db.Sequelize.literal("JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.automation_delivery_key'))"),
          normalizedDeliveryKey
        ),
      ],
    },
    order: [['id', 'ASC']],
    transaction,
  });
}

async function findOrCreateAutomationWhatsappMessage({
  deliveryKey,
  messageType,
  values,
}) {
  const normalizedDeliveryKey = cleanString(deliveryKey);
  if (!normalizedDeliveryKey) {
    return { message: await Message.create(values), created: true };
  }

  const rowDeliveryKey = buildAutomationWhatsappRowDeliveryKey(normalizedDeliveryKey, messageType);
  const [message, created] = await Message.findOrCreate({
    where: { automation_delivery_key: rowDeliveryKey },
    defaults: {
      ...values,
      automation_delivery_key: rowDeliveryKey,
    },
  });
  return { message, created };
}

function readStoredWhatsappReplaySelection(metadata) {
  const stored = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    template_id: stored.template_id || null,
    template_name: stored.template_name || null,
    patient_language: stored.patient_language || null,
    selected_language: stored.selected_language || stored.template_language || null,
    template_language: stored.template_language || null,
    template_family_key: stored.template_family_key || null,
    template_params: clone(stored.template_params) || {},
  };
}

async function reuseExistingAutomationWhatsappMessage({ existingMessage, node }) {
  const existingMetadata = existingMessage?.metadata && typeof existingMessage.metadata === 'object'
    ? existingMessage.metadata
    : {};
  const storedSelection = readStoredWhatsappReplaySelection(existingMetadata);
  const existingStatus = toLowerSafe(existingMessage?.status) || 'pending';
  const conversation = await Conversation.findByPk(existingMessage?.conversation_id);
  if (!conversation) {
    throw new Error('whatsapp_replay_conversation_not_found');
  }

  let transportJobId = cleanString(existingMetadata.automation_transport_job_id);
  let quietHoursJobRequestId = toIntOrNull(existingMetadata.quiet_hours_job_request_id);
  let outputStatus = existingStatus;
  const finalStatuses = new Set(['sent', 'delivered', 'read']);
  const queuedByQuietHours = existingMetadata.queued_by_quiet_hours === true;
  const scheduledFor = new Date(existingMetadata.scheduled_for || '');
  const hasValidSchedule = Number.isFinite(scheduledFor.getTime());
  const scheduleStillWaiting = queuedByQuietHours
    && hasValidSchedule
    && scheduledFor.getTime() > Date.now() + 1000;

  if (!finalStatuses.has(existingStatus)) {
    if (scheduleStillWaiting) {
      const scheduledJob = await enqueueQuietHoursWhatsappJob({
        messageId: existingMessage.id,
        conversationId: conversation.id,
        scheduledAt: scheduledFor,
      });
      quietHoursJobRequestId = toIntOrNull(scheduledJob?.id) || quietHoursJobRequestId;
      await existingMessage.update({
        status: 'pending',
        metadata: {
          ...existingMetadata,
          quiet_hours_job_request_id: quietHoursJobRequestId,
          enqueue_error: null,
        },
      });
      outputStatus = 'scheduled';
    } else {
      const enqueuePreviouslyFailed = existingStatus === 'failed'
        && !!cleanString(existingMetadata.enqueue_error);
      if (existingStatus === 'failed' && !enqueuePreviouslyFailed) {
        throw new Error(
          `whatsapp_previous_delivery_failed:${cleanString(existingMetadata.error) || 'unknown'}`
        );
      }

      const usesDurableTransport = existingMetadata.access_guidance_variant_requested === true
        || queuedByQuietHours;
      if (!usesDurableTransport && !transportJobId) {
        // En el transporte sin outbox un pending no demuestra si el POST a
        // Meta llego a ejecutarse. No se reenvia a ciegas: evita duplicados.
        throw new Error('whatsapp_previous_delivery_state_unknown');
      }
      if (!transportJobId || enqueuePreviouslyFailed) {
        const dispatch = await enqueueAutomationWhatsappTransport({
          msg: existingMessage,
          conversation,
          recipient: existingMetadata.recipient,
          dispatchKind: queuedByQuietHours ? 'quiet_hours' : 'immediate',
          retryOnFailure: existingMetadata.access_guidance_variant_requested === true,
        });
        transportJobId = dispatch.transportJobId;
      }
      outputStatus = transportJobId ? 'queued' : existingStatus;
    }
  }

  await conversation.update({ last_message_at: new Date() }).catch(() => null);
  return {
    kind: 'success',
    output: {
      message_id: existingMessage.id,
      status: outputStatus,
      replay_reused: true,
      transport_job_id: transportJobId || null,
      job_request_id: quietHoursJobRequestId || null,
      scheduled_for: hasValidSchedule ? scheduledFor.toISOString() : null,
      message_mode: existingMetadata.message_mode || null,
      delivery_mode: existingMetadata.delivery_mode || null,
      template_id: storedSelection.template_id,
      template_name: storedSelection.template_name,
      template_branch: existingMetadata.template_branch || 'base',
      access_guidance_variant_requested: existingMetadata.access_guidance_variant_requested === true,
      access_guidance_variant_used: existingMetadata.access_guidance_variant_used === true,
      access_guidance_fallback_used: existingMetadata.access_guidance_fallback_used === true,
      access_guidance_fallback_reason: existingMetadata.access_guidance_fallback_reason || null,
      patient_language: storedSelection.patient_language,
      selected_language: storedSelection.selected_language,
      language_routing_enabled: existingMetadata.language_routing_enabled === true,
      template_has_image: Array.isArray(existingMetadata.template_components),
      conversation_id: conversation.id,
    },
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

function buildWhatsappTransportHandoffRetryState({
  errorMessage,
  previousRetryAttempt = 0,
  now = new Date(),
} = {}) {
  const normalizedError = cleanString(errorMessage);
  if (!normalizedError.startsWith('whatsapp_enqueue_failed:')) return null;
  const retryAttempt = Math.max(0, Number(previousRetryAttempt) || 0) + 1;
  if (retryAttempt >= 5) {
    return { retry_attempt: retryAttempt, max_attempts: 5, exhausted: true };
  }
  const backoffMs = Math.min(15 * 60 * 1000, 60 * 1000 * (2 ** (retryAttempt - 1)));
  return {
    retry_attempt: retryAttempt,
    max_attempts: 5,
    exhausted: false,
    backoff_ms: backoffMs,
    retry_at: new Date(now.getTime() + backoffMs),
  };
}

function isExplicitAccessGuidanceVariantNode(config) {
  const delivery = isObject(config?.access_guidance_delivery)
    ? config.access_guidance_delivery
    : null;
  return cleanString(delivery?.role) === 'variant'
    && parseBool(delivery?.fallback_on_unavailable, false) === true;
}

function buildFallbackWhatsappTemplateConfig(config) {
  return {
    ...config,
    template_id: config?.fallback_template_id || '',
    template_name: config?.fallback_template_name || '',
    catalog_template_id: config?.fallback_catalog_template_id || null,
    require_current_catalog_body: config?.fallback_require_current_catalog_body === true,
    variables: isObject(config?.fallback_variables) ? config.fallback_variables : {},
    variables_named: isObject(config?.fallback_variables_named) ? config.fallback_variables_named : {},
  };
}

async function registerLeadAutoReplyContactAttempt({ execution, context, node, message }) {
  if (cleanString(node?.config?.template_usage) !== 'lead_auto_reply') return null;
  const targets = resolveRuntimeTargets(execution, context);
  const leadId = toIntOrNull(targets.lead_intake_id);
  const messageId = toIntOrNull(message?.id);
  if (!leadId || !messageId || !LeadContactAttempt) return null;

  const motivo = `lead_auto_reply:${messageId}`;
  return db.sequelize.transaction(async (transaction) => {
    const lead = await LeadIntake.findByPk(leadId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lead) return null;

    const existing = await LeadContactAttempt.findOne({
      where: { lead_intake_id: leadId, canal: 'whatsapp', motivo },
      transaction,
    });
    if (existing) return existing;

    const now = new Date();
    const historial = Array.isArray(lead.historial_contactos) ? [...lead.historial_contactos] : [];
    historial.push({
      fecha: now.toISOString(),
      motivo: 'lead_auto_reply',
      notas: 'Respuesta automática de WhatsApp',
      canal: 'whatsapp',
      usuario_id: null,
      message_id: messageId,
    });
    const protectedStatuses = new Set(['citado', 'acudio_cita', 'convertido', 'descartado']);
    await lead.update({
      historial_contactos: historial,
      num_contactos: (Number(lead.num_contactos || 0) || 0) + 1,
      ultimo_contacto: now,
      status_lead: protectedStatuses.has(cleanString(lead.status_lead).toLowerCase())
        ? lead.status_lead
        : 'contactado',
    }, { transaction });
    return LeadContactAttempt.create({
      lead_intake_id: leadId,
      usuario_id: null,
      canal: 'whatsapp',
      motivo,
      notas: cleanString(message?.content).slice(0, 500) || 'Respuesta automática de WhatsApp',
    }, { transaction });
  });
}

async function handleSendWhatsapp(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const execution = runtime?.execution || null;
  const automationDeliveryKey = buildAutomationWhatsappDeliveryKey(execution, node);
  if (automationDeliveryKey) {
    const existingMessage = await findAutomationWhatsappMessageByDeliveryKey({
      deliveryKey: automationDeliveryKey,
      messageType: ['template', 'text'],
    });
    if (existingMessage) {
      await registerLeadAutoReplyContactAttempt({
        execution,
        context,
        node,
        message: existingMessage,
      });
      return reuseExistingAutomationWhatsappMessage({ existingMessage, node });
    }
  }
  let targets = resolveRuntimeTargets(execution, context);
  targets = await backfillRuntimeTargets(execution, targets);
  const clinicId = toIntOrNull(targets.clinic_id);
  if (!clinicId) {
    throw new Error('whatsapp_clinic_not_found');
  }

  const messageMode = normalizeWhatsappMessageMode(resolveTemplateValue(config?.message_mode, context));
  const quietHoursEnabled = parseBool(resolveTemplateValue(config?.quiet_hours_enabled, context), true);
  const outsideSendWindowPolicy = normalizeOutsideSendWindowPolicy(
    resolveTemplateValue(config?.outside_send_window_policy || config?.send_window_policy, context)
  );
  const quietWindow = computeQuietHoursDelayMs({
    now: new Date(),
    enabled: quietHoursEnabled,
    startHour: 22,
    endHour: 7,
  });
  const quietScheduledFor = quietWindow.delayMs > 0
    ? (quietWindow.scheduledAt || new Date(Date.now() + quietWindow.delayMs))
    : null;
  const effectiveSendAt = quietWindow.scheduledAt || new Date();
  const templateContextBase = await enrichContextForTemplateResolution(context, targets);
  const templateContext = mergeContextPatch(templateContextBase, {
    runtime: {
      day_part_greeting: resolveMadridDayPartGreeting(effectiveSendAt),
    },
  });
  const languageSelection = resolveWhatsappLanguageRouting(config, templateContext);
  const contentConfig = languageSelection.config;
  const selectedOutsideSendWindowPolicy = normalizeOutsideSendWindowPolicy(
    resolveTemplateValue(
      contentConfig?.outside_send_window_policy || contentConfig?.send_window_policy || outsideSendWindowPolicy,
      templateContext
    )
  );
  const expectedTemplateLocale = languageSelection.enabled
    ? languageSelection.selected_language
    : null;
  const recipientData = await resolveWhatsAppRecipient({ node, config, context: templateContext, targets });

  const originalMessageMode = messageMode;
  let effectiveMessageMode = messageMode;
  let template = null;
  let templateParams = {};
  let previewText = '';
  let messageContent = '';
  let messageType = 'text';
  let templateLanguage = expectedTemplateLocale
    || cleanString(resolveTemplateValue(contentConfig?.language_code, context))
    || 'es_ES';
  let fallbackTemplate = null;
  let fallbackTemplateParams = {};
  let fallbackPreviewText = '';
  let fallbackTriggeredReason = null;
  let templateComponents = null;
  let accessGuidanceDecision = {
    branch: 'base',
    variant_requested: false,
    variant_used: false,
    fallback_used: false,
    fallback_reason: null,
  };
  let senderData = null;
  let useDurableAccessGuidanceTransport = false;
  const getSenderData = async () => {
    if (!senderData) {
      senderData = await resolveWhatsAppSenderConfig({ config, context: templateContext, clinicId });
    }
    return senderData;
  };

  if (messageMode === 'template') {
    senderData = await getSenderData();
    let selectedTemplateConfig = contentConfig;
    const explicitAccessGuidanceVariant = isExplicitAccessGuidanceVariantNode(contentConfig);

    if (explicitAccessGuidanceVariant) {
      const fallbackConfig = buildFallbackWhatsappTemplateConfig(contentConfig);
      const hasVariantReference = !!(
        toIntOrNull(resolveTemplateValue(contentConfig.catalog_template_id, templateContext))
        || cleanString(resolveTemplateValue(contentConfig.template_name, templateContext))
        || toIntOrNull(resolveTemplateValue(contentConfig.template_id, templateContext))
      );
      const variantConfigured = parseBool(
        resolveTemplateValue(contentConfig.access_guidance_delivery?.enabled, templateContext),
        true
      ) && hasVariantReference;
      const appointmentType = cleanString(
        templateContext?.cita?.tipo_cita
        || templateContext?.appointment?.tipo_cita
        || templateContext?.trigger?.data?.tipo_cita
      );
      const accessGuidance = templateContext?.clinica?.access_guidance
        || templateContext?.clinic?.access_guidance
        || null;
      const eligibility = evaluateAccessGuidanceVariantEligibility({
        appointmentType,
        accessGuidance,
        variantConfigured,
      });
      const accessGuidanceAssetError = eligibility.eligible
        ? await validateAccessGuidancePublicMediaAsset({ clinicId, accessGuidance })
        : null;
      let variantTemplate = null;
      let variantLookupError = null;
      if (eligibility.eligible && !accessGuidanceAssetError) {
        try {
          variantTemplate = await loadConfiguredWhatsappTemplate(contentConfig, templateContext, {
            targetWabaId: senderData.clinic_config?.wabaId || '',
            requireCurrentCatalogBody: parseBool(
              resolveTemplateValue(contentConfig.require_current_catalog_body, templateContext),
              true
            ),
            expectedLocale: expectedTemplateLocale,
            expectedFamilyKey: resolveConfiguredCatalogFamilyKey(contentConfig),
          });
        } catch (error) {
          variantLookupError = error;
        }
      }
      accessGuidanceDecision = selectAccessGuidanceTemplateBranch({
        appointmentType,
        accessGuidance,
        variantConfigured,
        variantTemplate,
        targetWabaId: senderData.clinic_config?.wabaId || '',
        lookupError: variantLookupError,
      });
      if (accessGuidanceAssetError) {
        accessGuidanceDecision = {
          branch: 'base',
          variant_requested: eligibility.is_first_visit && eligibility.access_guidance.enabled,
          variant_used: false,
          fallback_used: true,
          fallback_reason: accessGuidanceAssetError,
          access_guidance: eligibility.access_guidance,
        };
      }
      if (accessGuidanceDecision.variant_used) {
        template = variantTemplate;
        selectedTemplateConfig = contentConfig;
      } else {
        const accessFallbackTemplate = await loadConfiguredWhatsappTemplate(contentConfig, templateContext, {
          templateIdKey: 'fallback_template_id',
          templateNameKey: 'fallback_template_name',
          catalogTemplateIdKey: 'fallback_catalog_template_id',
          targetWabaId: senderData.clinic_config?.wabaId || '',
          requireCurrentCatalogBody: parseBool(
            resolveTemplateValue(contentConfig?.fallback_require_current_catalog_body, templateContext),
            false
          ),
          expectedLocale: expectedTemplateLocale,
          expectedFamilyKey: resolveConfiguredCatalogFamilyKey(contentConfig, 'fallback_catalog_family_key'),
        });
        if (!accessFallbackTemplate) {
          throw new Error('whatsapp_access_guidance_fallback_template_missing');
        }
        const fallbackStatus = toLowerSafe(accessFallbackTemplate.status);
        if (isTemplateBlockedForSend(fallbackStatus)) {
          throw new Error(`whatsapp_access_guidance_fallback_template_not_approved:${accessFallbackTemplate.status}`);
        }
        template = accessFallbackTemplate;
        selectedTemplateConfig = fallbackConfig;
      }
      useDurableAccessGuidanceTransport = accessGuidanceDecision.variant_requested;
    } else {
      const baseTemplate = await loadConfiguredWhatsappTemplate(contentConfig, templateContext, {
        templateIdKey: 'template_id',
        templateNameKey: 'template_name',
        catalogTemplateIdKey: 'catalog_template_id',
        targetWabaId: senderData.clinic_config?.wabaId || '',
        requireCurrentCatalogBody: parseBool(resolveTemplateValue(contentConfig?.require_current_catalog_body, templateContext), false),
        expectedLocale: expectedTemplateLocale,
        expectedFamilyKey: resolveConfiguredCatalogFamilyKey(contentConfig),
      });
      if (!baseTemplate) {
        throw new Error(
          languageSelection.enabled
            ? `whatsapp_language_template_unavailable:${languageSelection.selected_language}`
            : 'whatsapp_template_id_missing'
        );
      }

      const baseTemplateStatus = toLowerSafe(baseTemplate.status);
      if (isTemplateBlockedForSend(baseTemplateStatus)) {
        throw new Error(`whatsapp_template_not_approved:${baseTemplate.status}`);
      }

      template = baseTemplate;
      const accessGuidanceVariantConfig = isObject(contentConfig.access_guidance_variant)
        ? contentConfig.access_guidance_variant
        : null;
      if (accessGuidanceVariantConfig) {
        const variantConfigured = parseBool(
          resolveTemplateValue(accessGuidanceVariantConfig.enabled, templateContext),
          false
        ) && !!(
          toIntOrNull(resolveTemplateValue(accessGuidanceVariantConfig.catalog_template_id, templateContext))
          || cleanString(resolveTemplateValue(accessGuidanceVariantConfig.template_name, templateContext))
          || toIntOrNull(resolveTemplateValue(accessGuidanceVariantConfig.template_id, templateContext))
        );
        const appointmentType = cleanString(
          templateContext?.cita?.tipo_cita
          || templateContext?.appointment?.tipo_cita
          || templateContext?.trigger?.data?.tipo_cita
        );
        const accessGuidance = templateContext?.clinica?.access_guidance
          || templateContext?.clinic?.access_guidance
          || null;
        const eligibility = evaluateAccessGuidanceVariantEligibility({
          appointmentType,
          accessGuidance,
          variantConfigured,
        });
        const accessGuidanceAssetError = eligibility.eligible
          ? await validateAccessGuidancePublicMediaAsset({ clinicId, accessGuidance })
          : null;
        let variantTemplate = null;
        let variantLookupError = null;
        if (eligibility.eligible && !accessGuidanceAssetError) {
          try {
            variantTemplate = await loadConfiguredWhatsappTemplate(
              accessGuidanceVariantConfig,
              templateContext,
              {
                targetWabaId: senderData.clinic_config?.wabaId || '',
                requireCurrentCatalogBody: parseBool(
                  resolveTemplateValue(
                    accessGuidanceVariantConfig.require_current_catalog_body,
                    templateContext
                  ),
                  true
                ),
                expectedLocale: expectedTemplateLocale,
                expectedFamilyKey: resolveConfiguredCatalogFamilyKey(accessGuidanceVariantConfig),
              }
            );
          } catch (error) {
            variantLookupError = error;
          }
        }
        accessGuidanceDecision = selectAccessGuidanceTemplateBranch({
          appointmentType,
          accessGuidance,
          variantConfigured,
          variantTemplate,
          targetWabaId: senderData.clinic_config?.wabaId || '',
          lookupError: variantLookupError,
        });
        if (accessGuidanceAssetError) {
          accessGuidanceDecision = {
            branch: 'base',
            variant_requested: eligibility.is_first_visit && eligibility.access_guidance.enabled,
            variant_used: false,
            fallback_used: true,
            fallback_reason: accessGuidanceAssetError,
            access_guidance: eligibility.access_guidance,
          };
        }
        if (accessGuidanceDecision.variant_used) {
          template = variantTemplate;
          selectedTemplateConfig = accessGuidanceVariantConfig;
        }
        // Solo las primeras visitas con la opcion activada (incluido fallback
        // base observable) usan el handoff durable. Las citas recurrentes
        // conservan exactamente el transporte historico.
        useDurableAccessGuidanceTransport = accessGuidanceDecision.variant_requested;
      }
    }

    templateParams = resolveTemplateVariables(selectedTemplateConfig, templateContext, template);
    const expectedTemplateParamIndexes = extractWhatsappTemplatePlaceholderIndexes(template);
    const missingTemplateParamIndexes = expectedTemplateParamIndexes.filter((paramIdx) => {
      const value = cleanString(templateParams?.[paramIdx]);
      return !value;
    });
    if (missingTemplateParamIndexes.length) {
      throw new Error(
        `whatsapp_template_params_missing:${missingTemplateParamIndexes.join(',')}`
      );
    }

    previewText = renderWhatsappTemplatePreviewText(template, templateParams);
    messageContent = previewText;
    messageType = 'template';
    templateLanguage = cleanString(template?.language) || templateLanguage || 'es_ES';
    if (accessGuidanceDecision.variant_used) {
      templateComponents = buildAccessGuidanceTemplateComponents({
        templateParams,
        imageUrl: accessGuidanceDecision.access_guidance?.image_url,
      });
    }
  } else {
    const manualText = cleanString(resolveTemplateValue(contentConfig?.manual_message_text, templateContext));
    if (!manualText) {
      throw new Error('whatsapp_manual_message_text_missing');
    }
    previewText = manualText;
    messageContent = manualText;
    messageType = 'text';

    fallbackTemplate = await loadConfiguredWhatsappTemplate(contentConfig, templateContext, {
      templateIdKey: 'fallback_template_id',
      templateNameKey: 'fallback_template_name',
      catalogTemplateIdKey: 'fallback_catalog_template_id',
      requireCurrentCatalogBody: parseBool(resolveTemplateValue(contentConfig?.fallback_require_current_catalog_body, templateContext), false),
      expectedLocale: expectedTemplateLocale,
      expectedFamilyKey: resolveConfiguredCatalogFamilyKey(contentConfig, 'fallback_catalog_family_key'),
    });
    if (fallbackTemplate) {
      const fallbackStatus = toLowerSafe(fallbackTemplate.status);
      if (isTemplateBlockedForSend(fallbackStatus)) {
        throw new Error(`whatsapp_fallback_template_not_approved:${fallbackTemplate.status}`);
      }

      fallbackTemplateParams = resolveTemplateVariablesWithKeys(
        contentConfig,
        templateContext,
        fallbackTemplate,
        {
          namedKey: 'fallback_variables_named',
          positionalKey: 'fallback_variables',
        }
      );
      const expectedFallbackParamIndexes = extractWhatsappTemplatePlaceholderIndexes(fallbackTemplate);
      const missingFallbackParamIndexes = expectedFallbackParamIndexes.filter((paramIdx) => {
        const value = cleanString(fallbackTemplateParams?.[paramIdx]);
        return !value;
      });
      if (missingFallbackParamIndexes.length) {
        throw new Error(
          `whatsapp_fallback_template_params_missing:${missingFallbackParamIndexes.join(',')}`
        );
      }

      fallbackPreviewText = renderWhatsappTemplatePreviewText(
        fallbackTemplate,
        fallbackTemplateParams
      );
    }
  }

  if (quietWindow.delayMs > 0 && selectedOutsideSendWindowPolicy === 'discard') {
    return {
      kind: 'success',
      output: {
        status: 'skipped_outside_send_window',
        reason: 'outside_send_window',
        message_mode: originalMessageMode,
        delivery_mode: effectiveMessageMode,
        template_id: template?.id || null,
        template_name: template?.name || null,
        fallback_used: !!fallbackTriggeredReason,
        fallback_reason: fallbackTriggeredReason,
        message_preview: previewText,
        recipient_mode: recipientData.recipient_mode,
        recipient: recipientData.recipient,
        quiet_hours_applied: true,
        quiet_hours_window: '22:00-07:00',
        scheduled_for: quietScheduledFor ? quietScheduledFor.toISOString() : null,
        outside_send_window_policy: selectedOutsideSendWindowPolicy,
        discarded: true,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  const targetPatientId = toIntOrNull(targets.patient_id);
  const targetLeadId = toIntOrNull(targets.lead_id);
  let conversation = null;

  conversation = await findCanonicalWhatsappConversation({
    clinicId,
    contactId: recipientData.recipient,
    patientId: targetPatientId,
    leadId: targetLeadId,
    createIfMissing: false,
  });

  // 2) Si no existe:
  // - modo template: crear conversación del paciente objetivo.
  // - modo manual: no enviar (se exige conversación activa en últimas 24h).
  if (!conversation) {
    if (messageMode === 'manual') {
      if (fallbackTemplate) {
        fallbackTriggeredReason = 'conversation_not_found';
        effectiveMessageMode = 'template_fallback';
        template = fallbackTemplate;
        templateParams = fallbackTemplateParams;
        previewText = fallbackPreviewText;
        messageContent = previewText;
        messageType = 'template';
        templateLanguage = cleanString(fallbackTemplate?.language) || templateLanguage || 'es_ES';
      } else {
        return {
          kind: 'success',
          output: {
            status: 'skipped_no_active_conversation_24h',
            reason: 'conversation_not_found',
            message_mode: originalMessageMode,
            delivery_mode: originalMessageMode,
            message_preview: previewText,
            recipient_mode: recipientData.recipient_mode,
            recipient: recipientData.recipient,
            conversation_id: null,
            last_inbound_at: null,
            fallback_used: false,
            fallback_template_id: null,
            fallback_template_name: null,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
    }
    conversation = await findCanonicalWhatsappConversation({
      clinicId,
      contactId: recipientData.recipient,
      patientId: targetPatientId,
      leadId: targetLeadId,
      createIfMissing: true,
      lastMessageAt: new Date(),
    });
  }

  let serviceWindow = null;
  if (messageMode === 'manual') {
    senderData = await getSenderData();
    serviceWindow = await resolveWhatsappServiceWindow({
      conversation,
      activePhoneNumberId: senderData.clinic_config?.phoneNumberId || null,
    });
  }

  if (messageMode === 'manual' && !serviceWindow?.open) {
    if (fallbackTemplate) {
      fallbackTriggeredReason = 'conversation_outside_24h_window';
      effectiveMessageMode = 'template_fallback';
      template = fallbackTemplate;
      templateParams = fallbackTemplateParams;
      previewText = fallbackPreviewText;
      messageContent = previewText;
      messageType = 'template';
      templateLanguage = cleanString(fallbackTemplate?.language) || templateLanguage || 'es_ES';
    } else {
      return {
        kind: 'success',
        output: {
          status: 'skipped_no_active_conversation_24h',
          reason: 'conversation_outside_24h_window',
          message_mode: originalMessageMode,
          delivery_mode: originalMessageMode,
          message_preview: previewText,
          recipient_mode: recipientData.recipient_mode,
          recipient: recipientData.recipient,
          conversation_id: conversation?.id || null,
          last_inbound_at: serviceWindow?.lastInboundAt || null,
          service_window_phone_number_id: serviceWindow?.phoneNumberId || null,
          fallback_used: false,
          fallback_template_id: null,
          fallback_template_name: null,
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
    }
  }

  senderData = await getSenderData();

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
  let accessGuidanceEventDetail = '';
  if (accessGuidanceDecision.variant_used) {
    accessGuidanceEventDetail = ' Se seleccionó la variante con indicaciones e imagen de acceso de la clínica.';
  } else if (accessGuidanceDecision.fallback_used) {
    accessGuidanceEventDetail = ` La variante de acceso no pudo utilizarse (${accessGuidanceDecision.fallback_reason}); se seleccionó la plantilla base.`;
  }
  const eventMessageContent = `Mensaje preparado automáticamente por activarse el flujo ${flowName ? `"${flowName}"` : ''}. El paciente no ve este texto, solo el mensaje a continuación.${accessGuidanceEventDetail}`;
  const nowIso = new Date().toISOString();

  const eventMaterialization = await findOrCreateAutomationWhatsappMessage({
    deliveryKey: automationDeliveryKey,
    messageType: 'event',
    values: {
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
      message_mode: originalMessageMode,
      delivery_mode: effectiveMessageMode,
      action_source: cleanString(config.source) || null,
      flow_domain: cleanString(config.domain) || cleanString(runtime?.execution?.domain) || null,
      template_usage: cleanString(config.template_usage) || null,
      template_commercial: config.template_commercial === true,
      template_id: template?.id || null,
      template_name: template?.name || null,
      patient_language: languageSelection.patient_language,
      selected_language: expectedTemplateLocale || normalizeWhatsappLocale(templateLanguage, { fallback: 'es' }),
      language_routing_enabled: languageSelection.enabled,
      template_family_key: resolveCatalogFamilyKey(template?.catalog) || null,
      fallback_used: !!fallbackTriggeredReason,
      fallback_reason: fallbackTriggeredReason,
      fallback_template_id: fallbackTriggeredReason ? template?.id || null : null,
      fallback_template_name: fallbackTriggeredReason ? template?.name || null : null,
      template_branch: accessGuidanceDecision.branch,
      access_guidance_variant_requested: accessGuidanceDecision.variant_requested,
      access_guidance_variant_used: accessGuidanceDecision.variant_used,
      access_guidance_fallback_used: accessGuidanceDecision.fallback_used,
      access_guidance_fallback_reason: accessGuidanceDecision.fallback_reason,
      automation_delivery_key: automationDeliveryKey,
        generated_at: nowIso,
      },
    },
  });
  const eventMsg = eventMaterialization.message;

  const metadata = {
    source: 'automations_v2',
    kind: 'flow_send_whatsapp',
    execution_id: execution?.id || null,
    node_id: cleanString(node?.id),
    flow_name: flowName || null,
    flow_reason: 'flow_send_whatsapp',
    action_source: cleanString(config.source) || null,
    flow_domain: cleanString(config.domain) || cleanString(runtime?.execution?.domain) || null,
    template_usage: cleanString(config.template_usage) || null,
    template_commercial: config.template_commercial === true,
    message_mode: originalMessageMode,
    delivery_mode: effectiveMessageMode,
    template_id: template?.id || null,
    template_name: template?.name || null,
    patient_language: languageSelection.patient_language,
    selected_language: expectedTemplateLocale || normalizeWhatsappLocale(templateLanguage, { fallback: 'es' }),
    language_routing_enabled: languageSelection.enabled,
    template_family_key: resolveCatalogFamilyKey(template?.catalog) || null,
    fallback_used: !!fallbackTriggeredReason,
    fallback_reason: fallbackTriggeredReason,
    fallback_template_id: fallbackTriggeredReason ? template?.id || null : null,
    fallback_template_name: fallbackTriggeredReason ? template?.name || null : null,
    template_language: templateLanguage || template?.language || 'es_ES',
    template_params: templateParams,
    template_components: templateComponents,
    template_branch: accessGuidanceDecision.branch,
    access_guidance_variant_requested: accessGuidanceDecision.variant_requested,
    access_guidance_variant_used: accessGuidanceDecision.variant_used,
    access_guidance_fallback_used: accessGuidanceDecision.fallback_used,
    access_guidance_fallback_reason: accessGuidanceDecision.fallback_reason,
    access_guidance_image_asset_id: accessGuidanceDecision.variant_used
      ? accessGuidanceDecision.access_guidance?.image_asset_id || null
      : null,
    access_guidance_image_url: accessGuidanceDecision.variant_used
      ? accessGuidanceDecision.access_guidance?.image_url || null
      : null,
    automation_delivery_key: automationDeliveryKey,
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
    queued_by_quiet_hours: quietWindow.delayMs > 0,
    scheduled_for: quietScheduledFor
      ? quietScheduledFor.toISOString()
      : null,
    limitMode: !!limitStatus?.limitedMode,
    limitSnapshot: limitStatus?.limitedMode
      ? {
          count: limitStatus.count,
          limit: limitStatus.limit,
        }
      : null,
  };

  const messageMaterialization = await findOrCreateAutomationWhatsappMessage({
    deliveryKey: automationDeliveryKey,
    messageType,
    values: {
      conversation_id: conversation.id,
      sender_id: null,
      direction: 'outbound',
      content: messageContent,
      message_type: messageType,
      status: 'pending',
      sent_at: new Date(),
      metadata,
    },
  });
  const msg = messageMaterialization.message;
  if (!messageMaterialization.created) {
    return reuseExistingAutomationWhatsappMessage({ existingMessage: msg, node });
  }
  emitMessageCreatedToConversationRooms(conversation, eventMsg);
  emitMessageCreatedToConversationRooms(conversation, msg);

  if (quietWindow.delayMs > 0) {
    let scheduledJob = null;
    const scheduledFor = quietScheduledFor;
    // La intencion de espera se confirma antes de publicar el JobRequest. Un
    // crash o fallo del enqueue puede reconstruir el mismo job sin adelantar
    // el mensaje ni convertirlo en un envio inmediato.
    await msg.update({
      status: 'pending',
      metadata: {
        ...(msg.metadata || {}),
        scheduled_for: scheduledFor.toISOString(),
        queued_by_quiet_hours: true,
        quiet_hours_job_request_id: null,
        enqueue_error: null,
      },
    });
    try {
      scheduledJob = await enqueueQuietHoursWhatsappJob({
        messageId: msg.id,
        conversationId: conversation.id,
        scheduledAt: scheduledFor,
      });
    } catch (enqueueErr) {
      const enqueueError = enqueueErr?.message || 'enqueue_failed';
      await msg.update({
        status: 'failed',
        metadata: {
          ...(msg.metadata || {}),
          enqueue_error: enqueueError,
          queued_by_quiet_hours: true,
          scheduled_for: scheduledFor.toISOString(),
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
        scheduled_for: scheduledFor.toISOString(),
        queued_by_quiet_hours: true,
        quiet_hours_job_request_id: scheduledJob?.id || null,
      },
    });
    await conversation.update({ last_message_at: new Date() });

    await registerLeadAutoReplyContactAttempt({ execution, context, node, message: msg });

    return {
      kind: 'success',
      output: {
        message_id: msg.id,
        event_message_id: eventMsg.id,
        status: 'scheduled',
        message_mode: originalMessageMode,
        delivery_mode: effectiveMessageMode,
        template_id: template?.id || null,
        template_name: template?.name || null,
        fallback_used: !!fallbackTriggeredReason,
        fallback_reason: fallbackTriggeredReason,
        template_branch: accessGuidanceDecision.branch,
        access_guidance_variant_requested: accessGuidanceDecision.variant_requested,
        access_guidance_variant_used: accessGuidanceDecision.variant_used,
        access_guidance_fallback_used: accessGuidanceDecision.fallback_used,
        access_guidance_fallback_reason: accessGuidanceDecision.fallback_reason,
        template_has_image: Array.isArray(templateComponents),
        message_preview: previewText,
        recipient_mode: recipientData.recipient_mode,
        recipient: recipientData.recipient,
        sender_mode: senderData.sender_mode,
        sender_origin_id: senderData.sender_origin_id,
        conversation_id: conversation.id,
        phone_number_id: senderData.clinic_config?.phoneNumberId || null,
        limited_mode: !!limitStatus?.limitedMode,
        quiet_hours_applied: true,
        scheduled_for: scheduledFor.toISOString(),
        job_request_id: scheduledJob?.id || null,
        sender_clinic_id: clinicId,
        sender_clinic_name: cleanString(senderClinic?.nombre_clinica),
        recipient_patient_id: recipientPatientId,
        recipient_patient_name: recipientPatientName,
      },
      next_node_id: readOutputTarget(node, 'on_success'),
    };
  }

  let immediateTransportJobId = null;
  if (useDurableAccessGuidanceTransport) {
    try {
      const dispatch = await enqueueAutomationWhatsappTransport({
        msg,
        conversation,
        recipient: recipientData.recipient,
        dispatchKind: 'immediate',
      });
      immediateTransportJobId = dispatch.transportJobId;
    } catch (enqueueErr) {
      const enqueueError = enqueueErr?.message || 'enqueue_failed';
      await msg.update({
        status: 'failed',
        metadata: {
          ...(msg.metadata || {}),
          enqueue_error: enqueueError,
        },
      });
      throw new Error(`whatsapp_enqueue_failed:${enqueueError}`);
    }
    await conversation.update({ last_message_at: new Date() }).catch(() => null);
  } else {
    try {
      const waResponse = await whatsappService.sendMessage({
      to: recipientData.recipient,
      body: messageContent,
      useTemplate: messageType === 'template',
      templateName: template?.name || null,
      templateLanguage: metadata.template_language,
      templateParams,
      templateComponents,
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

    await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
      clinicId,
      phoneId: senderData.clinic_config?.phoneNumberId || null,
      wabaId: senderData.clinic_config?.wabaId || null,
      messageId: msg.id,
      source: 'automation_flow_send_whatsapp',
    }).catch(() => null);

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

      await whatsappConnectionStatusService.markDisconnectedAfterProviderError({
        error: providerError,
        clinicId,
        phoneId: senderData?.clinic_config?.phoneNumberId || null,
        wabaId: senderData?.clinic_config?.wabaId || null,
        messageId: msg.id,
        recipient: recipientData?.recipient || null,
        source: 'automation_flow_send_whatsapp',
      });
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
  }

  await registerLeadAutoReplyContactAttempt({ execution, context, node, message: msg });

  return {
    kind: 'success',
    output: {
      message_id: msg.id,
      event_message_id: eventMsg.id,
      status: immediateTransportJobId ? 'queued' : 'sent',
      message_mode: originalMessageMode,
      delivery_mode: effectiveMessageMode,
      template_id: template?.id || null,
      template_name: template?.name || null,
      fallback_used: !!fallbackTriggeredReason,
      fallback_reason: fallbackTriggeredReason,
      template_branch: accessGuidanceDecision.branch,
      access_guidance_variant_requested: accessGuidanceDecision.variant_requested,
      access_guidance_variant_used: accessGuidanceDecision.variant_used,
      access_guidance_fallback_used: accessGuidanceDecision.fallback_used,
      access_guidance_fallback_reason: accessGuidanceDecision.fallback_reason,
      template_has_image: Array.isArray(templateComponents),
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
      transport_job_id: immediateTransportJobId,
      sender_clinic_id: clinicId,
      sender_clinic_name: cleanString(senderClinic?.nombre_clinica),
      recipient_patient_id: recipientPatientId,
      recipient_patient_name: recipientPatientName,
    },
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

async function materializeFailedAutomationWhatsappMessage({ node, context, execution, errorMessage }) {
  try {
    const automationDeliveryKey = buildAutomationWhatsappDeliveryKey(execution, node);
    if (automationDeliveryKey) {
      const existingMessage = await findAutomationWhatsappMessageByDeliveryKey({
        deliveryKey: automationDeliveryKey,
        messageType: ['template', 'text'],
      });
      if (existingMessage) {
        await existingMessage.update({
          status: ['sent', 'delivered', 'read'].includes(toLowerSafe(existingMessage.status))
            ? existingMessage.status
            : 'failed',
          metadata: {
            ...(existingMessage.metadata || {}),
            flow_error: errorMessage,
          },
        });
        return existingMessage;
      }
    }
    const config = node?.config && typeof node.config === 'object' ? node.config : {};
    let targets = resolveRuntimeTargets(execution, context);
    targets = await backfillRuntimeTargets(execution, targets);
    const clinicId = toIntOrNull(targets.clinic_id);
    if (!clinicId) return null;

    const templateContext = await enrichContextForTemplateResolution(context, targets).catch(() => context);
    const recipientData = await resolveWhatsAppRecipient({
      node,
      config,
      context: templateContext || context,
      targets,
    }).catch(() => null);
    if (!recipientData?.recipient) return null;

    const targetPatientId = toIntOrNull(targets.patient_id);
    const targetLeadId = toIntOrNull(targets.lead_intake_id);
    const conversation = await findCanonicalWhatsappConversation({
      clinicId,
      contactId: recipientData.recipient,
      patientId: targetPatientId,
      leadId: targetLeadId,
      createIfMissing: true,
      lastMessageAt: new Date(),
    });
    if (!conversation) return null;

    const existing = await Message.findOne({
      where: {
        conversation_id: conversation.id,
        direction: 'outbound',
        status: 'failed',
      },
      order: [['id', 'DESC']],
    });
    const existingMeta = existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
    if (
      toIntOrNull(existingMeta.execution_id) === toIntOrNull(execution?.id) &&
      cleanString(existingMeta.node_id) === cleanString(node?.id) &&
      cleanString(existingMeta.failure_source) === 'automation_send_whatsapp_preflight'
    ) {
      return existing;
    }

    const flowName =
      cleanString(execution?.templateVersion?.name)
      || cleanString(execution?.template_name)
      || `Flujo #${toIntOrNull(execution?.id) || ''}`.trim();
    const templateName = cleanString(resolveTemplateValue(config?.template_name, templateContext || context))
      || cleanString(config?.template_name)
      || null;
    const rawError = cleanString(errorMessage);
    const normalizedError = rawError.toLowerCase();
    const failureReason =
      normalizedError.includes('sin_conectar') || normalizedError.includes('whatsapp_config_missing')
        ? 'porque esta clínica no tiene WhatsApp conectado.'
        : normalizedError.includes('template_not_approved') || normalizedError.includes('not_approved')
          ? 'porque la plantilla de WhatsApp no está aprobada para esta clínica.'
          : normalizedError.includes('params_missing')
            ? 'porque faltan datos para completar la plantilla.'
            : rawError
              ? `por este motivo: ${rawError}.`
              : 'por un error de configuración.';
    const messageContent = templateName
      ? `No se pudo enviar el WhatsApp automático "${templateName}" ${failureReason}`
      : `No se pudo enviar este WhatsApp automático ${failureReason}`;
    const failedMessageType = normalizeWhatsappMessageMode(config?.message_mode) === 'template'
      ? 'template'
      : 'text';
    const materialization = await findOrCreateAutomationWhatsappMessage({
      deliveryKey: automationDeliveryKey,
      messageType: failedMessageType,
      values: {
        conversation_id: conversation.id,
        sender_id: null,
        direction: 'outbound',
        content: messageContent,
        message_type: failedMessageType,
        status: 'failed',
        sent_at: new Date(),
        metadata: {
        source: 'automations_v2',
        kind: 'flow_send_whatsapp',
        failure_source: 'automation_send_whatsapp_preflight',
        execution_id: execution?.id || null,
        node_id: cleanString(node?.id),
        flow_name: flowName || null,
        template_id: toIntOrNull(resolveTemplateValue(config?.template_id, templateContext || context)) || null,
        template_name: templateName,
        catalog_template_id: toIntOrNull(resolveTemplateValue(config?.catalog_template_id, templateContext || context)) || null,
        recipient_mode: recipientData.recipient_mode,
        recipient: recipientData.recipient,
        error: errorMessage,
        error_message: errorMessage,
          automation_delivery_key: automationDeliveryKey,
          generated_at: new Date().toISOString(),
        },
      },
    });
    const failedMessage = materialization.message;
    if (!materialization.created) {
      await failedMessage.update({
        status: ['sent', 'delivered', 'read'].includes(toLowerSafe(failedMessage.status))
          ? failedMessage.status
          : 'failed',
        metadata: {
          ...(failedMessage.metadata || {}),
          flow_error: errorMessage,
        },
      });
      return failedMessage;
    }
    await conversation.update({ last_message_at: new Date() });
    emitMessageCreatedToConversationRooms(conversation, failedMessage);
    return failedMessage;
  } catch (noticeError) {
    console.warn('[automations:v2] No se pudo materializar fallo WhatsApp en QuickChat', {
      execution_id: execution?.id || null,
      node_id: cleanString(node?.id),
      error: noticeError?.message || noticeError,
    });
    return null;
  }
}

async function handleRequestReview(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const targets = resolveRuntimeTargets(runtime?.execution, context);
  const appointmentId = toIntOrNull(resolveTemplateValue(config?.appointment_id, context))
    || toIntOrNull(getByPath(context, 'appointment.id_cita'))
    || toIntOrNull(getByPath(context, 'appointment.id'))
    || toIntOrNull(getByPath(context, 'trigger.data.appointment_id'))
    || toIntOrNull(getByPath(context, 'trigger.data.cita_id'));
  const clinicId = toIntOrNull(resolveTemplateValue(config?.clinic_id, context))
    || toIntOrNull(targets.clinic_id)
    || toIntOrNull(getByPath(context, 'appointment.clinica_id'))
    || toIntOrNull(getByPath(context, 'clinic.id_clinica'))
    || toIntOrNull(getByPath(context, 'clinica.id_clinica'));

  const result = await marketingBulkSendsService.createAndStartReviewRequestForAppointment({
    appointmentId,
    clinicId,
    reviewSource: resolveTemplateValue(config?.review_source, context),
    reviewThreshold: resolveTemplateValue(config?.review_threshold, context),
    whatsappTemplateId: resolveTemplateValue(config?.whatsapp_template_id, context),
    reviewGiftEnabled: resolveTemplateValue(config?.review_gift_enabled, context),
    reviewGiftDescription: resolveTemplateValue(config?.review_gift_description, context),
    reviewDisplayClinicName: resolveTemplateValue(config?.review_display_clinic_name, context),
    reviewSenderName: resolveTemplateValue(config?.review_sender_name, context),
    reviewTeamPhotoUrl: resolveTemplateValue(config?.review_team_photo_url, context),
    reviewTeamPhotoOverlayColor: resolveTemplateValue(config?.review_team_photo_overlay_color, context),
    waitForMessageMs: resolveTemplateValue(config?.wait_for_message_ms, context),
    userId: runtime?.execution?.created_by || runtime?.execution?.user_id || null,
  });
  const requireMessageAnchor = parseBool(resolveTemplateValue(config?.require_message_anchor_for_wait, context), false);
  const nextOutput = result?.skipped || (requireMessageAnchor && !toIntOrNull(result?.message_id))
    ? 'on_fail'
    : 'on_success';

  return {
    kind: 'success',
    output: {
      ...result,
      appointment_id: appointmentId || null,
      clinic_id: clinicId || null,
    },
    next_node_id: readOutputTarget(node, nextOutput) || (nextOutput === 'on_fail' ? null : readOutputTarget(node, 'on_success')),
  };
}

async function handleRequestReviewReminder(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const result = await marketingBulkSendsService.sendReviewRequestReminder({
    listId: resolveTemplateValue(config?.list_id, context),
    itemId: resolveTemplateValue(config?.item_id, context),
    userId: runtime?.execution?.created_by || runtime?.execution?.user_id || null,
  });
  const nextOutput = result?.skipped || !toIntOrNull(result?.message_id)
    ? 'on_fail'
    : 'on_success';

  return {
    kind: 'success',
    output: {
      ...result,
      status: result?.sent ? 'sent' : 'skipped',
      reminder_policy: cleanString(resolveTemplateValue(config?.reminder_policy, context)) || 'after_24h',
    },
    next_node_id: readOutputTarget(node, nextOutput) || (nextOutput === 'on_fail' ? readOutputTarget(node, 'on_fail') : readOutputTarget(node, 'on_success')),
  };
}

async function handleReviewFollowup(node, context) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  const responseCandidates = Object.entries(context?.outputs || {})
    .filter(([, output]) => (
      cleanString(output?.response_text)
      || output?.responded_at
      || output?.inbound_message_id
      || toIntOrNull(output?.response_rating)
    ))
    .map(([nodeId, output]) => ({ nodeId, output }));
  const explicitResponse = context?.last_response_context
    && typeof context.last_response_context === 'object'
    && (
      cleanString(context.last_response_context.response_text)
      || context.last_response_context.responded_at
      || context.last_response_context.inbound_message_id
      || toIntOrNull(context.last_response_context.response_rating)
    )
    ? { nodeId: cleanString(context.last_response_context.node_id) || null, output: context.last_response_context }
    : null;
  const inferredResponse = explicitResponse || responseCandidates[responseCandidates.length - 1] || null;
  const responseOutput = inferredResponse?.output || null;
  const responseSourceNodeId = inferredResponse?.nodeId || null;
  const responseText = cleanString(responseOutput?.response_text);
  const rating = toIntOrNull(responseOutput?.response_rating)
    || toIntOrNull(context?.last_response_context?.response_rating)
    || extractReviewRatingFromResponseText(responseText);
  const ratingReason = cleanString(
    responseOutput?.response_rating_reason
    || context?.last_response_context?.response_rating_reason
    || extractReviewRatingDetailsFromResponseText(responseText).reason
  ) || null;
  const threshold = 5;
  const followupKind = cleanString(resolveTemplateValue(config?.followup_kind, context)) || 'google_review';
  const publicReviewRequested = followupKind === 'google_review';

  return {
    kind: 'success',
    output: {
      status: 'review_followup_tracked',
      followup_kind: followupKind,
      rating,
      response_rating_reason: ratingReason,
      review_threshold: threshold,
      public_review_requested: publicReviewRequested,
      response_source_node_id: responseSourceNodeId,
      inbound_message_id: responseOutput?.inbound_message_id || null,
      note: 'El seguimiento de reseña se materializa al recibir el WhatsApp del paciente.',
    },
    next_node_id: readOutputTarget(node, 'on_success'),
  };
}

async function handleReviewNoResponse(node, context) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  return {
    kind: 'success',
    output: {
      status: 'review_request_closed_without_response',
      list_id: resolveTemplateValue(config?.list_id, context) || null,
      item_id: resolveTemplateValue(config?.item_id, context) || null,
      reason: cleanString(resolveTemplateValue(config?.reason, context)) || 'sin_respuesta',
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
    emitNotificationCreated(notification);
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

async function handleSendSystemNotification(node, context, runtime) {
  const config = node?.config && typeof node.config === 'object' ? node.config : {};
  let targets = resolveRuntimeTargets(runtime?.execution, context);
  targets = await backfillRuntimeTargets(runtime?.execution, targets);

  const clinicId = toIntOrNull(targets.clinic_id);
  if (!clinicId) {
    throw new Error('system_notification_missing_clinic_id');
  }

  let notificationContext = await enrichContextForTemplateResolution(context, targets);
  notificationContext = await enrichConversationContext(notificationContext, targets);
  notificationContext = mergeContextPatch(notificationContext, {
    runtime: {
      day_part_greeting: resolveMadridDayPartGreeting(new Date()),
    },
  });
  notificationContext = mergeContextPatch(notificationContext, buildSystemNavigationContext(notificationContext, targets));

  const title = cleanString(resolveTemplateValue(config?.title, notificationContext)) || 'Notificación del sistema';
  const message = cleanString(resolveTemplateValue(config?.message, notificationContext));
  const assigneeType = cleanString(resolveTemplateValue(config?.assignee_type, notificationContext)) || 'role';
  const assigneeId = resolveTemplateValue(config?.assignee_id, notificationContext);
  const roleCode = resolveRoleCode(
    resolveTemplateValue(config?.role_code, notificationContext)
      || resolveTemplateValue(config?.role, notificationContext)
      || resolveTemplateValue(config?.assignee_role, notificationContext)
  );
  const roleCodes = roleCode ? [roleCode] : normalizeAssigneeRoleCodes(assigneeId);
  const subrole = cleanString(resolveTemplateValue(config?.subrole, notificationContext));

  if (!message) {
    throw new Error('system_notification_message_missing');
  }

  const userIds = await resolveTaskAssigneeUserIds({
    clinicId,
    assigneeType,
    assigneeId,
    roleCode,
    subrole,
  });

  if (!userIds.length) {
    throw new Error('system_notification_no_assignees');
  }

  const conversationLink = cleanString(getByPath(notificationContext, 'system.patient_conversation_link'));
  const patientDetailLink = cleanString(getByPath(notificationContext, 'system.patient_detail_link'));
  const quickChatConversationId = toIntOrNull(getByPath(notificationContext, 'conversation.id')) || null;
  const primaryLink = conversationLink || patientDetailLink || null;
  const createdNotifications = [];

  for (const userId of userIds) {
    const notification = await Notification.create({
      userId,
      role: roleCodes.length ? roleCodes.join(',') : '',
      subrole: subrole || '',
      category: 'general',
      event: 'automation.system_notification',
      title,
      message,
      icon: 'heroicons_outline:bell-alert',
      level: 'warning',
      data: {
        source: 'automations_v2',
        execution_id: runtime?.execution?.id || null,
        node_id: cleanString(node?.id),
        trigger_type: cleanString(runtime?.execution?.trigger_type),
        trigger_entity_type: cleanString(runtime?.execution?.trigger_entity_type),
        trigger_entity_id: toIntOrNull(runtime?.execution?.trigger_entity_id),
        link: primaryLink,
        useRouter: !!primaryLink,
        quickChatConversationId,
        patientConversationLink: conversationLink,
        patientDetailLink: patientDetailLink,
        clinicId,
      },
      clinicaId: clinicId,
    });
    emitNotificationCreated(notification);
    createdNotifications.push(notification);
  }

  return {
    kind: 'success',
    output: {
      notification_id: createdNotifications[0]?.id || null,
      notification_ids: createdNotifications.map((notification) => notification.id),
      assignee_user_ids: userIds,
      notifications_created: createdNotifications.length,
      primary_link: primaryLink,
      quick_chat_conversation_id: quickChatConversationId,
      patient_conversation_link: conversationLink,
      patient_detail_link: patientDetailLink,
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

function parseRunAtTime(value) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return {
    hours: Number(match[1]),
    minutes: Number(match[2]),
  };
}

function resolveFixedDelayUntil(config = {}) {
  const ms = resolveDurationMs(config?.duration ?? 0, config?.unit || 'seconds');
  const runAt = parseRunAtTime(config?.run_at_time || config?.runAtTime);
  if (!runAt) {
    return new Date(Date.now() + ms);
  }

  const reference = new Date(Date.now() + ms);
  const waitUntil = new Date(reference);
  waitUntil.setHours(runAt.hours, runAt.minutes, 0, 0);
  if (waitUntil.getTime() <= Date.now()) {
    waitUntil.setDate(waitUntil.getDate() + 1);
  }
  return waitUntil;
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

function normalizeFieldCheckSwitchRules(rawRules) {
  if (!Array.isArray(rawRules)) return [];
  const seen = new Set();
  const normalized = [];
  rawRules.forEach((rule, index) => {
    if (!isObject(rule)) return;
    let id = cleanString(rule.id);
    if (!id || !/^branch_\d+$/.test(id)) {
      id = `branch_${index + 1}`;
    }
    if (seen.has(id)) return;
    seen.add(id);
    const matchWindow = cleanString(rule.match_window) || 'same_day';
    const normalizedWindow = matchWindow === 'week_before' ? 'more_than_day_before' : matchWindow;
    normalized.push({
      id,
      match_window: FIELD_CHECK_APPOINTMENT_WINDOW_VALUES.has(normalizedWindow) ? normalizedWindow : 'same_day',
    });
  });
  return normalized;
}

function evaluateSimpleFieldCheck(config, context) {
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
    if (operator === 'greater_than_or_equals') return leftNum >= rightNum;
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

function resolveAppointmentBookingWindowMatch(rule, appointmentDateLocal, bookedAt, timeZone) {
  const bookingDateLocal = formatDateLocal(bookedAt, timeZone);
  if (!appointmentDateLocal || !bookingDateLocal) {
    return false;
  }

  switch (cleanString(rule?.match_window)) {
    case 'same_day':
      return bookingDateLocal === appointmentDateLocal;
    case 'day_before':
      return bookingDateLocal === addDaysToLocalDate(appointmentDateLocal, -1);
    case 'more_than_day_before':
      return bookingDateLocal < addDaysToLocalDate(appointmentDateLocal, -1);
    default:
      return false;
  }
}

function resolveAppointmentBookingReference(context) {
  const triggerType = cleanString(
    context?.trigger?.type
      || context?.trigger_type
      || context?.trigger?.data?.event_name
      || context?.trigger?.data?.trigger_type
  ).toLowerCase();
  const createdRaw = context?.trigger?.data?.appointment_created_at
    || context?.trigger?.data?.created_at
    || context?.appointment?.created_at
    || context?.cita?.created_at;
  const updatedRaw = context?.trigger?.data?.updated_at
    || context?.trigger?.data?.appointment_updated_at
    || context?.appointment?.updated_at
    || context?.cita?.updated_at;

  if (triggerType === 'appointment_rescheduled' && updatedRaw) {
    return {
      raw: updatedRaw,
      source: 'appointment_updated_at',
      trigger_type: triggerType,
      original_created_at: createdRaw || null,
    };
  }

  return {
    raw: createdRaw,
    source: 'appointment_created_at',
    trigger_type: triggerType || null,
    original_created_at: createdRaw || null,
  };
}

function evaluateAppointmentBookingTimingFieldCheck(config, context) {
  const switchType = cleanString(config?.switch_type) || 'appointment_booking';
  if (!FIELD_CHECK_SWITCH_TYPE_VALUES.has(switchType)) {
    throw new Error(`field_check_invalid_switch_type:${switchType}`);
  }

  const rules = normalizeFieldCheckSwitchRules(config?.switch_rules);
  if (!rules.length) {
    throw new Error('field_check_switch_rules_required');
  }

  const appointmentStartRaw = context?.appointment?.inicio
    || context?.cita?.inicio
    || context?.trigger?.data?.inicio
    || context?.trigger?.data?.appointment_start;
  const bookingReference = resolveAppointmentBookingReference(context);

  const appointmentStart = appointmentStartRaw ? new Date(appointmentStartRaw) : null;
  const bookingReferenceAt = bookingReference.raw ? new Date(bookingReference.raw) : null;
  if (!(appointmentStart instanceof Date) || !Number.isFinite(appointmentStart.getTime())) {
    throw new Error('field_check_appointment_start_required');
  }
  if (!(bookingReferenceAt instanceof Date) || !Number.isFinite(bookingReferenceAt.getTime())) {
    throw new Error('field_check_appointment_reference_at_required');
  }

  const timeZone = resolveClinicTimezoneFromContext(context);
  const appointmentDateLocal = formatDateLocal(appointmentStart, timeZone);
  const originalCreatedAt = bookingReference.original_created_at
    ? new Date(bookingReference.original_created_at)
    : null;

  const matchedRule = rules.find((rule) =>
    resolveAppointmentBookingWindowMatch(rule, appointmentDateLocal, bookingReferenceAt, timeZone)
  );

  return {
    decision: !!matchedRule,
    matched_rule_id: matchedRule?.id || null,
    matched_window: matchedRule?.match_window || null,
    appointment_date_local: appointmentDateLocal,
    booking_reference_at: bookingReferenceAt.toISOString(),
    booking_reference_source: bookingReference.source,
    booking_created_at: originalCreatedAt && Number.isFinite(originalCreatedAt.getTime())
      ? originalCreatedAt.toISOString()
      : null,
    trigger_type: bookingReference.trigger_type,
    time_zone: timeZone,
    next_output_key: matchedRule?.id || 'on_else',
  };
}

function evaluateFieldCheck(config, context) {
  const mode = cleanString(config?.mode) || 'simple';
  if (!FIELD_CHECK_MODE_VALUES.has(mode)) {
    throw new Error(`field_check_invalid_mode:${mode}`);
  }

  if (mode === 'appointment_booking_timing') {
    return evaluateAppointmentBookingTimingFieldCheck(config, context);
  }

  const decision = evaluateSimpleFieldCheck(config, context);
  return {
    decision,
    operator: config?.operator || 'equals',
    next_output_key: decision ? 'on_true' : 'on_false',
  };
}

function isAccessGuidanceReminderFieldCheck(config) {
  const leftRef = isObject(config?.left_ref) ? config.left_ref : null;
  const path = cleanString(leftRef?.path)?.toLowerCase();
  return ['clinica.access_guidance_reminder_enabled', 'clinic.access_guidance_reminder_enabled'].includes(path);
}

function evaluateResponseExists(config, context) {
  const listensTo = cleanString(config?.listens_to_node_id);
  if (!listensTo) return false;

  const output = context?.outputs?.[listensTo];
  const responseText = output?.response_text;
  return responseText !== undefined && responseText !== null && String(responseText).trim() !== '';
}

function cleanReviewInlineFeedbackReason(value) {
  return cleanString(value || '')
    .replace(/^[\s.,;:!¡¿?\-–—]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReviewRatingDetailsFromResponseText(value) {
  const text = cleanString(value);
  if (!text) return { rating: null, reason: '' };
  const starCount = (text.match(/[⭐★]/g) || []).length;
  if (starCount >= 1 && starCount <= 5 && !/[0-9]/.test(text)) {
    return { rating: starCount, reason: '' };
  }
  const explicitMatch = text.match(/(?:^|[^\d])([1-5])\s*(?:\/\s*5|de\s*5|estrellas?|stars?|⭐|★)(?:$|[^\d])/i);
  if (explicitMatch) {
    const rating = Number(explicitMatch[1]);
    return rating >= 1 && rating <= 5
      ? {
        rating,
        reason: cleanReviewInlineFeedbackReason(text.slice(explicitMatch.index + explicitMatch[0].length)),
      }
      : { rating: null, reason: '' };
  }
  const compactMatch = text.length <= 40
    ? text.match(/(?:^|[^\d])([1-5])(?:$|[^\d])/i)
    : null;
  if (!compactMatch) return { rating: null, reason: '' };
  const rating = Number(compactMatch[1]);
  return rating >= 1 && rating <= 5
    ? {
      rating,
      reason: cleanReviewInlineFeedbackReason(text.slice(compactMatch.index + compactMatch[0].length)),
    }
    : { rating: null, reason: '' };
}

function extractReviewRatingFromResponseText(value) {
  return extractReviewRatingDetailsFromResponseText(value).rating || null;
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

function parseDateValueOrNull(value) {
  if (!value) return null;
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) return null;
  return candidate;
}

function findLatestOutboundOutputRef(context) {
  const outputs = context?.outputs && typeof context.outputs === 'object'
    ? context.outputs
    : {};
  const entries = Object.entries(outputs);
  for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
    const [nodeId, output] = entries[idx];
    if (!output || typeof output !== 'object') continue;
    const conversationId = toIntOrNull(output.conversation_id || output.chat_conversation_id);
    const messageId = toIntOrNull(output.message_id);
    if (!conversationId || !messageId) continue;
    return { node_id: nodeId, output };
  }
  return null;
}

function resolveWaitResponseAnchor(context, config) {
  const listensTo = cleanString(config?.listens_to_node_id);
  const listenedOutput = listensTo ? getByPath(context, `outputs.${listensTo}`) : null;
  const listenedConversationId = toIntOrNull(
    listenedOutput?.conversation_id
    || listenedOutput?.chat_conversation_id
  );
  const listenedMessageId = toIntOrNull(listenedOutput?.message_id);
  const fallback = (!listenedConversationId || !listenedMessageId)
    ? findLatestOutboundOutputRef(context)
    : null;
  const effectiveListensTo = fallback?.node_id || listensTo;
  const effectiveOutput = fallback?.output || listenedOutput;
  const anchorAt = parseDateValueOrNull(
    effectiveOutput?.effective_send_at
    || effectiveOutput?.scheduled_for
    || null
  );
  return {
    listens_to_node_id: effectiveListensTo,
    listened_output: effectiveOutput,
    anchor_at: anchorAt,
  };
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
        const messageMode = normalizeWhatsappMessageMode(resolveTemplateValue(config?.message_mode, context));
        const manualText = cleanString(resolveTemplateValue(config?.manual_message_text, context));
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            message_mode: messageMode,
            template_id: toIntOrNull(resolveTemplateValue(config?.template_id, context)),
            message_preview: messageMode === 'manual'
              ? (manualText || null)
              : null,
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

    case 'action/request_review': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            review_source: cleanString(resolveTemplateValue(config?.review_source, context)) || 'completed_treatment',
            review_threshold: toIntOrNull(resolveTemplateValue(config?.review_threshold, context)) || 5,
            whatsapp_template_id: toIntOrNull(resolveTemplateValue(config?.whatsapp_template_id, context)) || null,
            review_gift_enabled: parseBool(resolveTemplateValue(config?.review_gift_enabled, context), false),
            review_gift_description: cleanString(resolveTemplateValue(config?.review_gift_description, context)) || null,
            review_display_clinic_name: cleanString(resolveTemplateValue(config?.review_display_clinic_name, context)) || null,
            review_sender_name: cleanString(resolveTemplateValue(config?.review_sender_name, context)) || null,
            review_team_photo_url: cleanString(resolveTemplateValue(config?.review_team_photo_url, context)) || null,
            review_team_photo_overlay_color: cleanString(resolveTemplateValue(config?.review_team_photo_overlay_color, context)) || null,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleRequestReview(node, context, runtime);
    }

    case 'action/request_review_reminder': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            list_id: cleanString(resolveTemplateValue(config?.list_id, context)) || null,
            item_id: cleanString(resolveTemplateValue(config?.item_id, context)) || null,
            reminder_policy: cleanString(resolveTemplateValue(config?.reminder_policy, context)) || 'after_24h',
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleRequestReviewReminder(node, context, runtime);
    }

    case 'action/review_followup': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            review_threshold: toIntOrNull(resolveTemplateValue(config?.review_threshold, context)) || 5,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleReviewFollowup(node, context);
    }

    case 'action/review_no_response': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            reason: cleanString(resolveTemplateValue(config?.reason, context)) || 'sin_respuesta_tras_recordatorio',
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleReviewNoResponse(node, context);
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

    case 'action/send_system_notification': {
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            title: cleanString(resolveTemplateValue(config?.title, context)) || 'Notificación del sistema',
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }
      return handleSendSystemNotification(node, context, runtime);
    }

    case 'action/update_google_special_hours': {
      const period = config?.period && typeof config.period === 'object'
        ? config.period
        : null;
      const timeZone = cleanString(config?.time_zone || config?.timeZone) || 'Europe/Madrid';
      if (simulation) {
        return {
          kind: 'success',
          output: {
            status: 'simulated',
            simulated: true,
            period,
            time_zone: timeZone,
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }

      const targets = resolveRuntimeTargets(runtime?.execution, context);
      const clinicId = toIntOrNull(targets.clinic_id);
      if (!clinicId || !period) {
        throw new Error(!clinicId
          ? 'business_profile_special_hours_clinic_missing'
          : 'business_profile_special_hours_period_missing');
      }

      const template = await AutomationFlowTemplateV2.findByPk(runtime?.execution?.template_version_id);
      if (!template || template.is_active === false) {
        return {
          kind: 'success',
          output: {
            status: 'skipped',
            reason: 'automation_inactive',
          },
          next_node_id: readOutputTarget(node, 'on_success'),
        };
      }

      const result = await businessProfileLocal.applyScheduledSpecialHoursPeriod(clinicId, {
        period,
        timeZone,
      });
      if (parseBool(config?.auto_deactivate_after_execution, false)) {
        const triggerConfig = template.trigger_config && typeof template.trigger_config === 'object'
          ? template.trigger_config
          : {};
        await template.update({
          is_active: false,
          trigger_config: {
            ...triggerConfig,
            last_executed_at: new Date().toISOString(),
          },
        });
      }

      return {
        kind: 'success',
        output: {
          status: 'synced',
          clinic_id: clinicId,
          period,
          time_zone: result?.timeZone || timeZone,
          synced_at: result?.syncedAt || new Date().toISOString(),
        },
        next_node_id: readOutputTarget(node, 'on_success'),
      };
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

    case 'control/end': {
      return {
        kind: 'success',
        output: {
          status: 'flow_ended',
        },
        next_node_id: null,
      };
    }

    case 'delay/fixed': {
      const waitUntil = resolveFixedDelayUntil(config);
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason: 'fixed_delay',
          run_at_time: cleanString(config?.run_at_time || config?.runAtTime) || null,
        },
        waiting_meta: {
          type: nodeType,
          next_node_id: readOutputTarget(node, 'on_complete'),
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_until': {
      let waitUntil = null;
      let reason = 'wait_until';
      let timeZone = null;
      if (cleanString(config?.mode) === 'clinic_schedule') {
        const targets = resolveRuntimeTargets(runtime?.execution, context);
        const schedule = await resolveLeadAutoReplyWait({
          clinicId: toIntOrNull(targets.clinic_id),
          scheduleScope: cleanString(config?.schedule_scope) || 'clinic_hours',
          timing: cleanString(config?.timing) || 'immediate',
        });
        if (!schedule.available || !schedule.waitUntil) {
          throw new Error(schedule.reason || 'clinic_opening_not_found');
        }
        waitUntil = schedule.waitUntil;
        reason = schedule.reason;
        timeZone = schedule.timeZone || null;
      } else {
        waitUntil = parseWaitUntilExpression(config?.datetime_expression, context) || new Date();
      }
      if (waitUntil.getTime() <= Date.now() + 1000) {
        return {
          kind: 'success',
          output: {
            wait_until: waitUntil.toISOString(),
            reason,
            time_zone: timeZone,
            waited: false,
          },
          next_node_id: readOutputTarget(node, 'on_complete'),
        };
      }
      return {
        kind: 'waiting',
        output: {
          wait_until: waitUntil.toISOString(),
          reason,
          time_zone: timeZone,
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
      const waitAnchor = resolveWaitResponseAnchor(context, config);
      const waitStartAt = waitAnchor.anchor_at || new Date();
      const waitUntil = timeoutMs > 0 ? new Date(waitStartAt.getTime() + timeoutMs) : null;
      const responseBufferEnabled = parseBool(resolveTemplateValue(config?.response_buffer_enabled, context), true);
      return {
        kind: 'waiting',
        output: {
          waits_for_response: true,
          runtime_namespace: CURRENT_RUNTIME_NAMESPACE,
          listens_to_node_id: waitAnchor.listens_to_node_id,
          wait_starts_at: waitStartAt.toISOString(),
          timeout_at: waitUntil ? waitUntil.toISOString() : null,
          response_buffer_enabled: responseBufferEnabled,
        },
        waiting_meta: {
          type: nodeType,
          runtime_namespace: CURRENT_RUNTIME_NAMESPACE,
          listens_to_node_id: waitAnchor.listens_to_node_id,
          wait_starts_at: waitStartAt.toISOString(),
          on_response: readOutputTarget(node, 'on_response'),
          on_timeout: readOutputTarget(node, 'on_timeout'),
          response_buffer_enabled: responseBufferEnabled,
        },
        wait_until: waitUntil,
      };
    }

    case 'delay/wait_form_submission': {
      const timeoutMs = resolveDurationMs(config?.timeout_duration ?? 24, config?.timeout_unit || 'hours');
      const waitUntil = timeoutMs > 0 ? new Date(Date.now() + timeoutMs) : null;
      const matchMode = normalizeFormSubmissionMatchMode(resolveTemplateValue(config?.match_mode, context));
      const matchValue = cleanString(resolveTemplateValue(config?.match_value, context));
      if (!matchValue) {
        throw new Error('wait_form_submission_match_value_required');
      }
      return {
        kind: 'waiting',
        output: {
          waits_for_form_submission: true,
          runtime_namespace: CURRENT_RUNTIME_NAMESPACE,
          match_mode: matchMode,
          match_value: matchValue,
          timeout_at: waitUntil ? waitUntil.toISOString() : null,
        },
        waiting_meta: {
          type: nodeType,
          runtime_namespace: CURRENT_RUNTIME_NAMESPACE,
          match_mode: matchMode,
          match_value: matchValue,
          on_submit: readOutputTarget(node, 'on_submit'),
          on_timeout: readOutputTarget(node, 'on_timeout'),
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

      const runtimeTargets = await backfillRuntimeTargets(runtime?.execution, resolveRuntimeTargets(runtime?.execution, context));
      const aiContext = await enrichConversationContext(context, runtimeTargets);

      const resolvedInstruction = cleanString(resolveTemplateValue(config?.instruction, aiContext));
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
            value: resolveTemplateValue(path, aiContext),
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

      const presetKey = cleanString(config?.preset_key);
      const deterministicPresetOutput = presetKey === 'confirm_appointment'
        ? buildDeterministicConfirmAppointmentOutput(aiContext)
        : (presetKey === 'appointment_unconfirmed_reply'
            ? buildDeterministicAppointmentUnconfirmedReplyOutput(aiContext)
            : null);
      if (deterministicPresetOutput) {
        const deterministicDecision = cleanString(deterministicPresetOutput?.decision).toLowerCase();
        return {
          kind: 'success',
          output: deterministicPresetOutput,
          next_node_id: presetKey === 'confirm_appointment'
            ? (deterministicDecision === 'confirmado'
                ? readOutputTarget(node, 'on_success')
                : readOutputTarget(node, 'on_fail'))
            : readOutputTarget(node, 'on_success'),
        };
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
        const simulatedOutput = buildAiSimulatedOutput(outputFormatSimple, analysisMode, selectedModel);
        const decision = cleanString(simulatedOutput?.decision).toLowerCase();
        return {
          kind: 'success',
          output: simulatedOutput,
          next_node_id: presetKey === 'confirm_appointment'
            ? (decision === 'confirmado'
                ? readOutputTarget(node, 'on_success')
                : readOutputTarget(node, 'on_fail'))
            : readOutputTarget(node, 'on_success'),
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

      const normalizedDecision = cleanString(aiOutput?.decision).toLowerCase();
      const nextNodeId = presetKey === 'confirm_appointment'
        ? (normalizedDecision === 'confirmado'
            ? readOutputTarget(node, 'on_success')
            : readOutputTarget(node, 'on_fail'))
        : readOutputTarget(node, 'on_success');

      return {
        kind: 'success',
        output: aiOutput,
        next_node_id: nextNodeId,
      };
    }

    case 'condition/field_check': {
      if (cleanString(config?.mode) === 'lead_contact_state') {
        const targets = resolveRuntimeTargets(runtime?.execution, context);
        const result = await evaluatePendingLeadContact({
          leadId: toIntOrNull(targets.lead_intake_id),
          triggeredAt: context?.trigger?.data?.event_at || runtime?.execution?.created_at || null,
        });
        return {
          kind: 'success',
          output: {
            ...result,
            next_output_key: result.decision ? 'on_true' : 'on_false',
          },
          next_node_id: readOutputTarget(node, result.decision ? 'on_true' : 'on_false'),
        };
      }
      let evaluationContext = context;
      if (isAccessGuidanceReminderFieldCheck(config)) {
        let targets = resolveRuntimeTargets(runtime?.execution, context);
        targets = await backfillRuntimeTargets(runtime?.execution, targets);
        evaluationContext = await enrichContextForTemplateResolution(context, targets);
      }
      const result = evaluateFieldCheck(config, evaluationContext);
      const observableResult = isAccessGuidanceReminderFieldCheck(config)
        ? {
            ...result,
            branch: result.decision ? 'access_guidance' : 'base',
            clinic_id: toIntOrNull(
              evaluationContext?.clinica?.id_clinica
              || evaluationContext?.clinic?.id_clinica
            ),
            appointment_type: cleanString(
              evaluationContext?.cita?.tipo_cita
              || evaluationContext?.appointment?.tipo_cita
            ),
            access_guidance_enabled: evaluationContext?.clinica?.access_guidance_enabled === true
              || evaluationContext?.clinic?.access_guidance_enabled === true,
          }
        : result;
      return {
        kind: 'success',
        output: observableResult,
        next_node_id: readOutputTarget(node, result.next_output_key),
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

async function resumeWaitingNode(execution, node, context, {
  mode,
  responseText,
  formSubmission,
  inboundMessageId: inboundMessageIdOption = null,
  responseMediaKind = null,
  responseMediaId = null,
  responseMediaMimeType = null,
}) {
  const nodeType = cleanString(node?.type) || '';

  if (nodeType === 'delay/wait_response') {
    const useResponse = mode === 'response';
    const nextNode = useResponse
      ? readOutputTarget(node, 'on_response')
      : readOutputTarget(node, 'on_timeout');

    let nextContext = context;
    let forcedConversationId = null;
    if (useResponse) {
      const waitingMeta = execution?.waiting_meta && typeof execution.waiting_meta === 'object'
        ? execution.waiting_meta
        : {};
      const inboundMessageId = toIntOrNull(waitingMeta.last_inbound_message_id)
        || toIntOrNull(inboundMessageIdOption);
      const inboundMessage = inboundMessageId
        ? await Message.findByPk(inboundMessageId, {
            attributes: ['id', 'message_type', 'content', 'metadata', 'sent_at', 'createdAt'],
            raw: true,
          })
        : null;
      const inboundMessageType = cleanString(inboundMessage?.message_type).toLowerCase();
      const effectiveResponseText = inboundMessageType === 'reaction'
        ? null
        : responseText;
      const inboundMetadata = isObject(inboundMessage?.metadata) ? inboundMessage.metadata : {};
      const inboundMedia = isObject(inboundMetadata.media) ? inboundMetadata.media : {};
      const mediaKind = cleanString(
        waitingMeta.last_inbound_media_kind
        || responseMediaKind
        || inboundMedia.kind
      );
      const mediaId = cleanString(
        waitingMeta.last_inbound_media_id
        || responseMediaId
        || inboundMedia.id
      );
      const mediaMimeType = cleanString(
        waitingMeta.last_inbound_media_mime_type
        || responseMediaMimeType
        || inboundMedia.mime_type
      );
      const inboundReaction = isObject(inboundMetadata.reaction) ? inboundMetadata.reaction : {};
      const listensTo = cleanString(waitingMeta.listens_to_node_id)
        || cleanString(node?.config?.listens_to_node_id);
      const listenedOutput = listensTo ? getByPath(context, `outputs.${listensTo}`) : null;
      forcedConversationId = toIntOrNull(
        listenedOutput?.conversation_id
        || listenedOutput?.chat_conversation_id
      );
      const listenedMessagePreview = cleanString(
        listenedOutput?.message_preview
        || listenedOutput?.content
        || listenedOutput?.body
      );
      const respondedAt = new Date().toISOString();
      const responseRatingDetails = extractReviewRatingDetailsFromResponseText(effectiveResponseText);
      const responseRating = responseRatingDetails.rating || null;
      const responseRatingReason = responseRatingDetails.reason || null;
      nextContext = mergeNodeOutput(nextContext, node.id, {
        status: 'responded',
        response_text: effectiveResponseText ?? null,
        response_rating: responseRating,
        response_rating_reason: responseRatingReason,
        response_lines: String(effectiveResponseText || '')
          .split(/\r?\n/)
          .map((line) => cleanString(line))
          .filter(Boolean),
        response_message_id: toIntOrNull(inboundMessage?.id),
        response_message_type: cleanString(inboundMessage?.message_type) || null,
        response_message_preview: cleanString(inboundMessage?.content) || null,
        response_media_kind: mediaKind || null,
        response_media_id: mediaId || null,
        response_media_mime_type: mediaMimeType || null,
        reaction_emoji: cleanString(inboundReaction.emoji) || null,
        reaction_target_message_id: cleanString(
          inboundReaction.target_message_id
          || inboundReaction.targetMessageId
        ) || null,
        reaction_target_message_type: cleanString(
          inboundReaction.target_message_type
          || inboundReaction.targetMessageType
        ) || null,
        reaction_target_message_preview: cleanString(
          inboundReaction.target_message_preview
          || inboundReaction.targetMessagePreview
        ) || null,
        listens_to_node_id: listensTo,
        listened_message_preview: listenedMessagePreview,
        responded_at: respondedAt,
        resumed_at: respondedAt,
        resume_mode: 'response',
      });
      // Alias de contexto para simplificar plantillas IA sin depender de IDs de nodos.
      nextContext = {
        ...(nextContext || {}),
        last_response: effectiveResponseText ?? null,
        last_prompt: listenedMessagePreview || null,
        last_response_context: {
          response_text: effectiveResponseText ?? null,
          response_rating: responseRating,
          response_rating_reason: responseRatingReason,
          response_message_id: toIntOrNull(inboundMessage?.id),
          response_message_type: cleanString(inboundMessage?.message_type) || null,
          response_message_preview: cleanString(inboundMessage?.content) || null,
          response_media_kind: mediaKind || null,
          response_media_id: mediaId || null,
          response_media_mime_type: mediaMimeType || null,
          reaction_emoji: cleanString(inboundReaction.emoji) || null,
          reaction_target_message_id: cleanString(
            inboundReaction.target_message_id
            || inboundReaction.targetMessageId
          ) || null,
          reaction_target_message_type: cleanString(
            inboundReaction.target_message_type
            || inboundReaction.targetMessageType
          ) || null,
          reaction_target_message_preview: cleanString(
            inboundReaction.target_message_preview
            || inboundReaction.targetMessagePreview
          ) || null,
          listened_message_preview: listenedMessagePreview || null,
          wait_node_id: node.id,
          listens_to_node_id: listensTo || null,
          responded_at: respondedAt,
        },
      };
    } else {
      nextContext = mergeNodeOutput(nextContext, node.id, {
        status: 'timed_out',
        timed_out: true,
        timed_out_at: new Date().toISOString(),
        resumed_at: new Date().toISOString(),
        resume_mode: 'timeout',
      });
    }

    const resumeTargets = resolveRuntimeTargets(execution, nextContext);
    if (forcedConversationId) {
      resumeTargets.conversation_id = forcedConversationId;
    }
    const refreshedTargets = await backfillRuntimeTargets(execution, resumeTargets);
    nextContext = await enrichConversationContext(nextContext, refreshedTargets);

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

  if (nodeType === 'delay/wait_form_submission') {
    const useSubmission = mode === 'form_submission';
    const nextNode = useSubmission
      ? readOutputTarget(node, 'on_submit')
      : readOutputTarget(node, 'on_timeout');
    const waitingMeta = execution?.waiting_meta && typeof execution.waiting_meta === 'object'
      ? execution.waiting_meta
      : {};
    const resolvedMatchMode = cleanString(waitingMeta.match_mode) || cleanString(node?.config?.match_mode) || null;
    const resolvedMatchValue = cleanString(waitingMeta.match_value) || cleanString(node?.config?.match_value) || null;

    let nextContext = context;
    if (useSubmission) {
      const submittedAt = cleanString(formSubmission?.submitted_at) || new Date().toISOString();
      const normalizedFields = formSubmission?.fields && typeof formSubmission.fields === 'object' && !Array.isArray(formSubmission.fields)
        ? formSubmission.fields
        : {};
      const outputPatch = {
        status: 'submitted',
        submitted: true,
        submitted_at: submittedAt,
        page_url: cleanString(formSubmission?.page_url) || null,
        form_id: cleanString(formSubmission?.form_id) || null,
        form_name: cleanString(formSubmission?.form_name) || null,
        form_selector: cleanString(formSubmission?.form_selector) || null,
        match_mode: resolvedMatchMode,
        match_value: resolvedMatchValue,
        fields: normalizedFields,
        field_names: Object.keys(normalizedFields),
        lead_intake_id: toIntOrNull(formSubmission?.lead_intake_id),
        email: cleanString(formSubmission?.email) || null,
        telefono: cleanString(formSubmission?.telefono) || null,
        form_submission_event_id: toIntOrNull(formSubmission?.form_submission_event_id),
        source_detail: cleanString(formSubmission?.source_detail) || 'web_form',
        resumed_at: submittedAt,
        resume_mode: 'form_submission',
      };
      nextContext = mergeNodeOutput(nextContext, node.id, outputPatch);
      nextContext = {
        ...(nextContext || {}),
        last_form_submission: outputPatch,
      };
    } else {
      const timedOutAt = new Date().toISOString();
      nextContext = mergeNodeOutput(nextContext, node.id, {
        status: 'timed_out',
        submitted: false,
        timed_out: true,
        timed_out_at: timedOutAt,
        match_mode: resolvedMatchMode,
        match_value: resolvedMatchValue,
        resumed_at: timedOutAt,
        resume_mode: 'timeout',
      });
    }

    await updateExecutionAndEmit(execution, {
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context: nextContext,
      last_error: null,
    }, 'flow_execution:resumed', { resume_mode: mode || 'form_submission' });

    return { resumed: true, context: nextContext };
  }

  if (nodeType === 'delay/fixed' || nodeType === 'delay/wait_until') {
    const nextNode = readOutputTarget(node, 'on_complete');
    const completedAt = new Date().toISOString();
    const nextContext = mergeNodeOutput(context, node.id, {
      status: 'completed',
      completed_at: completedAt,
      resumed_at: completedAt,
      resume_mode: mode || 'timeout',
    });
    await updateExecutionAndEmit(execution, {
      status: 'running',
      wait_until: null,
      waiting_meta: null,
      current_node_id: nextNode,
      context: nextContext,
      last_error: null,
    }, 'flow_execution:resumed', { resume_mode: mode || 'timeout' });
    return { resumed: true, context: nextContext };
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
  if (!normalizeWhatsappLocale(context.communication_language)) {
    // Frontera de compatibilidad: una ejecución creada antes de introducir el
    // snapshot conserva español. Nunca se rellena desde la ficha viva al reanudar.
    context.communication_language = 'es';
    await execution.update({ context });
  }
  if (!context.outputs || typeof context.outputs !== 'object') {
    context.outputs = {};
  }

  if (execution.status === 'waiting' && resumeMode) {
    if (
      (resumeMode === 'timeout' || resumeMode === 'retry_current_node')
      && execution.wait_until
      && new Date(execution.wait_until).getTime() > Date.now()
    ) {
      return execution;
    }

    const [claimedRows] = await FlowExecutionV2.update(
      {
        status: 'running',
        updated_at: new Date(),
      },
      {
        where: {
          id: execution.id,
          status: 'waiting',
        },
      }
    );

    if (!claimedRows) {
      const freshExecution = await FlowExecutionV2.findByPk(executionId, {
        include: [{
          model: AutomationFlowTemplateV2,
          as: 'templateVersion',
        }],
      });
      return freshExecution || execution;
    }

    execution.status = 'running';

    if (resumeMode !== 'retry_current_node') {
      const responseText = options.responseText ?? getByPath(execution.waiting_meta, 'pending_response_text') ?? null;
      const formSubmission = options.formSubmission ?? getByPath(execution.waiting_meta, 'pending_form_submission') ?? null;

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
        formSubmission,
        inboundMessageId: options.inboundMessageId,
        responseMediaKind: options.responseMediaKind,
        responseMediaId: options.responseMediaId,
        responseMediaMimeType: options.responseMediaMimeType,
      });

      context = resumeInfo.context;
    }
  }

  let localStatus = execution.status;
  // `current_node_id` is always set when an execution is created. Falling back to
  // `entry_node_id` here causes resumed waits with no next node (e.g. timeout with
  // no `on_timeout`) to restart the whole flow from the trigger.
  let currentNodeId = cleanString(execution.current_node_id);

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
      if (cleanString(node?.type) === 'action/send_whatsapp') {
        await materializeFailedAutomationWhatsappMessage({
          node,
          context,
          execution,
          errorMessage,
        });
      }

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

      const handoffRetry = buildWhatsappTransportHandoffRetryState({
        errorMessage,
        previousRetryAttempt: execution?.waiting_meta?.retry_attempt,
      });
      if (handoffRetry && !handoffRetry.exhausted) {
        await updateExecutionAndEmit(execution, {
          status: 'waiting',
          current_node_id: currentNodeId,
          context,
          wait_until: handoffRetry.retry_at,
          waiting_meta: {
            resume_mode: 'retry_current_node',
            reason: 'whatsapp_transport_handoff_retry',
            retry_attempt: handoffRetry.retry_attempt,
            max_attempts: handoffRetry.max_attempts,
            last_error: errorMessage,
          },
          last_error: errorMessage,
        }, 'flow_execution:updated');
        localStatus = 'waiting';
        break;
      }

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
  buildAutomationWhatsappDeliveryKey,
  buildAutomationWhatsappRowDeliveryKey,
  findAutomationWhatsappMessageByDeliveryKey,
  findOrCreateAutomationWhatsappMessage,
  reuseExistingAutomationWhatsappMessage,
  readStoredWhatsappReplaySelection,
  formatAppointmentLocalDateTime,
  buildWhatsappTransportHandoffRetryState,
  enqueueAutomationWhatsappTransport,
  enqueueQuietHoursWhatsappJob,
  resolveScheduledWhatsappSenderConfig,
  validateAccessGuidancePublicMediaAsset,
  runScheduledWhatsappSendJob,
  resolveWhatsappLanguageRouting,
  scoreWhatsappTemplateCandidate,
  selectBestWhatsappTemplateCandidate,
  buildDeterministicConfirmAppointmentTextOutput,
  buildDeterministicAppointmentUnconfirmedReplyOutput,
};
