'use strict';

const { Op } = require('sequelize');
const db = require('../../models');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const CitaPaciente = db.CitaPaciente;
const Paciente = db.Paciente;
const LeadIntake = db.LeadIntake;
const Conversation = db.Conversation;
const Message = db.Message;
const UsuarioClinica = db.UsuarioClinica;
const Usuario = db.Usuario;
const Clinica = db.Clinica;
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const { getIO } = require('../services/socket.service');
const { CITA_STATUS_VALUES, LEAD_STATUS_VALUES } = require('../lib/status-catalog');

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
  .split(',')
  .map((v) => Number.parseInt(String(v).trim(), 10))
  .filter((n) => Number.isInteger(n));

const MANAGER_ROLES = new Set(['propietario', 'personaldeclinica', 'administrador', 'admin']);
const TASK_ASSIGNEE_ROLE_OPTIONS = [
  { id: 'propietario', code: 'propietario', label: 'Propietario' },
  { id: 'personaldeclinica', code: 'personaldeclinica', label: 'Personal clínica' },
];
const TASK_ROLE_LABELS = {
  propietario: 'Propietario',
  personaldeclinica: 'Personal clínica',
  administrador: 'Administrador',
  admin: 'Administrador',
};
const CHANGE_STATUS_TARGET_OPTIONS = ['appointment', 'lead'];
const UPDATE_LEAD_INFO_MODE_OPTIONS = [
  'set_required',
  'set_received',
  'append_received',
  'clear_required',
  'clear_received',
  'clear_all',
];
const AI_ANALYSIS_MODE_OPTIONS = ['quick_qa', 'complex_reasoning', 'auto'];
const CITA_STATUS_SET = new Set(CITA_STATUS_VALUES);
const LEAD_STATUS_SET = new Set(LEAD_STATUS_VALUES);
const ANY_CHANGE_STATUS_SET = new Set([...CITA_STATUS_VALUES, ...LEAD_STATUS_VALUES]);

function parseIntOrNull(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const normalized = typeof raw === 'string' && raw.includes(',') ? raw.split(',')[0].trim() : raw;
  const parsed = Number.parseInt(String(normalized), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseIntList(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function parseBool(raw, fallback = undefined) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseStringArrayLike(raw) {
  if (raw === undefined || raw === null) return [];

  if (Array.isArray(raw)) {
    return raw
      .map((item) => cleanString(item))
      .filter(Boolean);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .map((item) => cleanString(item))
            .filter(Boolean);
        }
      } catch (_err) {
        // Fallback to comma parsing below.
      }
    }
    return trimmed
      .split(',')
      .map((item) => cleanString(item))
      .filter(Boolean);
  }

  return [];
}

function parseLimit(raw, fallback = 20) {
  const parsed = parseIntOrNull(raw);
  if (!parsed || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function parseOffset(raw) {
  const parsed = parseIntOrNull(raw);
  if (!parsed || parsed < 0) return 0;
  return parsed;
}

function cleanString(raw) {
  if (raw === undefined || raw === null) return null;
  const out = String(raw).trim();
  return out || null;
}

function normalizeToken(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function joinName(...parts) {
  return parts
    .map((part) => cleanString(part))
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function buildHydratedExecutionContext({
  triggerType,
  triggerEntityType,
  triggerEntityId,
  triggerData,
}) {
  const out = {
    trigger: {
      type: cleanString(triggerType) || 'manual',
      data: isObject(triggerData) ? { ...triggerData } : {},
    },
  };

  const normalizedType = normalizeToken(triggerEntityType);
  const normalizedTrigger = normalizeToken(triggerType);

  const appointmentCandidateId = parseIntOrNull(triggerEntityId)
    || parseIntOrNull(triggerData?.appointment_id)
    || parseIntOrNull(triggerData?.cita_id)
    || parseIntOrNull(triggerData?.id_cita);

  const leadCandidateId = parseIntOrNull(triggerEntityId)
    || parseIntOrNull(triggerData?.lead_id)
    || parseIntOrNull(triggerData?.lead_intake_id);

  const patientCandidateId = parseIntOrNull(triggerEntityId)
    || parseIntOrNull(triggerData?.patient_id)
    || parseIntOrNull(triggerData?.paciente_id);

  const mustHydrateAppointment = (
    appointmentCandidateId
    && (
      normalizedType === 'appointment'
      || normalizedType === 'cita'
      || normalizedTrigger.startsWith('appointment_')
    )
  );

  if (mustHydrateAppointment) {
    const cita = await CitaPaciente.findByPk(appointmentCandidateId, {
      include: [
        {
          model: Paciente,
          as: 'paciente',
          required: false,
          attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'],
        },
        {
          model: Clinica,
          as: 'clinica',
          required: false,
          attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
        },
      ],
      attributes: ['id_cita', 'clinica_id', 'paciente_id', 'lead_intake_id', 'estado', 'inicio', 'fin', 'titulo', 'motivo'],
    });

    if (cita) {
      const citaJson = cita.toJSON ? cita.toJSON() : cita;
      const citaPatch = {
        id: parseIntOrNull(citaJson.id_cita),
        id_cita: parseIntOrNull(citaJson.id_cita),
        clinic_id: parseIntOrNull(citaJson.clinica_id),
        clinica_id: parseIntOrNull(citaJson.clinica_id),
        patient_id: parseIntOrNull(citaJson.paciente_id),
        paciente_id: parseIntOrNull(citaJson.paciente_id),
        lead_intake_id: parseIntOrNull(citaJson.lead_intake_id),
        estado: cleanString(citaJson.estado),
        status: cleanString(citaJson.estado),
        inicio: citaJson.inicio || null,
        fin: citaJson.fin || null,
        fecha: formatDateEs(citaJson.inicio),
        hora: formatTimeEs(citaJson.inicio),
        titulo: cleanString(citaJson.titulo),
        motivo: cleanString(citaJson.motivo),
        origin: parseIntOrNull(citaJson.lead_intake_id) ? 'lead' : 'manual',
      };
      out.appointment = {
        ...(isObject(out.appointment) ? out.appointment : {}),
        ...citaPatch,
      };
      out.cita = {
        ...(isObject(out.cita) ? out.cita : {}),
        ...citaPatch,
      };

      if (citaJson.paciente) {
        const paciente = citaJson.paciente;
        const patientPatch = {
          id: parseIntOrNull(paciente.id_paciente),
          id_paciente: parseIntOrNull(paciente.id_paciente),
          clinic_id: parseIntOrNull(paciente.clinica_id),
          clinica_id: parseIntOrNull(paciente.clinica_id),
          nombre: cleanString(paciente.nombre),
          apellidos: cleanString(paciente.apellidos),
          nombre_completo: joinName(paciente.nombre, paciente.apellidos) || null,
          telefono: cleanString(paciente.telefono_movil),
          telefono_movil: cleanString(paciente.telefono_movil),
          email: cleanString(paciente.email),
        };
        out.patient = {
          ...(isObject(out.patient) ? out.patient : {}),
          ...patientPatch,
        };
        out.paciente = {
          ...(isObject(out.paciente) ? out.paciente : {}),
          ...patientPatch,
        };
      }

      if (citaJson.clinica) {
        const clinica = citaJson.clinica;
        const clinicPatch = {
          id: parseIntOrNull(clinica.id_clinica),
          id_clinica: parseIntOrNull(clinica.id_clinica),
          clinic_id: parseIntOrNull(clinica.id_clinica),
          clinica_id: parseIntOrNull(clinica.id_clinica),
          group_id: parseIntOrNull(clinica.grupoClinicaId),
          grupo_id: parseIntOrNull(clinica.grupoClinicaId),
          nombre: cleanString(clinica.nombre_clinica),
          nombre_clinica: cleanString(clinica.nombre_clinica),
        };
        out.clinic = {
          ...(isObject(out.clinic) ? out.clinic : {}),
          ...clinicPatch,
        };
        out.clinica = {
          ...(isObject(out.clinica) ? out.clinica : {}),
          ...clinicPatch,
        };
      }

      if (parseIntOrNull(citaJson.lead_intake_id)) {
        const lead = await LeadIntake.findByPk(parseIntOrNull(citaJson.lead_intake_id), {
          attributes: ['id', 'clinica_id', 'nombre', 'telefono', 'email', 'status_lead'],
          raw: true,
        });
        if (lead) {
          out.lead = {
            ...(isObject(out.lead) ? out.lead : {}),
            id: parseIntOrNull(lead.id),
            lead_intake_id: parseIntOrNull(lead.id),
            clinica_id: parseIntOrNull(lead.clinica_id),
            clinic_id: parseIntOrNull(lead.clinica_id),
            nombre: cleanString(lead.nombre),
            telefono: cleanString(lead.telefono),
            email: cleanString(lead.email),
            status: cleanString(lead.status_lead),
            status_lead: cleanString(lead.status_lead),
          };
        }
      }
    }
  } else if (leadCandidateId && ['lead', 'lead_intake', 'leadintake', 'lead_nuevo'].includes(normalizedType)) {
    const lead = await LeadIntake.findByPk(leadCandidateId, {
      attributes: ['id', 'clinica_id', 'nombre', 'telefono', 'email', 'status_lead'],
      raw: true,
    });
    if (lead) {
      out.lead = {
        ...(isObject(out.lead) ? out.lead : {}),
        id: parseIntOrNull(lead.id),
        lead_intake_id: parseIntOrNull(lead.id),
        clinica_id: parseIntOrNull(lead.clinica_id),
        clinic_id: parseIntOrNull(lead.clinica_id),
        nombre: cleanString(lead.nombre),
        telefono: cleanString(lead.telefono),
        email: cleanString(lead.email),
        status: cleanString(lead.status_lead),
        status_lead: cleanString(lead.status_lead),
      };
    }
  } else if (patientCandidateId && ['patient', 'paciente'].includes(normalizedType)) {
    const patient = await Paciente.findByPk(patientCandidateId, {
      attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'],
      raw: true,
    });
    if (patient) {
      const patientPatch = {
        id: parseIntOrNull(patient.id_paciente),
        id_paciente: parseIntOrNull(patient.id_paciente),
        clinic_id: parseIntOrNull(patient.clinica_id),
        clinica_id: parseIntOrNull(patient.clinica_id),
        nombre: cleanString(patient.nombre),
        apellidos: cleanString(patient.apellidos),
        nombre_completo: joinName(patient.nombre, patient.apellidos) || null,
        telefono: cleanString(patient.telefono_movil),
        telefono_movil: cleanString(patient.telefono_movil),
        email: cleanString(patient.email),
      };
      out.patient = {
        ...(isObject(out.patient) ? out.patient : {}),
        ...patientPatch,
      };
      out.paciente = {
        ...(isObject(out.paciente) ? out.paciente : {}),
        ...patientPatch,
      };
    }
  }

  const hydratedClinicId = parseIntOrNull(out?.clinic?.id_clinica)
    || parseIntOrNull(out?.clinica?.id_clinica)
    || parseIntOrNull(out?.appointment?.clinica_id)
    || parseIntOrNull(out?.patient?.clinica_id)
    || parseIntOrNull(out?.lead?.clinica_id);

  if (hydratedClinicId && !out.clinic) {
    const clinic = await Clinica.findByPk(hydratedClinicId, {
      attributes: ['id_clinica', 'grupoClinicaId', 'nombre_clinica'],
      raw: true,
    });
    if (clinic) {
      const clinicPatch = {
        id: parseIntOrNull(clinic.id_clinica),
        id_clinica: parseIntOrNull(clinic.id_clinica),
        clinic_id: parseIntOrNull(clinic.id_clinica),
        clinica_id: parseIntOrNull(clinic.id_clinica),
        group_id: parseIntOrNull(clinic.grupoClinicaId),
        grupo_id: parseIntOrNull(clinic.grupoClinicaId),
        nombre: cleanString(clinic.nombre_clinica),
        nombre_clinica: cleanString(clinic.nombre_clinica),
      };
      out.clinic = clinicPatch;
      out.clinica = { ...clinicPatch };
    }
  }

  if (!out.trigger || !isObject(out.trigger)) {
    out.trigger = { type: cleanString(triggerType) || 'manual', data: {} };
  }
  if (!isObject(out.trigger.data)) {
    out.trigger.data = {};
  }
  out.trigger.data = {
    ...(out.trigger.data || {}),
    appointment_id: parseIntOrNull(out?.appointment?.id_cita) || parseIntOrNull(out?.cita?.id_cita) || null,
    cita_id: parseIntOrNull(out?.appointment?.id_cita) || parseIntOrNull(out?.cita?.id_cita) || null,
    patient_id: parseIntOrNull(out?.patient?.id_paciente) || parseIntOrNull(out?.paciente?.id_paciente) || null,
    paciente_id: parseIntOrNull(out?.patient?.id_paciente) || parseIntOrNull(out?.paciente?.id_paciente) || null,
    clinic_id: parseIntOrNull(out?.clinic?.id_clinica) || parseIntOrNull(out?.clinica?.id_clinica) || null,
    clinica_id: parseIntOrNull(out?.clinic?.id_clinica) || parseIntOrNull(out?.clinica?.id_clinica) || null,
    lead_intake_id: parseIntOrNull(out?.lead?.id) || null,
    lead_id: parseIntOrNull(out?.lead?.id) || null,
  };

  return out;
}

function formatDateTimeEs(rawDate) {
  if (!rawDate) return null;
  const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

const TEST_ENTITY_MARKERS = ['test', 'prueba', 'qa', 'dummy', 'sandbox'];

function normalizeSearchText(raw) {
  const value = cleanString(raw);
  if (!value) return null;
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function looksLikeTestEntity(...values) {
  for (const candidate of values) {
    const normalized = normalizeSearchText(candidate);
    if (!normalized) continue;
    if (TEST_ENTITY_MARKERS.some((marker) => normalized.includes(marker))) {
      return true;
    }
  }
  return false;
}

function parseTemplateScopeQuery(query) {
  const explicitScope = cleanString(query?.scope) || cleanString(query?.clinic_id);
  let clinicIds = [];
  let groupId = parseIntOrNull(query?.group_id);

  if (explicitScope) {
    const lowered = explicitScope.toLowerCase();
    if (lowered !== 'all') {
      const groupMatch = explicitScope.match(/^group:(\d+)$/i);
      if (groupMatch) {
        groupId = Number.parseInt(groupMatch[1], 10);
      } else {
        clinicIds = parseIntList(explicitScope);
      }
    }
  }

  return {
    clinic_ids: clinicIds,
    group_id: Number.isInteger(groupId) && groupId > 0 ? groupId : null,
  };
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const TRIGGER_TYPES_V2 = [
  { value: 'appointment_created', label: 'Cita creada (manual o desde lead)' },
  { value: 'appointment_reminder_window', label: 'Ventana de recordatorio' },
  { value: 'appointment_confirmed', label: 'Cita confirmada' },
  { value: 'appointment_no_show', label: 'Cita no show' },
  { value: 'appointment_rescheduled', label: 'Cita reagendada' },
  { value: 'appointment_cancelled', label: 'Cita cancelada' },
  { value: 'appointment_completed', label: 'Cita completada' },
  { value: 'lead_nuevo', label: 'Lead nuevo' },
  { value: 'manual', label: 'Manual' },
];
const TRIGGER_NODE_PREFIX = 'trigger/';
const TRIGGER_NODE_TYPES_V2 = TRIGGER_TYPES_V2.map((trigger) => ({
  type: `${TRIGGER_NODE_PREFIX}${trigger.value}`,
  category: 'trigger',
  label: trigger.label,
  description: `Activa el flujo con evento '${trigger.value}'.`,
  output_keys: ['on_success'],
  runtime_status: 'real',
  default_config: {},
  config_schema: [],
}));

const APPOINTMENT_TRIGGER_TYPES = new Set([
  'appointment_created',
  'appointment_reminder_window',
  'appointment_confirmed',
  'appointment_no_show',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_completed',
]);
const DUE_DATE_OFFSET_REGEX = /^(\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days)$/i;

function normalizeDomain(raw) {
  const value = cleanString(raw);
  if (!value) return null;
  const normalized = value.toLowerCase();
  return ['appointment', 'marketing'].includes(normalized) ? normalized : null;
}

function resolveDomainFromTriggerType(triggerType) {
  if (APPOINTMENT_TRIGGER_TYPES.has(triggerType)) return 'appointment';
  return 'marketing';
}

const NODE_TYPES_V2 = [
  ...TRIGGER_NODE_TYPES_V2,
  {
    type: 'action/change_status',
    category: 'action',
    label: 'Cambiar estado',
    description: 'Cambia el estado de una cita o lead según target_entity.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'real',
    default_config: { target_entity: 'appointment', new_status: 'pendiente', agenda_icon: null },
    config_schema: [
      { key: 'target_entity', label: 'Entidad destino', input_type: 'select', required: false, options: CHANGE_STATUS_TARGET_OPTIONS },
      { key: 'new_status', label: 'Nuevo estado', input_type: 'string', required: true },
      { key: 'agenda_icon', label: 'Icono agenda', input_type: 'string', required: false },
    ],
  },
  {
    type: 'action/update_lead_info',
    category: 'action',
    label: 'Actualizar info del lead',
    description: 'Actualiza info_requerida/info_recibida_items de un lead y puede transicionar estado automáticamente.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'real',
    default_config: {
      mode: 'set_required',
      info_requerida: [],
      info_recibida_items: [],
      auto_transition: true,
      status_when_waiting: 'esperando_info',
      status_when_complete: 'info_recibida',
    },
    config_schema: [
      { key: 'mode', label: 'Modo', input_type: 'select', required: true, options: UPDATE_LEAD_INFO_MODE_OPTIONS },
      { key: 'info_requerida', label: 'Información requerida', input_type: 'json', required: false },
      { key: 'info_recibida_items', label: 'Información recibida', input_type: 'json', required: false },
      { key: 'auto_transition', label: 'Transición automática de estado', input_type: 'boolean', required: false },
      { key: 'status_when_waiting', label: 'Estado cuando falta info', input_type: 'string', required: false },
      { key: 'status_when_complete', label: 'Estado cuando está completa', input_type: 'string', required: false },
    ],
  },
  {
    type: 'action/send_whatsapp',
    category: 'action',
    label: 'Enviar WhatsApp',
    description: 'Envía un mensaje de WhatsApp usando una plantilla aprobada.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'real',
    default_config: {
      template_id: '',
      language_code: 'es_ES',
      recipient_mode: 'context_patient',
      recipient_to: '',
      sender_mode: 'clinic_default',
      sender_origin_id: null,
      quiet_hours_enabled: true,
      variables: {},
    },
    config_schema: [
      { key: 'template_id', label: 'Template ID', input_type: 'string', required: true },
      { key: 'language_code', label: 'Idioma', input_type: 'string', required: false },
      {
        key: 'recipient_mode',
        label: 'Modo destinatario',
        input_type: 'select',
        required: false,
        options: ['context_patient', 'context_lead', 'manual_number'],
      },
      { key: 'recipient_to', label: 'Número destino manual (E.164)', input_type: 'string', required: false },
      {
        key: 'sender_mode',
        label: 'Modo remitente',
        input_type: 'select',
        required: false,
        options: ['clinic_default', 'specific_origin'],
      },
      { key: 'sender_origin_id', label: 'Origen específico (ID phone)', input_type: 'number', required: false },
      { key: 'quiet_hours_enabled', label: 'No enviar entre las 22 y las 7h', input_type: 'boolean', required: false },
      { key: 'variables', label: 'Variables', input_type: 'json', required: false },
    ],
  },
  {
    type: 'action/send_email',
    category: 'action',
    label: 'Enviar Email',
    description: 'Envía un correo electrónico al paciente.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'stub',
    default_config: { template_id: '', subject: '', body_html: '', variables: {} },
    config_schema: [
      { key: 'template_id', label: 'Template ID', input_type: 'string', required: false },
      { key: 'subject', label: 'Asunto', input_type: 'string', required: false },
      { key: 'body_html', label: 'Contenido HTML', input_type: 'text', required: false },
      { key: 'variables', label: 'Variables', input_type: 'json', required: false },
    ],
  },
  {
    type: 'action/create_task',
    category: 'action',
    label: 'Crear tarea',
    description: 'Crea una tarea manual para un usuario o rol.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'real',
    default_config: {
      title: '',
      description: '',
      assignee_type: 'role',
      assignee_id: null,
      subrole: null,
      due_date_offset: '1 day',
    },
    config_schema: [
      { key: 'title', label: 'Título', input_type: 'string', required: true },
      { key: 'description', label: 'Descripción', input_type: 'text', required: false },
      { key: 'assignee_type', label: 'Asignar a', input_type: 'select', required: true, options: ['user', 'role'] },
      { key: 'assignee_id', label: 'Usuario / rol', input_type: 'select', required: true },
      { key: 'subrole', label: 'Subrol (opcional)', input_type: 'select', required: false, options: [] },
      {
        key: 'due_date_offset',
        label: 'Vencimiento de tarea',
        input_type: 'string',
        required: false,
        placeholder: 'Ej: 2 hours, 1 day',
      },
    ],
  },
  {
    type: 'action/write_note',
    category: 'action',
    label: 'Escribir nota',
    description: 'Escribe una nota interna en el historial.',
    output_keys: ['on_success'],
    runtime_status: 'real',
    default_config: { content: '' },
    config_schema: [
      { key: 'content', label: 'Contenido', input_type: 'text', required: true },
    ],
  },
  {
    type: 'action/api_call',
    category: 'action',
    label: 'Llamada API',
    description: 'Realiza una llamada a una API externa.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'stub',
    default_config: { method: 'GET', url: '', headers: {}, body: {} },
    config_schema: [
      { key: 'method', label: 'Método', input_type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'DELETE'] },
      { key: 'url', label: 'URL', input_type: 'string', required: true },
      { key: 'headers', label: 'Headers', input_type: 'json', required: false },
      { key: 'body', label: 'Body', input_type: 'json', required: false },
    ],
  },
  {
    type: 'delay/fixed',
    category: 'delay',
    label: 'Espera fija',
    description: 'Espera un periodo de tiempo fijo.',
    output_keys: ['on_complete'],
    runtime_status: 'real',
    default_config: { duration: 1, unit: 'hours' },
    config_schema: [
      { key: 'duration', label: 'Duración', input_type: 'number', required: true },
      { key: 'unit', label: 'Unidad', input_type: 'select', required: true, options: ['seconds', 'minutes', 'hours', 'days'] },
    ],
  },
  {
    type: 'delay/wait_response',
    category: 'delay',
    label: 'Esperar respuesta',
    description: 'Espera una respuesta con timeout.',
    output_keys: ['on_response', 'on_timeout'],
    runtime_status: 'real',
    default_config: { timeout_duration: 1, timeout_unit: 'hours', listens_to_node_id: null },
    config_schema: [
      { key: 'timeout_duration', label: 'Timeout', input_type: 'number', required: true },
      { key: 'timeout_unit', label: 'Unidad timeout', input_type: 'select', required: true, options: ['minutes', 'hours'] },
      { key: 'listens_to_node_id', label: 'Nodo escuchado', input_type: 'string', required: false },
    ],
  },
  {
    type: 'delay/wait_until',
    category: 'delay',
    label: 'Esperar hasta',
    description: 'Espera hasta fecha/hora específica.',
    output_keys: ['on_complete'],
    runtime_status: 'real',
    default_config: { datetime_expression: '' },
    config_schema: [
      { key: 'datetime_expression', label: 'Expresión fecha/hora', input_type: 'string', required: true },
    ],
  },
  {
    type: 'condition/field_check',
    category: 'condition',
    label: 'Comprobar campo',
    description: 'Evalúa una condición simple sobre un campo.',
    output_keys: ['on_true', 'on_false'],
    runtime_status: 'real',
    default_config: { field: '', operator: 'equals', value: '' },
    config_schema: [
      { key: 'field', label: 'Campo', input_type: 'string', required: true },
      {
        key: 'operator',
        label: 'Operador',
        input_type: 'select',
        required: true,
        options: ['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'exists'],
      },
      { key: 'value', label: 'Valor', input_type: 'string', required: false },
    ],
  },
  {
    type: 'condition/ai_analysis',
    category: 'condition',
    label: 'Análisis IA',
    description: 'Analiza texto con IA y devuelve una decisión.',
    output_keys: ['on_success', 'on_fail'],
    runtime_status: 'real',
    default_config: {
      analysis_mode: 'complex_reasoning',
      prompt: '',
      input_text: '',
      max_tokens: 700,
      output_format: { decision: { type: 'string' }, reason: { type: 'string' } },
    },
    config_schema: [
      {
        key: 'analysis_mode',
        label: 'Modo de análisis',
        input_type: 'select',
        required: false,
        options: AI_ANALYSIS_MODE_OPTIONS,
      },
      { key: 'prompt', label: 'Prompt', input_type: 'text', required: true },
      { key: 'input_text', label: 'Texto entrada', input_type: 'text', required: true },
      { key: 'max_tokens', label: 'Límite de tokens', input_type: 'number', required: false },
      { key: 'output_format', label: 'Formato salida', input_type: 'json', required: true },
    ],
  },
  {
    type: 'condition/response_check',
    category: 'condition',
    label: 'Comprobar respuesta',
    description: 'Comprueba si ya existe respuesta para un nodo.',
    output_keys: ['on_response', 'on_no_response'],
    runtime_status: 'real',
    default_config: { listens_to_node_id: null },
    config_schema: [
      { key: 'listens_to_node_id', label: 'Nodo escuchado', input_type: 'string', required: true },
    ],
  },
];

function getNodeTypeMeta(type) {
  return NODE_TYPES_V2.find((n) => n.type === type) || null;
}

function isSupportedTriggerType(triggerType) {
  return TRIGGER_TYPES_V2.some((t) => t.value === triggerType);
}

function parseTriggerTypeFromNodeType(nodeType) {
  const rawType = cleanString(nodeType);
  if (!rawType || !rawType.startsWith(TRIGGER_NODE_PREFIX)) return null;
  const triggerType = cleanString(rawType.slice(TRIGGER_NODE_PREFIX.length));
  if (!triggerType || !isSupportedTriggerType(triggerType)) return null;
  return triggerType;
}

function resolveTriggerTypeFromEntryNode({ entryNodeId, nodes }) {
  if (!entryNodeId || !Array.isArray(nodes)) return null;
  const entryNode = nodes.find((node) => cleanString(node?.id) === entryNodeId);
  return parseTriggerTypeFromNodeType(entryNode?.type);
}

function resolveTriggerTypeForTemplate({ explicitTriggerType, entryNodeId, nodes }) {
  const normalizedExplicit = cleanString(explicitTriggerType);

  if (normalizedExplicit && !isSupportedTriggerType(normalizedExplicit)) {
    return {
      ok: false,
      error: 'invalid_trigger_type',
      message: `trigger_type no soportado: ${normalizedExplicit}`,
      allowed: TRIGGER_TYPES_V2.map((item) => item.value),
    };
  }

  const inferredFromEntry = resolveTriggerTypeFromEntryNode({ entryNodeId, nodes });
  if (!inferredFromEntry) {
    return {
      ok: false,
      error: 'trigger_node_required',
      message: 'El nodo de entrada (entry_node_id) debe ser un nodo activador trigger/* válido',
      allowed: TRIGGER_TYPES_V2.map((item) => `${TRIGGER_NODE_PREFIX}${item.value}`),
    };
  }

  if (normalizedExplicit && inferredFromEntry && normalizedExplicit !== inferredFromEntry) {
    return {
      ok: false,
      error: 'trigger_mismatch',
      message: `El trigger_type (${normalizedExplicit}) no coincide con el nodo activador (${inferredFromEntry})`,
      details: {
        trigger_type: normalizedExplicit,
        entry_node_trigger_type: inferredFromEntry,
      },
    };
  }

  const finalTriggerType = inferredFromEntry;

  return {
    ok: true,
    trigger_type: finalTriggerType,
    inferred_from_entry_node: !normalizedExplicit && !!inferredFromEntry,
  };
}

function collectUnsupportedNodeTypes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return Array.from(
    new Set(
      nodes
        .map((node) => cleanString(node?.type))
        .filter((type) => type && !getNodeTypeMeta(type))
    )
  );
}

function normalizeNodesInput(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((rawNode, index) => {
      if (!isObject(rawNode)) return null;
      const type = cleanString(rawNode.type);
      if (!type) return null;
      const nodeMeta = getNodeTypeMeta(type);
      const defaultConfig = isObject(nodeMeta?.default_config) ? nodeMeta.default_config : {};

      const position = isObject(rawNode.position)
        ? {
            x: Number(rawNode.position.x) || 100,
            y: Number(rawNode.position.y) || (index + 1) * 120,
          }
        : { x: 100, y: (index + 1) * 120 };

      const config = {
        ...defaultConfig,
        ...(isObject(rawNode.config) ? rawNode.config : {}),
      };

      const outputs = isObject(rawNode.outputs) ? { ...rawNode.outputs } : {};
      const expectedKeys = Array.isArray(nodeMeta?.output_keys) ? nodeMeta.output_keys : [];
      expectedKeys.forEach((key) => {
        if (!(key in outputs)) outputs[key] = null;
      });

      return {
        id: cleanString(rawNode.id) || `N${index + 1}`,
        type,
        position,
        config,
        outputs,
        output_schema: isObject(rawNode.output_schema) ? rawNode.output_schema : undefined,
      };
    })
    .filter(Boolean);
}

function sanitizeTemplateKey(raw) {
  const base = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || null;
}

function buildTemplateKey({ templateKey, name }) {
  const explicit = sanitizeTemplateKey(templateKey);
  if (explicit) return explicit;
  const fromName = sanitizeTemplateKey(name);
  if (fromName) return fromName;
  return `flow_${Date.now()}`;
}

function isAdmin(req) {
  const uid = Number(req.userData?.userId);
  return Number.isInteger(uid) && ADMIN_USER_IDS.includes(uid);
}

async function resolveAccess(req) {
  const userId = Number(req.userData?.userId);
  if (!Number.isInteger(userId)) {
    return { user_id: null, is_admin: false, clinic_ids: new Set(), group_ids: new Set() };
  }

  if (isAdmin(req)) {
    return { user_id: userId, is_admin: true, clinic_ids: new Set(), group_ids: new Set() };
  }

  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });

  const managedClinicIds = memberships
    .filter((m) => MANAGER_ROLES.has(String(m.rol_clinica || '').toLowerCase()))
    .map((m) => Number(m.id_clinica))
    .filter((n) => Number.isInteger(n));

  const clinicIds = new Set(managedClinicIds);
  let groupIds = new Set();

  if (managedClinicIds.length) {
    const clinics = await Clinica.findAll({
      where: { id_clinica: { [Op.in]: managedClinicIds } },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    });

    groupIds = new Set(
      clinics
        .map((c) => Number(c.grupoClinicaId))
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }

  return { user_id: userId, is_admin: false, clinic_ids: clinicIds, group_ids: groupIds };
}

function hasScopeAccess(access, { clinic_id, group_id, is_system, created_by }) {
  if (access.is_admin) return true;
  if (is_system) return true;

  const clinicId = parseIntOrNull(clinic_id);
  const groupId = parseIntOrNull(group_id);
  const createdBy = parseIntOrNull(created_by);

  // Plantillas legacy sin scope explícito: el creador conserva acceso.
  if (!clinicId && !groupId && createdBy && access.user_id === createdBy) {
    return true;
  }

  if (clinicId && access.clinic_ids.has(clinicId)) return true;
  if (groupId && access.group_ids.has(groupId)) return true;
  return false;
}

function canCreateDraftFromTemplate(access, { clinic_id, group_id }) {
  if (!access?.user_id) return false;
  if (access.is_admin) return true;

  const clinicId = parseIntOrNull(clinic_id);
  const groupId = parseIntOrNull(group_id);

  // Para no-admin, crear draft exige scope explícito.
  if (!clinicId && !groupId) return false;
  if (clinicId && !access.clinic_ids.has(clinicId)) return false;
  if (groupId && !access.group_ids.has(groupId)) return false;
  return true;
}

function buildTemplatePermissions(access, item) {
  if (!access || !access.user_id) {
    return {
      can_edit: false,
      can_delete: false,
      can_publish: false,
      can_execute: false,
      can_create_draft: false,
    };
  }

  const scopeAllowed = hasScopeAccess(access, item);
  const isDraft = !item?.published_at;
  const isSystem = !!item?.is_system;

  return {
    can_edit: scopeAllowed && isDraft,
    can_delete: scopeAllowed && (!isSystem || access.is_admin),
    can_publish: scopeAllowed && isDraft,
    can_execute: scopeAllowed,
    can_create_draft: !isDraft && canCreateDraftFromTemplate(access, item),
  };
}

async function loadClinicNameMapFromRows(rows) {
  const clinicIds = Array.from(
    new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => Number.parseInt(String(row?.clinic_id), 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  if (!clinicIds.length) return new Map();

  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['id_clinica', 'nombre_clinica'],
    raw: true,
  });

  return new Map(
    clinics.map((clinic) => [
      Number.parseInt(String(clinic.id_clinica), 10),
      clinic.nombre_clinica || null,
    ])
  );
}

async function resolveGroupContextForClinicIds(inputClinicIds) {
  const clinicIds = Array.from(
    new Set(
      (Array.isArray(inputClinicIds) ? inputClinicIds : [])
        .map((id) => Number.parseInt(String(id), 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  if (!clinicIds.length) {
    return { clinic_ids: [], group_ids: [] };
  }

  const selectedClinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });

  const groupIds = Array.from(
    new Set(
      selectedClinics
        .map((clinic) => Number.parseInt(String(clinic.grupoClinicaId), 10))
        .filter((id) => Number.isInteger(id) && id > 0)
    )
  );

  let expandedClinicIds = [...clinicIds];
  if (groupIds.length) {
    const siblingClinics = await Clinica.findAll({
      where: { grupoClinicaId: { [Op.in]: groupIds } },
      attributes: ['id_clinica'],
      raw: true,
    });
    expandedClinicIds = Array.from(
      new Set([
        ...clinicIds,
        ...siblingClinics
          .map((clinic) => Number.parseInt(String(clinic.id_clinica), 10))
          .filter((id) => Number.isInteger(id) && id > 0),
      ])
    );
  }

  return { clinic_ids: expandedClinicIds, group_ids: groupIds };
}

async function resolveClinicIdsForGroup(groupId) {
  const normalizedGroupId = Number.parseInt(String(groupId), 10);
  if (!Number.isInteger(normalizedGroupId) || normalizedGroupId <= 0) {
    return [];
  }

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: normalizedGroupId },
    attributes: ['id_clinica'],
    raw: true,
  });

  return clinics
    .map((clinic) => Number.parseInt(String(clinic.id_clinica), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function assertCreateScopeAllowed(access, { clinic_id, group_id, is_system }) {
  if (access.is_admin) return true;
  if (is_system) return false;

  const clinicId = parseIntOrNull(clinic_id);
  const groupId = parseIntOrNull(group_id);

  if (!clinicId && !groupId) return false;
  if (clinicId && !access.clinic_ids.has(clinicId)) return false;
  if (groupId && !access.group_ids.has(groupId)) return false;
  return true;
}

function mapTemplate(row, { includeNodes = true, access = null, clinicNameMap = null } = {}) {
  const item = row?.toJSON ? row.toJSON() : row;
  const clinicId = Number.parseInt(String(item.clinic_id), 10);
  const clinicName =
    item.clinic_name ??
    (clinicNameMap instanceof Map && Number.isInteger(clinicId)
      ? (clinicNameMap.get(clinicId) || null)
      : null);
  const permissions = buildTemplatePermissions(access, item);

  const base = {
    id: item.id,
    template_key: item.template_key,
    version: item.version,
    engine_version: item.engine_version,
    name: item.name,
    description: item.description ?? null,
    trigger_type: item.trigger_type,
    domain: resolveDomainFromTriggerType(item.trigger_type),
    is_active: item.is_active !== false,
    is_system: !!item.is_system,
    clinic_id: item.clinic_id ?? null,
    clinic_name: clinicName,
    group_id: item.group_id ?? null,
    entry_node_id: item.entry_node_id,
    published_at: item.published_at ?? null,
    published_by: item.published_by ?? null,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
    node_count: Array.isArray(item.nodes) ? item.nodes.length : 0,
    can_edit: permissions.can_edit,
    can_delete: permissions.can_delete,
    can_publish: permissions.can_publish,
    can_execute: permissions.can_execute,
    can_create_draft: permissions.can_create_draft,
  };

  if (includeNodes) {
    base.nodes = Array.isArray(item.nodes) ? item.nodes : [];
  }

  return base;
}

function mapExecution(row, { includeContext = true } = {}) {
  const item = row?.toJSON ? row.toJSON() : row;
  const base = {
    id: item.id,
    idempotency_key: item.idempotency_key,
    template_version_id: item.template_version_id,
    engine_version: item.engine_version,
    status: item.status,
    current_node_id: item.current_node_id ?? null,
    trigger_type: item.trigger_type,
    trigger_entity_type: item.trigger_entity_type ?? null,
    trigger_entity_id: item.trigger_entity_id ?? null,
    clinic_id: item.clinic_id ?? null,
    group_id: item.group_id ?? null,
    wait_until: item.wait_until ?? null,
    waiting_meta: item.waiting_meta ?? null,
    last_error: item.last_error ?? null,
    created_by: item.created_by,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };

  if (includeContext) {
    base.context = item.context ?? {};
  }

  if (item.templateVersion) {
    const t = item.templateVersion;
    base.template = {
      id: t.id,
      template_key: t.template_key,
      version: t.version,
      name: t.name,
      trigger_type: t.trigger_type,
    };
  }

  return base;
}

function mapExecutionLog(row, { includeAudit = true } = {}) {
  const item = row?.toJSON ? row.toJSON() : row;
  const startedAt = item.started_at ? new Date(item.started_at) : null;
  const finishedAt = item.finished_at ? new Date(item.finished_at) : null;
  const durationMs = startedAt && finishedAt ? (finishedAt.getTime() - startedAt.getTime()) : null;

  const base = {
    id: item.id,
    flow_execution_id: item.flow_execution_id,
    node_id: item.node_id,
    node_type: item.node_type ?? null,
    status: item.status,
    started_at: item.started_at,
    finished_at: item.finished_at ?? null,
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
    error_message: item.error_message ?? null,
  };

  if (includeAudit) {
    base.audit_snapshot = item.audit_snapshot ?? null;
  }

  return base;
}

function buildIdempotencyKey({ trigger_type, trigger_entity_id, template_version_id, window_identifier }) {
  const parts = [
    cleanString(trigger_type) || 'manual',
    cleanString(trigger_entity_id) || '0',
    cleanString(template_version_id) || '0',
  ];
  const windowId = cleanString(window_identifier);
  if (windowId) parts.push(windowId);
  return parts.join(':');
}

function buildValidationError(code, message, details = null) {
  return { code, message, details };
}

function validateFlowGraph({ entry_node_id, nodes }) {
  const errors = [];

  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push(buildValidationError('nodes_required', 'El flujo debe tener al menos un nodo'));
    return { ok: false, errors };
  }

  const nodeMap = new Map();
  const indegree = new Map();
  const adjacency = new Map();

  for (const node of nodes) {
    const nodeId = cleanString(node?.id);
    if (!nodeId) {
      errors.push(buildValidationError('node_id_missing', 'Hay nodos sin id'));
      continue;
    }
    if (!/^N[0-9]+$/.test(nodeId)) {
      errors.push(buildValidationError('node_id_invalid', `El nodo ${nodeId} no cumple el patrón ^N[0-9]+$`));
    }
    if (nodeMap.has(nodeId)) {
      errors.push(buildValidationError('node_id_duplicated', `El nodo ${nodeId} está duplicado`));
      continue;
    }
    nodeMap.set(nodeId, node);
    indegree.set(nodeId, 0);
    adjacency.set(nodeId, []);
  }

  const entryNodeId = cleanString(entry_node_id);
  if (!entryNodeId || !nodeMap.has(entryNodeId)) {
    errors.push(buildValidationError('entry_node_invalid', 'entry_node_id no existe en nodes'));
  }

  for (const [nodeId, node] of nodeMap.entries()) {
    const outputs = node?.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
      errors.push(buildValidationError('outputs_invalid', `El nodo ${nodeId} debe definir outputs como objeto`));
      continue;
    }

    for (const [outputKey, target] of Object.entries(outputs)) {
      if (target === null || target === undefined || target === '') continue;
      const targetId = cleanString(target);
      if (!targetId) continue;
      if (!nodeMap.has(targetId)) {
        errors.push(buildValidationError('output_target_missing', `El nodo ${nodeId} apunta a ${targetId} en '${outputKey}', pero no existe`));
        continue;
      }
      adjacency.get(nodeId).push(targetId);
      indegree.set(targetId, (indegree.get(targetId) || 0) + 1);
    }
  }

  for (const [nodeId, degree] of indegree.entries()) {
    if (nodeId !== entryNodeId && degree === 0) {
      errors.push(buildValidationError('node_orphan', `El nodo ${nodeId} no tiene conexiones de entrada`));
    }
  }

  if (entryNodeId && nodeMap.has(entryNodeId)) {
    const visited = new Set();
    const queue = [entryNodeId];
    while (queue.length) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) queue.push(next);
      }
    }

    const unreachable = Array.from(nodeMap.keys()).filter((id) => !visited.has(id));
    if (unreachable.length) {
      errors.push(buildValidationError('unreachable_nodes', 'Existen nodos inalcanzables desde entry_node_id', { nodes: unreachable }));
    }

    // Detección de ciclos (no permitidos en v1.1 inicial)
    const colors = new Map(); // 0 unvisited, 1 visiting, 2 done
    const cyclePath = [];
    let cycleDetected = false;

    function dfs(nodeId) {
      if (cycleDetected) return;
      colors.set(nodeId, 1);
      cyclePath.push(nodeId);

      for (const next of adjacency.get(nodeId) || []) {
        const color = colors.get(next) || 0;
        if (color === 0) {
          dfs(next);
          if (cycleDetected) return;
        } else if (color === 1) {
          cycleDetected = true;
          const start = cyclePath.indexOf(next);
          const cycleNodes = start >= 0 ? cyclePath.slice(start).concat(next) : [next];
          errors.push(buildValidationError('cycle_detected', 'Se detectó un ciclo en el grafo', { cycle: cycleNodes }));
          return;
        }
      }

      cyclePath.pop();
      colors.set(nodeId, 2);
    }

    for (const nodeId of nodeMap.keys()) {
      if ((colors.get(nodeId) || 0) === 0) {
        dfs(nodeId);
      }
      if (cycleDetected) break;
    }
  }

  return { ok: errors.length === 0, errors };
}

function isConfigValueEmpty(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function validateNodeConfig(node, nodeMap) {
  const errors = [];
  const nodeId = cleanString(node?.id) || 'unknown';
  const nodeType = cleanString(node?.type) || 'unknown';
  const config = isObject(node?.config) ? node.config : {};
  const meta = getNodeTypeMeta(nodeType);

  if (!meta) {
    return errors;
  }

  const schema = Array.isArray(meta.config_schema) ? meta.config_schema : [];
  for (const field of schema) {
    if (!field?.required) continue;
    const key = cleanString(field.key);
    if (!key) continue;
    if (isConfigValueEmpty(config[key])) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere '${key}'`,
          { node_id: nodeId, node_type: nodeType, key }
        )
      );
    }
  }

  if (nodeType === 'action/change_status') {
    const targetEntity = cleanString(config.target_entity);
    const newStatus = cleanString(config.new_status);

    if (targetEntity && !CHANGE_STATUS_TARGET_OPTIONS.includes(targetEntity)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere target_entity válido`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'target_entity',
            value: targetEntity,
            allowed: CHANGE_STATUS_TARGET_OPTIONS,
          }
        )
      );
    }

    if (newStatus) {
      if (targetEntity === 'appointment' && !CITA_STATUS_SET.has(newStatus)) {
        errors.push(
          buildValidationError(
            'node_config_invalid',
            `El nodo ${nodeId} requiere new_status de cita válido`,
            {
              node_id: nodeId,
              node_type: nodeType,
              key: 'new_status',
              value: newStatus,
              target_entity: 'appointment',
              allowed: CITA_STATUS_VALUES,
            }
          )
        );
      }
      if (targetEntity === 'lead' && !LEAD_STATUS_SET.has(newStatus)) {
        errors.push(
          buildValidationError(
            'node_config_invalid',
            `El nodo ${nodeId} requiere new_status de lead válido`,
            {
              node_id: nodeId,
              node_type: nodeType,
              key: 'new_status',
              value: newStatus,
              target_entity: 'lead',
              allowed: LEAD_STATUS_VALUES,
            }
          )
        );
      }
      if (!targetEntity && !ANY_CHANGE_STATUS_SET.has(newStatus)) {
        errors.push(
          buildValidationError(
            'node_config_invalid',
            `El nodo ${nodeId} requiere new_status válido`,
            {
              node_id: nodeId,
              node_type: nodeType,
              key: 'new_status',
              value: newStatus,
              allowed: Array.from(ANY_CHANGE_STATUS_SET),
            }
          )
        );
      }
    }
  }

  if (nodeType === 'action/update_lead_info') {
    const mode = cleanString(config.mode) || 'set_required';
    const infoRequerida = parseStringArrayLike(config.info_requerida);
    const infoRecibida = parseStringArrayLike(config.info_recibida_items);
    const statusWhenWaiting = cleanString(config.status_when_waiting);
    const statusWhenComplete = cleanString(config.status_when_complete);

    if (!UPDATE_LEAD_INFO_MODE_OPTIONS.includes(mode)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere mode válido`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'mode',
            value: mode,
            allowed: UPDATE_LEAD_INFO_MODE_OPTIONS,
          }
        )
      );
    }

    if (['set_required'].includes(mode) && infoRequerida.length === 0) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere info_requerida en modo ${mode}`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'info_requerida',
            mode,
          }
        )
      );
    }

    if (['set_received', 'append_received'].includes(mode) && infoRecibida.length === 0) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere info_recibida_items en modo ${mode}`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'info_recibida_items',
            mode,
          }
        )
      );
    }

    if (statusWhenWaiting && !LEAD_STATUS_SET.has(statusWhenWaiting)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere status_when_waiting de lead válido`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'status_when_waiting',
            value: statusWhenWaiting,
            allowed: LEAD_STATUS_VALUES,
          }
        )
      );
    }

    if (statusWhenComplete && !LEAD_STATUS_SET.has(statusWhenComplete)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere status_when_complete de lead válido`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'status_when_complete',
            value: statusWhenComplete,
            allowed: LEAD_STATUS_VALUES,
          }
        )
      );
    }
  }

  if (nodeType === 'action/create_task') {
    const assigneeType = cleanString(config.assignee_type);
    if (!['user', 'role'].includes(assigneeType || '')) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere assignee_type = 'user' o 'role'`,
          { node_id: nodeId, node_type: nodeType, key: 'assignee_type' }
        )
      );
    }
    if (isConfigValueEmpty(config.assignee_id)) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere 'assignee_id'`,
          { node_id: nodeId, node_type: nodeType, key: 'assignee_id' }
        )
      );
    }
    const dueOffset = cleanString(config.due_date_offset);
    if (dueOffset && !DUE_DATE_OFFSET_REGEX.test(dueOffset)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} tiene due_date_offset inválido (ej: '2 hours', '1 day')`,
          { node_id: nodeId, node_type: nodeType, key: 'due_date_offset', value: dueOffset }
        )
      );
    }
  }

  if (nodeType === 'action/send_whatsapp') {
    if (isConfigValueEmpty(config.template_id)) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere 'template_id'`,
          { node_id: nodeId, node_type: nodeType, key: 'template_id' }
        )
      );
    }

    const rawRecipientMode = cleanString(config.recipient_mode) || 'context_patient';
    const recipientMode = rawRecipientMode === 'flow_phone' ? 'context_patient' : rawRecipientMode;
    if (!['context_patient', 'context_lead', 'manual_number'].includes(recipientMode)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere recipient_mode válido`,
          { node_id: nodeId, node_type: nodeType, key: 'recipient_mode', value: recipientMode }
        )
      );
    }

    const recipientTo = cleanString(config.recipient_to) || cleanString(config.to);
    if (recipientMode === 'manual_number' && !recipientTo) {
      errors.push(
        buildValidationError(
          'node_config_required',
          `El nodo ${nodeId} requiere 'recipient_to' cuando recipient_mode = manual_number`,
          { node_id: nodeId, node_type: nodeType, key: 'recipient_to' }
        )
      );
    }

    const senderMode = cleanString(config.sender_mode) || 'clinic_default';
    if (!['clinic_default', 'specific_origin'].includes(senderMode)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere sender_mode válido`,
          { node_id: nodeId, node_type: nodeType, key: 'sender_mode', value: senderMode }
        )
      );
    }

    if (senderMode === 'specific_origin') {
      const senderOriginId = Number(config.sender_origin_id);
      if (!Number.isFinite(senderOriginId) || senderOriginId <= 0) {
        errors.push(
          buildValidationError(
            'node_config_required',
            `El nodo ${nodeId} requiere 'sender_origin_id' cuando sender_mode = specific_origin`,
            { node_id: nodeId, node_type: nodeType, key: 'sender_origin_id' }
          )
        );
      }
    }
  }

  if (nodeType === 'delay/fixed') {
    const duration = Number(config.duration);
    const unit = cleanString(config.unit);
    if (!Number.isFinite(duration) || duration <= 0) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere duration > 0`,
          { node_id: nodeId, node_type: nodeType, key: 'duration' }
        )
      );
    }
    if (!['seconds', 'minutes', 'hours', 'days'].includes(unit || '')) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere unit válida`,
          { node_id: nodeId, node_type: nodeType, key: 'unit' }
        )
      );
    }
  }

  if (nodeType === 'delay/wait_response') {
    const timeoutDuration = Number(config.timeout_duration);
    const timeoutUnit = cleanString(config.timeout_unit);
    const listensTo = cleanString(config.listens_to_node_id);
    if (!Number.isFinite(timeoutDuration) || timeoutDuration <= 0) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere timeout_duration > 0`,
          { node_id: nodeId, node_type: nodeType, key: 'timeout_duration' }
        )
      );
    }
    if (!['minutes', 'hours'].includes(timeoutUnit || '')) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere timeout_unit válida`,
          { node_id: nodeId, node_type: nodeType, key: 'timeout_unit' }
        )
      );
    }
    if (!listensTo || !nodeMap.has(listensTo)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere listens_to_node_id existente`,
          { node_id: nodeId, node_type: nodeType, key: 'listens_to_node_id', value: listensTo || null }
        )
      );
    }
  }

  if (nodeType === 'condition/response_check') {
    const listensTo = cleanString(config.listens_to_node_id);
    if (!listensTo || !nodeMap.has(listensTo)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere listens_to_node_id existente`,
          { node_id: nodeId, node_type: nodeType, key: 'listens_to_node_id', value: listensTo || null }
        )
      );
    }
  }

  if (nodeType === 'condition/ai_analysis') {
    const analysisMode = cleanString(config.analysis_mode) || 'complex_reasoning';
    if (!AI_ANALYSIS_MODE_OPTIONS.includes(analysisMode)) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere analysis_mode válido`,
          {
            node_id: nodeId,
            node_type: nodeType,
            key: 'analysis_mode',
            value: analysisMode,
            allowed: AI_ANALYSIS_MODE_OPTIONS,
          }
        )
      );
    }

    const maxTokens = Number(config.max_tokens);
    if (config.max_tokens !== undefined && config.max_tokens !== null && config.max_tokens !== '') {
      if (!Number.isFinite(maxTokens) || maxTokens <= 0 || maxTokens > 4096) {
        errors.push(
          buildValidationError(
            'node_config_invalid',
            `El nodo ${nodeId} requiere max_tokens entre 1 y 4096`,
            { node_id: nodeId, node_type: nodeType, key: 'max_tokens', value: config.max_tokens }
          )
        );
      }
    }

    let outputFormat = config.output_format;
    if (typeof outputFormat === 'string') {
      try {
        outputFormat = JSON.parse(outputFormat);
      } catch (_err) {
        outputFormat = null;
      }
    }

    const validTypes = new Set(['string', 'number', 'boolean']);
    const outputEntries = outputFormat && typeof outputFormat === 'object' && !Array.isArray(outputFormat)
      ? Object.entries(outputFormat)
      : [];

    if (!outputEntries.length) {
      errors.push(
        buildValidationError(
          'node_config_invalid',
          `El nodo ${nodeId} requiere output_format con al menos un campo`,
          { node_id: nodeId, node_type: nodeType, key: 'output_format' }
        )
      );
    } else {
      for (const [field, rawDef] of outputEntries) {
        const key = cleanString(field);
        const type = cleanString(rawDef?.type);
        if (!key || !type || !validTypes.has(type)) {
          errors.push(
            buildValidationError(
              'node_config_invalid',
              `El nodo ${nodeId} tiene output_format inválido en '${field}'`,
              {
                node_id: nodeId,
                node_type: nodeType,
                key: 'output_format',
                field,
                value: rawDef,
                allowed_types: Array.from(validTypes),
              }
            )
          );
        }
      }
    }
  }

  return errors;
}

function validateNodeConfigs(nodes) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const nodeMap = new Map(
    safeNodes
      .map((node) => [cleanString(node?.id), node])
      .filter(([nodeId]) => !!nodeId)
  );

  const errors = [];
  for (const node of safeNodes) {
    errors.push(...validateNodeConfig(node, nodeMap));
  }
  return { ok: errors.length === 0, errors };
}

exports.getFlowMeta = async (_req, res) => {
  return res.json({
    success: true,
    data: {
      triggers: TRIGGER_TYPES_V2,
      node_types: NODE_TYPES_V2,
    },
  });
};

exports.getNodeTypesCatalog = async (_req, res) => {
  return res.json({
    success: true,
    data: NODE_TYPES_V2,
  });
};

exports.searchEntities = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.user_id) {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }

    const type = cleanString(req.query?.type)?.toLowerCase();
    const allowedTypes = new Set(['appointment', 'patient', 'lead', 'conversation']);
    if (!type || !allowedTypes.has(type)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_type',
        message: "type debe ser 'appointment', 'patient', 'lead' o 'conversation'",
      });
    }

    const queryText = cleanString(req.query?.query) || '';
    const queryLike = `%${queryText}%`;
    const limit = parseLimit(req.query?.limit, 10);
    const presetRaw = cleanString(req.query?.preset)?.toLowerCase() || 'none';
    const preset = ['upcoming', 'recent', 'none'].includes(presetRaw) ? presetRaw : 'none';

    const requestedClinicIds = parseIntList(req.query?.clinic_id);
    const requestedGroupId = parseIntOrNull(req.query?.group_id);
    let clinicIds = [];

    if (requestedGroupId) {
      if (!access.is_admin && !access.group_ids.has(requestedGroupId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      clinicIds = await resolveClinicIdsForGroup(requestedGroupId);
    } else if (requestedClinicIds.length) {
      if (!access.is_admin) {
        const hasForbidden = requestedClinicIds.some((clinicId) => !access.clinic_ids.has(clinicId));
        if (hasForbidden) {
          return res.status(403).json({ success: false, error: 'forbidden_scope' });
        }
      }
      clinicIds = requestedClinicIds;
    } else if (!access.is_admin) {
      clinicIds = Array.from(access.clinic_ids);
      if (!clinicIds.length && access.group_ids.size) {
        const groupClinicIds = await Promise.all(
          Array.from(access.group_ids).map((groupId) => resolveClinicIdsForGroup(groupId))
        );
        clinicIds = groupClinicIds.flat();
      }
    }

    clinicIds = Array.from(
      new Set(
        clinicIds
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );

    if (!access.is_admin && !clinicIds.length) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    let items = [];

    if (type === 'appointment') {
      const where = {};
      if (clinicIds.length) {
        where.clinica_id = { [Op.in]: clinicIds };
      }
      if (preset === 'upcoming') {
        where.inicio = { [Op.gte]: new Date() };
      } else if (preset === 'recent') {
        where.inicio = { [Op.lte]: new Date() };
      }

      const patientWhere = queryText
        ? {
            [Op.or]: [
              { nombre: { [Op.like]: queryLike } },
              { apellidos: { [Op.like]: queryLike } },
              { email: { [Op.like]: queryLike } },
              { telefono_movil: { [Op.like]: queryLike } },
            ],
          }
        : undefined;

      const rows = await CitaPaciente.findAll({
        where,
        include: [
          {
            model: Paciente,
            as: 'paciente',
            required: !!patientWhere,
            ...(patientWhere ? { where: patientWhere } : {}),
            attributes: ['id_paciente', 'nombre', 'apellidos', 'email', 'telefono_movil'],
          },
          {
            model: Clinica,
            as: 'clinica',
            required: false,
            attributes: ['id_clinica', 'nombre_clinica'],
          },
        ],
        order: [['inicio', preset === 'upcoming' ? 'ASC' : 'DESC']],
        limit,
      });

      items = rows.map((row) => {
        const paciente = row.paciente || null;
        const clinic = row.clinica || null;
        const patientName = [paciente?.nombre, paciente?.apellidos].filter(Boolean).join(' ').trim() || `Paciente #${row.paciente_id}`;
        const clinicName = clinic?.nombre_clinica || `Clínica ${row.clinica_id}`;
        const dateLabel = formatDateTimeEs(row.inicio) || '-';
        const isTest = looksLikeTestEntity(
          patientName,
          paciente?.email,
          paciente?.telefono_movil,
          row.titulo,
          row.motivo
        );
        return {
          id: row.id_cita,
          label: `Cita · ${patientName}`,
          subtitle: `${dateLabel} · ${clinicName}`,
          search_tokens: [patientName, paciente?.email, paciente?.telefono_movil].filter(Boolean),
          is_test: isTest,
          context: {
            clinic_id: row.clinica_id,
            estado: row.estado,
            inicio: row.inicio,
            paciente_id: row.paciente_id,
            is_test: isTest,
          },
        };
      });
    } else if (type === 'patient') {
      const where = {};
      if (clinicIds.length) {
        where.clinica_id = { [Op.in]: clinicIds };
      }
      if (queryText) {
        where[Op.or] = [
          { nombre: { [Op.like]: queryLike } },
          { apellidos: { [Op.like]: queryLike } },
          { email: { [Op.like]: queryLike } },
          { telefono_movil: { [Op.like]: queryLike } },
        ];
      }

      const rows = await Paciente.findAll({
        where,
        attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'email', 'telefono_movil', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        limit,
      });

      items = rows.map((row) => {
        const fullName = [row.nombre, row.apellidos].filter(Boolean).join(' ').trim() || `Paciente #${row.id_paciente}`;
        const isTest = looksLikeTestEntity(fullName, row.email, row.telefono_movil);
        return {
          id: row.id_paciente,
          label: fullName,
          subtitle: [row.email, row.telefono_movil].filter(Boolean).join(' · ') || `Clínica ${row.clinica_id}`,
          search_tokens: [fullName, row.email, row.telefono_movil].filter(Boolean),
          is_test: isTest,
          context: {
            clinic_id: row.clinica_id,
            is_test: isTest,
          },
        };
      });
    } else if (type === 'lead') {
      const where = {};
      if (clinicIds.length) {
        where.clinica_id = { [Op.in]: clinicIds };
      }
      if (queryText) {
        where[Op.or] = [
          { nombre: { [Op.like]: queryLike } },
          { email: { [Op.like]: queryLike } },
          { telefono: { [Op.like]: queryLike } },
          { status_lead: { [Op.like]: queryLike } },
        ];
      }

      const rows = await LeadIntake.findAll({
        where,
        attributes: ['id', 'clinica_id', 'nombre', 'email', 'telefono', 'status_lead', 'created_at'],
        order: [['created_at', 'DESC']],
        limit,
      });

      items = rows.map((row) => {
        const leadName = cleanString(row.nombre) || `Lead #${row.id}`;
        const isTest = looksLikeTestEntity(leadName, row.email, row.telefono);
        return {
          id: row.id,
          label: `Lead · ${leadName}`,
          subtitle: [row.status_lead, row.telefono || row.email].filter(Boolean).join(' · ') || null,
          search_tokens: [leadName, row.email, row.telefono, row.status_lead].filter(Boolean),
          is_test: isTest,
          context: {
            clinic_id: row.clinica_id,
            status_lead: row.status_lead,
            is_test: isTest,
          },
        };
      });
    } else {
      items = [];
    }

    return res.json({
      success: true,
      type,
      data: {
        items,
        total: items.length,
      },
      meta: {
        query: queryText,
        limit,
        preset,
        source: 'db',
      },
    });
  } catch (err) {
    console.error('Error searchEntities v2', err);
    return res.status(500).json({
      success: false,
      error: 'search_entities_failed',
      message: err.message,
    });
  }
};

exports.getAssigneesCatalog = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.user_id) {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }

    const limit = Math.max(50, Math.min(500, parseIntOrNull(req.query?.limit) || 300));

    const parsedScope = parseTemplateScopeQuery(req.query);
    let clinicIds = [];

    if (parsedScope.group_id) {
      if (!access.is_admin && !access.group_ids.has(parsedScope.group_id)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      clinicIds = await resolveClinicIdsForGroup(parsedScope.group_id);
    } else if (parsedScope.clinic_ids.length) {
      if (!access.is_admin) {
        const hasForbidden = parsedScope.clinic_ids.some((clinicId) => !access.clinic_ids.has(clinicId));
        if (hasForbidden) {
          return res.status(403).json({ success: false, error: 'forbidden_scope' });
        }
      }
      clinicIds = parsedScope.clinic_ids;
    } else if (!access.is_admin) {
      clinicIds = Array.from(access.clinic_ids);
    }

    clinicIds = Array.from(
      new Set(
        clinicIds
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );

    if (!clinicIds.length) {
      return res.json({
        success: true,
        data: {
          clinic_ids: [],
          roles: TASK_ASSIGNEE_ROLE_OPTIONS,
          subroles: [],
          users: [],
        },
      });
    }

    const memberships = await UsuarioClinica.findAll({
      where: {
        id_clinica: { [Op.in]: clinicIds },
        rol_clinica: {
          [Op.notIn]: ['paciente'],
        },
      },
      attributes: ['id_usuario', 'id_clinica', 'rol_clinica', 'subrol_clinica'],
      raw: true,
    });

    const userIds = Array.from(
      new Set(
        memberships
          .map((row) => Number.parseInt(String(row.id_usuario), 10))
          .filter((id) => Number.isInteger(id) && id > 0)
      )
    );

    const users = userIds.length
      ? await Usuario.findAll({
          where: { id_usuario: { [Op.in]: userIds } },
          attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
          raw: true,
        })
      : [];

    const userById = new Map(
      users.map((row) => [
        Number.parseInt(String(row.id_usuario), 10),
        row,
      ])
    );

    const userMetaMap = new Map();
    for (const membership of memberships) {
      const userId = Number.parseInt(String(membership.id_usuario), 10);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      if (!userMetaMap.has(userId)) {
        userMetaMap.set(userId, { clinic_ids: new Set(), roles: new Set() });
      }
      const meta = userMetaMap.get(userId);
      const clinicId = Number.parseInt(String(membership.id_clinica), 10);
      if (Number.isInteger(clinicId) && clinicId > 0) {
        meta.clinic_ids.add(clinicId);
      }
      const role = String(membership.rol_clinica || '').toLowerCase();
      if (role) meta.roles.add(role);
    }

    const allUserOptions = Array.from(userMetaMap.entries())
      .map(([userId, meta]) => {
        const user = userById.get(userId);
        const firstName = String(user?.nombre || '').trim();
        const lastName = String(user?.apellidos || '').trim();
        const fullName = `${firstName} ${lastName}`.trim();
        const email = String(user?.email_usuario || '').trim() || null;
        const labelBase = fullName || email || `Usuario ${userId}`;
        return {
          id: userId,
          label: email ? `${labelBase} (${email})` : labelBase,
          name: fullName || null,
          email,
          clinic_ids: Array.from(meta.clinic_ids).sort((a, b) => a - b),
          roles: Array.from(meta.roles),
        };
      })
      .sort((a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'es'));
    const userOptions = allUserOptions.slice(0, limit);
    const roleCodes = Array.from(
      new Set(
        memberships
          .map((row) => String(row.rol_clinica || '').trim().toLowerCase())
          .filter(Boolean)
      )
    );
    const rolePriority = ['propietario', 'administrador', 'admin', 'personaldeclinica'];
    roleCodes.sort((a, b) => {
      const ia = rolePriority.indexOf(a);
      const ib = rolePriority.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b, 'es');
    });

    const roleOptions = roleCodes.length
      ? roleCodes.map((code) => ({
          id: code,
          code,
          label: TASK_ROLE_LABELS[code] || code,
        }))
      : TASK_ASSIGNEE_ROLE_OPTIONS;

    const subroleCodes = Array.from(
      new Set(
        memberships
          .map((row) => String(row.subrol_clinica || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, 'es'));
    const subroleOptions = subroleCodes.map((code) => ({ code, label: code }));

    return res.json({
      success: true,
      data: {
        clinic_ids: clinicIds,
        roles: roleOptions,
        subroles: subroleOptions,
        users: userOptions,
        users_truncated: allUserOptions.length > userOptions.length,
      },
    });
  } catch (err) {
    console.error('Error getAssigneesCatalog v2', err);
    return res.status(500).json({ success: false, error: 'assignees_failed', message: err.message });
  }
};

exports.validateTemplateGraph = async (req, res) => {
  try {
    const body = req.body || {};
    const entryNodeId = cleanString(body.entry_node_id);
    const nodes = normalizeNodesInput(body.nodes);
    const graphValidation = validateFlowGraph({
      entry_node_id: entryNodeId,
      nodes,
    });
    const nodeConfigValidation = validateNodeConfigs(nodes);
    const triggerResolution = resolveTriggerTypeForTemplate({
      explicitTriggerType: undefined,
      entryNodeId,
      nodes,
    });
    if (!triggerResolution.ok) {
      return res.status(400).json({
        success: false,
        error: triggerResolution.error,
        message: triggerResolution.message,
        allowed: triggerResolution.allowed,
        details: triggerResolution.details,
      });
    }
    const validationErrors = [
      ...(graphValidation.errors || []),
      ...(nodeConfigValidation.errors || []),
    ];

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'validation_failed',
        validation_errors: validationErrors,
      });
    }
    return res.json({
      success: true,
      data: { ok: true },
    });
  } catch (err) {
    console.error('Error validateTemplateGraph v2', err);
    return res.status(500).json({
      success: false,
      error: 'validate_failed',
      message: err.message,
    });
  }
};

exports.listTemplates = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.is_admin && access.clinic_ids.size === 0 && access.group_ids.size === 0) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const limit = parseLimit(req.query?.limit, 20);
    const offset = parseOffset(req.query?.offset);
    const includeNodes = parseBool(req.query?.include_nodes, false);

    const where = {};

    const triggerType = cleanString(req.query?.trigger_type);
    if (triggerType) where.trigger_type = triggerType;
    const domainRaw = cleanString(req.query?.domain);
    if (domainRaw) {
      const domain = normalizeDomain(domainRaw);
      if (!domain) {
        return res.status(400).json({
          success: false,
          error: 'invalid_domain',
          allowed: ['appointment', 'marketing'],
        });
      }
      if (triggerType) {
        if (resolveDomainFromTriggerType(triggerType) !== domain) {
          return res.json({
            success: true,
            data: [],
            pagination: { total: 0, limit, offset },
          });
        }
      } else if (domain === 'appointment') {
        where.trigger_type = { [Op.in]: Array.from(APPOINTMENT_TRIGGER_TYPES) };
      } else if (domain === 'marketing') {
        where.trigger_type = { [Op.notIn]: Array.from(APPOINTMENT_TRIGGER_TYPES) };
      }
    }

    const engineVersion = cleanString(req.query?.engine_version);
    if (engineVersion) where.engine_version = engineVersion;

    const isSystem = parseBool(req.query?.is_system, undefined);
    if (isSystem !== undefined) where.is_system = isSystem;

    const isActive = parseBool(req.query?.is_active, undefined);
    if (isActive !== undefined) where.is_active = isActive;

    const search = cleanString(req.query?.search);
    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { template_key: { [Op.like]: `%${search}%` } },
      ];
    }

    const parsedScope = parseTemplateScopeQuery(req.query);
    const clinicIds = parsedScope.clinic_ids;
    const groupId = parsedScope.group_id;

    if (clinicIds.length) {
      if (!access.is_admin) {
        const hasForbidden = clinicIds.some((clinicId) => !access.clinic_ids.has(clinicId));
        if (hasForbidden) {
          return res.status(403).json({ success: false, error: 'forbidden_scope' });
        }
      }

      const expandedScope = await resolveGroupContextForClinicIds(clinicIds);
      const expandedClinicIds = expandedScope.clinic_ids;
      const relatedGroupIds = expandedScope.group_ids;

      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({
        [Op.or]: [
          {
            clinic_id:
              expandedClinicIds.length === 1
                ? expandedClinicIds[0]
                : { [Op.in]: expandedClinicIds },
          },
          ...(relatedGroupIds.length
            ? [{ group_id: relatedGroupIds.length === 1 ? relatedGroupIds[0] : { [Op.in]: relatedGroupIds } }]
            : []),
          { is_system: true },
          {
            [Op.and]: [
              { clinic_id: null },
              { group_id: null },
              { created_by: access.user_id },
            ],
          },
        ],
      });
    }

    if (groupId) {
      if (!access.is_admin && !access.group_ids.has(groupId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }

      const clinicIdsInGroup = await resolveClinicIdsForGroup(groupId);

      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({
        [Op.or]: [
          { group_id: groupId },
          ...(clinicIdsInGroup.length ? [{ clinic_id: { [Op.in]: clinicIdsInGroup } }] : []),
          { is_system: true },
          {
            [Op.and]: [
              { clinic_id: null },
              { group_id: null },
              { created_by: access.user_id },
            ],
          },
        ],
      });
    }

    if (!access.is_admin && !clinicIds.length && !groupId) {
      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({
        [Op.or]: [
          { is_system: true },
          { clinic_id: { [Op.in]: Array.from(access.clinic_ids) } },
          ...(access.group_ids.size ? [{ group_id: { [Op.in]: Array.from(access.group_ids) } }] : []),
        ],
      });
    }

    const { count, rows } = await AutomationFlowTemplateV2.findAndCountAll({
      where,
      limit,
      offset,
      order: [['template_key', 'ASC'], ['version', 'DESC']],
    });

    const clinicNameMap = await loadClinicNameMapFromRows(rows);

    return res.json({
      success: true,
      data: rows.map((row) =>
        mapTemplate(row, { includeNodes, access, clinicNameMap })
      ),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listTemplates v2', err);
    return res.status(500).json({ success: false, error: 'list_failed', message: err.message });
  }
};

exports.createTemplateDraft = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.user_id) {
      return res.status(401).json({ success: false, error: 'auth_required' });
    }

    const body = req.body || {};
    const name = cleanString(body.name);
    const triggerType = cleanString(body.trigger_type);
    const entryNodeId = cleanString(body.entry_node_id);
    const nodes = Array.isArray(body.nodes) ? normalizeNodesInput(body.nodes) : null;

    if (!name || !entryNodeId || !nodes) {
      return res.status(400).json({
        success: false,
        error: 'invalid_payload',
        message: 'name, entry_node_id y nodes son obligatorios',
      });
    }
    if (!nodes.length) {
      return res.status(400).json({
        success: false,
        error: 'invalid_nodes',
        message: 'El flujo debe tener al menos un nodo válido',
      });
    }
    const unsupportedNodeTypes = collectUnsupportedNodeTypes(nodes);
    if (unsupportedNodeTypes.length) {
      return res.status(400).json({
        success: false,
        error: 'invalid_node_types',
        message: 'Hay tipos de nodo no soportados',
        unsupported: unsupportedNodeTypes,
      });
    }
    if (!nodes.some((node) => node.id === entryNodeId)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_entry_node',
        message: 'entry_node_id debe existir en nodes',
      });
    }

    const triggerResolution = resolveTriggerTypeForTemplate({
      explicitTriggerType: triggerType,
      entryNodeId,
      nodes,
    });
    if (!triggerResolution.ok) {
      return res.status(400).json({
        success: false,
        error: triggerResolution.error,
        message: triggerResolution.message,
        allowed: triggerResolution.allowed,
        details: triggerResolution.details,
      });
    }
    const resolvedTriggerType = triggerResolution.trigger_type;

    const templateKey = buildTemplateKey({ templateKey: body.template_key, name });
    let clinicId = parseIntOrNull(body.clinic_id);
    let groupId = parseIntOrNull(body.group_id);
    const isSystem = access.is_admin ? parseBool(body.is_system, false) : false;

    // Si se crea en scope clínica y no viene group_id, inferir el grupo de la clínica.
    if (clinicId && !groupId) {
      const clinic = await Clinica.findOne({
        where: { id_clinica: clinicId },
        attributes: ['grupoClinicaId'],
        raw: true,
      });
      const inferredGroupId = parseIntOrNull(clinic?.grupoClinicaId);
      if (inferredGroupId) {
        groupId = inferredGroupId;
      }
    }

    if (!assertCreateScopeAllowed(access, { clinic_id: clinicId, group_id: groupId, is_system: isSystem })) {
      return res.status(403).json({ success: false, error: 'forbidden_scope' });
    }

    const existingDraft = await AutomationFlowTemplateV2.findOne({
      where: {
        template_key: templateKey,
        published_at: null,
      },
      order: [['version', 'DESC']],
    });

    if (existingDraft) {
      return res.status(409).json({
        success: false,
        error: 'draft_already_exists',
        message: `Ya existe un borrador para template_key '${templateKey}' (versión ${existingDraft.version})`,
      });
    }

    const latest = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey },
      attributes: ['version'],
      order: [['version', 'DESC']],
      raw: true,
    });

    const version = latest?.version ? Number(latest.version) + 1 : 1;

    const created = await AutomationFlowTemplateV2.create({
      template_key: templateKey,
      version,
      engine_version: cleanString(body.engine_version) || 'v2',
      name,
      description: cleanString(body.description),
      trigger_type: resolvedTriggerType,
      is_active: parseBool(body.is_active, true),
      is_system: !!isSystem,
      clinic_id: clinicId,
      group_id: groupId,
      entry_node_id: entryNodeId,
      nodes,
      published_at: null,
      published_by: null,
      created_by: access.user_id,
    });

    const clinicNameMap = await loadClinicNameMapFromRows([created]);
    return res.status(201).json({
      success: true,
      data: mapTemplate(created, { includeNodes: true, access, clinicNameMap }),
    });
  } catch (err) {
    console.error('Error createTemplateDraft v2', err);
    return res.status(500).json({ success: false, error: 'create_failed', message: err.message });
  }
};

exports.getTemplateLatestPublished = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);

    if (!templateKey) {
      return res.status(400).json({ success: false, error: 'invalid_template_key' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: {
        template_key: templateKey,
        published_at: { [Op.ne]: null },
        is_active: true,
      },
      order: [['version', 'DESC']],
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_not_found' });
    }

    const clinicNameMap = await loadClinicNameMapFromRows([row]);
    return res.json({
      success: true,
      data: mapTemplate(row, { includeNodes: true, access, clinicNameMap }),
    });
  } catch (err) {
    console.error('Error getTemplateLatestPublished v2', err);
    return res.status(500).json({ success: false, error: 'get_failed', message: err.message });
  }
};

exports.listTemplateVersions = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    if (!templateKey) {
      return res.status(400).json({ success: false, error: 'invalid_template_key' });
    }

    const limit = parseLimit(req.query?.limit, 20);
    const offset = parseOffset(req.query?.offset);
    const includeNodes = parseBool(req.query?.include_nodes, false);

    const { count, rows } = await AutomationFlowTemplateV2.findAndCountAll({
      where: { template_key: templateKey },
      limit,
      offset,
      order: [['version', 'DESC']],
    });

    const visible = rows.filter((row) => hasScopeAccess(access, row));

    const clinicNameMap = await loadClinicNameMapFromRows(visible);

    return res.json({
      success: true,
      data: visible.map((row) =>
        mapTemplate(row, { includeNodes, access, clinicNameMap })
      ),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listTemplateVersions v2', err);
    return res.status(500).json({ success: false, error: 'list_versions_failed', message: err.message });
  }
};

exports.getTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    const clinicNameMap = await loadClinicNameMapFromRows([row]);
    return res.json({
      success: true,
      data: mapTemplate(row, { includeNodes: true, access, clinicNameMap }),
    });
  } catch (err) {
    console.error('Error getTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'get_version_failed', message: err.message });
  }
};

exports.updateTemplateDraft = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    const body = req.body || {};
    const bodyKeys = Object.keys(body || {});

    if (row.published_at) {
      const allowsOnlyActiveToggle =
        bodyKeys.length > 0 &&
        bodyKeys.every((key) => key === 'is_active');

      if (!allowsOnlyActiveToggle) {
        return res.status(409).json({
          success: false,
          error: 'published_immutable',
          message: 'No se puede editar una versión publicada. Crea un nuevo draft.',
        });
      }

      await row.update({
        is_active: parseBool(body.is_active, row.is_active),
      });

      const clinicNameMap = await loadClinicNameMapFromRows([row]);
      return res.json({
        success: true,
        data: mapTemplate(row, { includeNodes: true, access, clinicNameMap }),
      });
    }

    const updates = {};
    let explicitTriggerType = undefined;

    if (body.name !== undefined) {
      const name = cleanString(body.name);
      if (!name) return res.status(400).json({ success: false, error: 'invalid_name' });
      updates.name = name;
    }
    if (body.description !== undefined) updates.description = cleanString(body.description);
    if (body.trigger_type !== undefined) {
      const triggerType = cleanString(body.trigger_type);
      if (!triggerType) return res.status(400).json({ success: false, error: 'invalid_trigger_type' });
      explicitTriggerType = triggerType;
    }
    if (body.entry_node_id !== undefined) {
      const entry = cleanString(body.entry_node_id);
      if (!entry) return res.status(400).json({ success: false, error: 'invalid_entry_node' });
      updates.entry_node_id = entry;
    }
    if (body.nodes !== undefined) {
      if (!Array.isArray(body.nodes)) return res.status(400).json({ success: false, error: 'invalid_nodes' });
      const normalizedNodes = normalizeNodesInput(body.nodes);
      if (!normalizedNodes.length) {
        return res.status(400).json({
          success: false,
          error: 'invalid_nodes',
          message: 'El flujo debe tener al menos un nodo válido',
        });
      }
      const unsupportedNodeTypes = collectUnsupportedNodeTypes(normalizedNodes);
      if (unsupportedNodeTypes.length) {
        return res.status(400).json({
          success: false,
          error: 'invalid_node_types',
          message: 'Hay tipos de nodo no soportados',
          unsupported: unsupportedNodeTypes,
        });
      }
      updates.nodes = normalizedNodes;
    }
    if (body.is_active !== undefined) updates.is_active = parseBool(body.is_active, row.is_active);
    if (access.is_admin && body.is_system !== undefined) updates.is_system = parseBool(body.is_system, row.is_system);

    const candidateNodes = Array.isArray(updates.nodes) ? updates.nodes : (Array.isArray(row.nodes) ? row.nodes : []);
    const candidateEntry = updates.entry_node_id || row.entry_node_id;
    if (!candidateEntry || !candidateNodes.some((node) => node.id === candidateEntry)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_entry_node',
        message: 'entry_node_id debe existir en nodes',
      });
    }

    const triggerResolution = resolveTriggerTypeForTemplate({
      explicitTriggerType,
      entryNodeId: candidateEntry,
      nodes: candidateNodes,
    });
    if (!triggerResolution.ok) {
      return res.status(400).json({
        success: false,
        error: triggerResolution.error,
        message: triggerResolution.message,
        allowed: triggerResolution.allowed,
        details: triggerResolution.details,
      });
    }
    updates.trigger_type = triggerResolution.trigger_type;

    await row.update(updates);

    const clinicNameMap = await loadClinicNameMapFromRows([row]);
    return res.json({
      success: true,
      data: mapTemplate(row, { includeNodes: true, access, clinicNameMap }),
    });
  } catch (err) {
    console.error('Error updateTemplateDraft v2', err);
    return res.status(500).json({ success: false, error: 'update_failed', message: err.message });
  }
};

exports.publishTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    if (row.published_at) {
      return res.status(409).json({ success: false, error: 'already_published' });
    }

    const normalizedNodes = normalizeNodesInput(Array.isArray(row.nodes) ? row.nodes : []);
    const graphValidation = validateFlowGraph({
      entry_node_id: row.entry_node_id,
      nodes: normalizedNodes,
    });
    const nodeConfigValidation = validateNodeConfigs(normalizedNodes);
    const triggerResolution = resolveTriggerTypeForTemplate({
      explicitTriggerType: row.trigger_type,
      entryNodeId: row.entry_node_id,
      nodes: normalizedNodes,
    });
    if (!triggerResolution.ok) {
      return res.status(400).json({
        success: false,
        error: triggerResolution.error,
        message: triggerResolution.message,
        allowed: triggerResolution.allowed,
        details: triggerResolution.details,
      });
    }
    const validationErrors = [
      ...(graphValidation.errors || []),
      ...(nodeConfigValidation.errors || []),
    ];

    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'validation_failed',
        validation_errors: validationErrors,
      });
    }

    await row.update({
      published_at: new Date(),
      published_by: access.user_id,
    });

    const clinicNameMap = await loadClinicNameMapFromRows([row]);
    return res.json({
      success: true,
      data: mapTemplate(row, { includeNodes: true, access, clinicNameMap }),
    });
  } catch (err) {
    console.error('Error publishTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'publish_failed', message: err.message });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    if (!templateKey) {
      return res.status(400).json({ success: false, error: 'invalid_template_key' });
    }

    const rows = await AutomationFlowTemplateV2.findAll({
      where: { template_key: templateKey },
      order: [['version', 'DESC']],
    });

    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'template_not_found' });
    }

    const parsedScope = parseTemplateScopeQuery(req.query);
    const scopeClinicIds = parsedScope.clinic_ids;
    const scopeGroupId = parsedScope.group_id;

    if (scopeClinicIds.length) {
      const expandedScope = await resolveGroupContextForClinicIds(scopeClinicIds);
      const expandedClinicIds = expandedScope.clinic_ids;
      const relatedGroupIds = expandedScope.group_ids;

      const matchesClinicScope = rows.some((row) => {
        const rowClinicId = parseIntOrNull(row.clinic_id);
        const rowGroupId = parseIntOrNull(row.group_id);
        const isLegacyOwner =
          !rowClinicId &&
          !rowGroupId &&
          parseIntOrNull(row.created_by) === access.user_id;

        return (
          (rowClinicId && expandedClinicIds.includes(rowClinicId)) ||
          (rowGroupId && relatedGroupIds.includes(rowGroupId)) ||
          row.is_system === true ||
          isLegacyOwner
        );
      });
      if (!matchesClinicScope) {
        return res.status(404).json({ success: false, error: 'template_not_found' });
      }
    }

    if (scopeGroupId) {
      const clinicIdsInGroup = await resolveClinicIdsForGroup(scopeGroupId);
      const matchesGroupScope = rows.some((row) => {
        const rowClinicId = parseIntOrNull(row.clinic_id);
        const rowGroupId = parseIntOrNull(row.group_id);
        const isLegacyOwner =
          !rowClinicId &&
          !rowGroupId &&
          parseIntOrNull(row.created_by) === access.user_id;

        return (
          rowGroupId === scopeGroupId ||
          (rowClinicId && clinicIdsInGroup.includes(rowClinicId)) ||
          row.is_system === true ||
          isLegacyOwner
        );
      });
      if (!matchesGroupScope) {
        return res.status(404).json({ success: false, error: 'template_not_found' });
      }
    }

    const hasForbiddenScope = rows.some((row) => !hasScopeAccess(access, row));
    if (hasForbiddenScope) {
      return res.status(403).json({ success: false, error: 'forbidden_scope' });
    }

    const isSystemTemplate = rows.some((row) => !!row.is_system);
    if (isSystemTemplate && !access.is_admin) {
      return res.status(405).json({
        success: false,
        error: 'delete_disabled_system',
        message: 'Las plantillas de sistema solo pueden borrarse por admins',
      });
    }

    if (isSystemTemplate && access.is_admin) {
      const confirmSystemDelete = parseBool(req.query?.confirm_system_delete, false);
      if (!confirmSystemDelete) {
        return res.status(409).json({
          success: false,
          error: 'confirm_system_delete_required',
          message: 'Confirma el borrado de plantilla de sistema',
        });
      }
    }

    const versionIds = rows.map((row) => row.id);
    const activeStatuses = ['running', 'waiting', 'paused'];
    const activeExecutions = await FlowExecutionV2.findAll({
      where: {
        template_version_id: { [Op.in]: versionIds },
        status: { [Op.in]: activeStatuses },
      },
      attributes: ['id', 'clinic_id', 'group_id', 'status'],
      raw: true,
      limit: 200,
    });

    if (activeExecutions.length > 0) {
      const clinicIds = Array.from(
        new Set(
          activeExecutions
            .map((execution) => parseIntOrNull(execution.clinic_id))
            .filter((value) => Number.isInteger(value))
        )
      );
      const groupIds = Array.from(
        new Set(
          activeExecutions
            .map((execution) => parseIntOrNull(execution.group_id))
            .filter((value) => Number.isInteger(value))
        )
      );
      const statuses = Array.from(new Set(activeExecutions.map((execution) => execution.status).filter(Boolean)));

      return res.status(409).json({
        success: false,
        error: 'template_in_use',
        message: 'No se puede borrar: hay ejecuciones activas',
        details: {
          active_executions: activeExecutions.length,
          clinic_ids: clinicIds,
          group_ids: groupIds,
          statuses,
        },
      });
    }

    await AutomationFlowTemplateV2.destroy({ where: { template_key: templateKey } });
    return res.json({
      success: true,
      data: {
        template_key: templateKey,
        deleted_versions: versionIds.length,
      },
    });
  } catch (err) {
    console.error('Error deleteTemplate v2', err);
    return res.status(500).json({ success: false, error: 'delete_failed', message: err.message });
  }
};

exports.executeTemplateVersion = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const templateKey = sanitizeTemplateKey(req.params?.template_key);
    const version = parseIntOrNull(req.params?.version);

    if (!templateKey || !version) {
      return res.status(400).json({ success: false, error: 'invalid_params' });
    }

    const row = await AutomationFlowTemplateV2.findOne({
      where: { template_key: templateKey, version },
    });

    if (!row || !hasScopeAccess(access, row)) {
      return res.status(404).json({ success: false, error: 'template_version_not_found' });
    }

    const body = req.body || {};
    const isSimulation = parseBool(body.simulation, false);
    const allowDraftExecution = parseBool(body.allow_draft_execution, false);

    if (!row.published_at && !allowDraftExecution) {
      return res.status(409).json({
        success: false,
        error: 'draft_not_executable',
        message: 'No se puede ejecutar una versión draft sin permiso explícito.',
      });
    }

    const normalizedNodes = normalizeNodesInput(Array.isArray(row.nodes) ? row.nodes : []);
    const graphValidation = validateFlowGraph({
      entry_node_id: row.entry_node_id,
      nodes: normalizedNodes,
    });
    const nodeConfigValidation = validateNodeConfigs(normalizedNodes);
    const validationErrors = [
      ...(graphValidation.errors || []),
      ...(nodeConfigValidation.errors || []),
    ];
    if (validationErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'validation_failed',
        validation_errors: validationErrors,
      });
    }

    const triggerEntityId = parseIntOrNull(body.trigger_entity_id);
    const triggerEntityType = cleanString(body.trigger_entity_type) || 'entity';

    const idempotencyKey = cleanString(body.idempotency_key) || buildIdempotencyKey({
      trigger_type: row.trigger_type,
      trigger_entity_id: triggerEntityId || 0,
      template_version_id: row.id,
      window_identifier: body.window_identifier,
    });

    const existing = await FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
    if (existing) {
      return res.status(200).json({
        success: true,
        deduplicated: true,
        data: existing,
      });
    }

    const initialContext = body.initial_context && typeof body.initial_context === 'object' && !Array.isArray(body.initial_context)
      ? body.initial_context
      : {};
    const triggerData = body.trigger_data && typeof body.trigger_data === 'object' ? body.trigger_data : {};

    const hydratedContext = await buildHydratedExecutionContext({
      triggerType: row.trigger_type,
      triggerEntityType,
      triggerEntityId,
      triggerData,
    });

    const context = {
      trigger: {
        type: row.trigger_type,
        data: {
          ...triggerData,
          ...(hydratedContext?.trigger?.data && typeof hydratedContext.trigger.data === 'object'
            ? hydratedContext.trigger.data
            : {}),
        },
      },
      __simulation: isSimulation,
      outputs: {},
      ...hydratedContext,
      ...initialContext,
    };
    if (!context.outputs || typeof context.outputs !== 'object' || Array.isArray(context.outputs)) {
      context.outputs = {};
    }
    if (!context.trigger || typeof context.trigger !== 'object' || Array.isArray(context.trigger)) {
      context.trigger = { type: row.trigger_type, data: {} };
    }
    if (!context.trigger.data || typeof context.trigger.data !== 'object' || Array.isArray(context.trigger.data)) {
      context.trigger.data = {};
    }
    context.trigger = {
      ...context.trigger,
      type: row.trigger_type,
      data: {
        ...triggerData,
        ...(hydratedContext?.trigger?.data && typeof hydratedContext.trigger.data === 'object'
          ? hydratedContext.trigger.data
          : {}),
        ...(initialContext?.trigger?.data && typeof initialContext.trigger.data === 'object'
          ? initialContext.trigger.data
          : {}),
      },
    };

    const hydratedClinicId = parseIntOrNull(
      hydratedContext?.clinic?.id_clinica
      || hydratedContext?.clinica?.id_clinica
      || hydratedContext?.appointment?.clinica_id
      || hydratedContext?.patient?.clinica_id
      || hydratedContext?.lead?.clinica_id
      || hydratedContext?.trigger?.data?.clinic_id
      || hydratedContext?.trigger?.data?.clinica_id
    );
    const hydratedGroupId = parseIntOrNull(
      hydratedContext?.clinic?.group_id
      || hydratedContext?.clinica?.group_id
      || hydratedContext?.clinic?.grupo_id
      || hydratedContext?.clinica?.grupo_id
    );

    const createdExecution = await FlowExecutionV2.create({
      idempotency_key: idempotencyKey,
      template_version_id: row.id,
      engine_version: row.engine_version || 'v2',
      status: 'running',
      context,
      current_node_id: row.entry_node_id,
      trigger_type: row.trigger_type,
      trigger_entity_type: triggerEntityType,
      trigger_entity_id: triggerEntityId,
      clinic_id: row.clinic_id || hydratedClinicId || null,
      group_id: row.group_id || hydratedGroupId || null,
      created_by: access.user_id,
    });
    const io = getIO();
    if (io) {
      const clinicId = parseIntOrNull(createdExecution.clinic_id);
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

    const requestedByName = cleanString(
      req.userData?.name
      || req.userData?.nombre
      || req.userData?.username
      || req.userData?.email
      || null
    );

    const queueJob = await jobRequestsService.enqueueJobRequest({
      type: 'automations_v2_execute',
      priority: 'high',
      origin: 'automations_v2',
      payload: {
        execution_id: createdExecution.id,
      },
      requestedBy: access.user_id,
      requestedByName,
      requestedByRole: cleanString(req.userData?.role || req.userData?.rol || 'admin'),
    });
    jobScheduler.triggerImmediate(queueJob.id).catch(() => {});

    return res.status(202).json({
      success: true,
      deduplicated: false,
      data: mapExecution(createdExecution, { includeContext: true }),
      queue: {
        enqueued: true,
        job_request_id: queueJob.id,
        status: queueJob.status,
      },
    });
  } catch (err) {
    console.error('Error executeTemplateVersion v2', err);
    return res.status(500).json({ success: false, error: 'execute_failed', message: err.message });
  }
};

exports.resumeExecution = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId);
    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    if (execution.status !== 'waiting') {
      return res.status(409).json({
        success: false,
        error: 'execution_not_waiting',
        message: `La ejecución ${execution.id} no está en espera (status=${execution.status})`,
      });
    }

    const mode = cleanString(req.body?.mode) || 'timeout';
    if (!['timeout', 'response'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'invalid_resume_mode',
        message: "mode debe ser 'timeout' o 'response'",
      });
    }

    const requestedByName = cleanString(
      req.userData?.name
      || req.userData?.nombre
      || req.userData?.username
      || req.userData?.email
      || null
    );

    const queueJob = await jobRequestsService.enqueueJobRequest({
      type: 'automations_v2_execute',
      priority: 'high',
      origin: 'automations_v2_resume',
      payload: {
        execution_id: execution.id,
        resume_mode: mode,
        response_text: req.body?.response_text ?? null,
      },
      requestedBy: access.user_id,
      requestedByName,
      requestedByRole: cleanString(req.userData?.role || req.userData?.rol || 'admin'),
    });
    jobScheduler.triggerImmediate(queueJob.id).catch(() => {});

    return res.status(202).json({
      success: true,
      data: mapExecution(execution, { includeContext: true }),
      queue: {
        enqueued: true,
        job_request_id: queueJob.id,
        status: queueJob.status,
      },
    });
  } catch (err) {
    console.error('Error resumeExecution v2', err);
    return res.status(500).json({ success: false, error: 'resume_failed', message: err.message });
  }
};

exports.listExecutions = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    if (!access.is_admin && access.clinic_ids.size === 0 && access.group_ids.size === 0) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const limit = parseLimit(req.query?.limit, 25);
    const offset = parseOffset(req.query?.offset);
    const includeContext = parseBool(req.query?.include_context, false);

    const where = {};
    const status = cleanString(req.query?.status);
    if (status) where.status = status;

    const triggerType = cleanString(req.query?.trigger_type);
    if (triggerType) where.trigger_type = triggerType;

    const triggerEntityId = parseIntOrNull(req.query?.trigger_entity_id);
    if (triggerEntityId) where.trigger_entity_id = triggerEntityId;

    const idempotencyKey = cleanString(req.query?.idempotency_key);
    if (idempotencyKey) where.idempotency_key = idempotencyKey;

    const clinicId = parseIntOrNull(req.query?.clinic_id);
    if (clinicId) {
      if (!access.is_admin && !access.clinic_ids.has(clinicId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.clinic_id = clinicId;
    }

    const groupId = parseIntOrNull(req.query?.group_id);
    if (groupId) {
      if (!access.is_admin && !access.group_ids.has(groupId)) {
        return res.status(403).json({ success: false, error: 'forbidden_scope' });
      }
      where.group_id = groupId;
    }

    if (!access.is_admin && !clinicId && !groupId) {
      const scopeFilters = [];
      if (access.clinic_ids.size) {
        scopeFilters.push({ clinic_id: { [Op.in]: Array.from(access.clinic_ids) } });
      }
      if (access.group_ids.size) {
        scopeFilters.push({ group_id: { [Op.in]: Array.from(access.group_ids) } });
      }
      scopeFilters.push({ created_by: access.user_id });

      where[Op.and] = where[Op.and] || [];
      where[Op.and].push({ [Op.or]: scopeFilters });
    }

    const templateVersionId = parseIntOrNull(req.query?.template_version_id);
    if (templateVersionId) {
      where.template_version_id = templateVersionId;
    }

    const templateKey = sanitizeTemplateKey(req.query?.template_key);
    const templateVersion = parseIntOrNull(req.query?.template_version);
    const templateWhere = {};
    if (templateKey) templateWhere.template_key = templateKey;
    if (templateVersion) templateWhere.version = templateVersion;

    const { count, rows } = await FlowExecutionV2.findAndCountAll({
      where,
      include: [{
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type'],
        required: !!templateKey || !!templateVersion,
        ...((templateKey || templateVersion) ? { where: templateWhere } : {}),
      }],
      order: [['id', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      success: true,
      data: rows.map((row) => mapExecution(row, { includeContext })),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error listExecutions v2', err);
    return res.status(500).json({ success: false, error: 'list_executions_failed', message: err.message });
  }
};

exports.getExecution = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    const includeContext = parseBool(req.query?.include_context, true);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId, {
      include: [{
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type'],
      }],
    });

    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    return res.json({ success: true, data: mapExecution(execution, { includeContext }) });
  } catch (err) {
    console.error('Error getExecution v2', err);
    return res.status(500).json({ success: false, error: 'get_execution_failed', message: err.message });
  }
};

exports.getExecutionLogs = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const executionId = parseIntOrNull(req.params?.id);
    const includeAudit = parseBool(req.query?.include_audit, true);
    if (!executionId) {
      return res.status(400).json({ success: false, error: 'invalid_execution_id' });
    }

    const execution = await FlowExecutionV2.findByPk(executionId);
    if (!execution || !hasScopeAccess(access, execution)) {
      return res.status(404).json({ success: false, error: 'execution_not_found' });
    }

    const limit = parseLimit(req.query?.limit, 100);
    const offset = parseOffset(req.query?.offset);
    const where = { flow_execution_id: executionId };
    const nodeId = cleanString(req.query?.node_id);
    if (nodeId) where.node_id = nodeId;

    const status = cleanString(req.query?.status);
    if (status) where.status = status;

    const { count, rows } = await FlowExecutionLogV2.findAndCountAll({
      where,
      limit,
      offset,
      order: [['id', 'ASC']],
    });

    return res.json({
      success: true,
      data: rows.map((row) => mapExecutionLog(row, { includeAudit })),
      pagination: {
        total: count,
        limit,
        offset,
      },
    });
  } catch (err) {
    console.error('Error getExecutionLogs v2', err);
    return res.status(500).json({ success: false, error: 'get_execution_logs_failed', message: err.message });
  }
};

exports.getMessageDeliveryStatus = async (req, res) => {
  try {
    const access = await resolveAccess(req);
    const messageId = parseIntOrNull(req.params?.message_id);
    if (!messageId) {
      return res.status(400).json({ success: false, error: 'invalid_message_id' });
    }

    const message = await Message.findByPk(messageId, {
      attributes: [
        'id',
        'conversation_id',
        'direction',
        'message_type',
        'status',
        'metadata',
        'createdAt',
        'updatedAt',
      ],
      raw: true,
    });

    if (!message) {
      return res.status(404).json({ success: false, error: 'message_not_found' });
    }

    const conversationId = parseIntOrNull(message.conversation_id);
    let clinicId = null;
    let groupId = null;
    if (conversationId) {
      const conversation = await Conversation.findByPk(conversationId, {
        attributes: ['id', 'clinic_id'],
        raw: true,
      });
      clinicId = parseIntOrNull(conversation?.clinic_id);
      if (clinicId) {
        const clinic = await Clinica.findByPk(clinicId, {
          attributes: ['id_clinica', 'grupoClinicaId'],
          raw: true,
        });
        groupId = parseIntOrNull(clinic?.grupoClinicaId);
      }
    }

    if (!hasScopeAccess(access, { clinic_id: clinicId, group_id: groupId, is_system: false })) {
      return res.status(403).json({ success: false, error: 'forbidden_scope' });
    }

    const metadata = isObject(message.metadata) ? message.metadata : {};
    const waStatus = isObject(metadata.wa_status) ? metadata.wa_status : null;
    const waStatusHistory = Array.isArray(metadata.wa_status_history) ? metadata.wa_status_history : [];
    const providerError = metadata.error || metadata.wa_error || null;

    return res.json({
      success: true,
      data: {
        id: message.id,
        conversation_id: conversationId,
        clinic_id: clinicId,
        group_id: groupId,
        direction: message.direction,
        message_type: message.message_type,
        status: cleanString(message.status),
        provider_status: cleanString(waStatus?.status) || null,
        provider_timestamp: waStatus?.timestamp || null,
        template_name: cleanString(metadata.template_name),
        template_id: parseIntOrNull(metadata.template_id),
        recipient: cleanString(metadata.recipient),
        wamid: cleanString(metadata.wamid),
        error: providerError,
        status_history: waStatusHistory,
        created_at: message.createdAt || null,
        updated_at: message.updatedAt || null,
      },
    });
  } catch (err) {
    console.error('Error getMessageDeliveryStatus v2', err);
    return res.status(500).json({ success: false, error: 'get_message_status_failed', message: err.message });
  }
};
