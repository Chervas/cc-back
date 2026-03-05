'use strict';

const CITA_STATUSES = Object.freeze([
  {
    value: 'pendiente',
    label: 'Pendiente',
    description: 'Cita creada en el sistema',
    color: 'slate',
    icon: 'heroicons_outline:clock',
    order: 1,
    is_terminal: false,
  },
  {
    value: 'info_enviada',
    label: 'Info enviada',
    description: 'Informacion inicial enviada al paciente',
    color: 'sky',
    icon: 'heroicons_outline:paper-airplane',
    order: 2,
    is_terminal: false,
  },
  {
    value: 'info_confirmada',
    label: 'Info confirmada',
    description: 'Paciente confirma recepcion de informacion inicial',
    color: 'indigo',
    icon: 'heroicons_outline:check-badge',
    order: 3,
    is_terminal: false,
  },
  {
    value: 'recordatorio_enviado',
    label: 'Recordatorio enviado',
    description: 'Recordatorio previo a la cita enviado',
    color: 'blue',
    icon: 'heroicons_outline:bell-alert',
    order: 4,
    is_terminal: false,
  },
  {
    value: 'recordatorio_confirmado',
    label: 'Asistencia confirmada',
    description: 'Paciente confirma asistencia tras recordatorio',
    color: 'teal',
    icon: 'heroicons_outline:check-circle',
    order: 5,
    is_terminal: false,
  },
  {
    value: 'completada',
    label: 'Completada',
    description: 'Paciente acudio a la cita',
    color: 'emerald',
    icon: 'heroicons_outline:check',
    order: 6,
    is_terminal: true,
  },
  {
    value: 'no_asistio',
    label: 'No asistio',
    description: 'Paciente no se presento',
    color: 'amber',
    icon: 'heroicons_outline:exclamation-triangle',
    order: 7,
    is_terminal: true,
  },
  {
    value: 'cancelada',
    label: 'Cancelada',
    description: 'Cita anulada',
    color: 'rose',
    icon: 'heroicons_outline:x-circle',
    order: 8,
    is_terminal: true,
  },
  {
    value: 'reprogramada',
    label: 'Reprogramada',
    description: 'Cita original reprogramada a una nueva cita',
    color: 'orange',
    icon: 'heroicons_outline:arrow-path',
    order: 9,
    is_terminal: true,
  },
]);

const CITA_ALLOWED_TRANSITIONS = Object.freeze({
  pendiente: ['info_enviada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada', 'cancelada', 'completada', 'no_asistio'],
  info_enviada: ['info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada', 'cancelada', 'completada', 'no_asistio'],
  info_confirmada: ['recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada', 'cancelada', 'completada', 'no_asistio'],
  recordatorio_enviado: ['recordatorio_confirmado', 'reprogramada', 'cancelada', 'completada', 'no_asistio'],
  recordatorio_confirmado: ['reprogramada', 'cancelada', 'completada', 'no_asistio'],
  reprogramada: [],
  cancelada: [],
  completada: [],
  no_asistio: [],
});

const LEAD_STATUSES = Object.freeze([
  {
    value: 'nuevo',
    label: 'Nuevo',
    description: 'Lead recién captado',
    color: 'slate',
    icon: 'heroicons_outline:plus-circle',
    order: 1,
    is_terminal: false,
  },
  {
    value: 'contactado',
    label: 'Contactado',
    description: 'Se ha contactado al lead',
    color: 'blue',
    icon: 'heroicons_outline:phone',
    order: 2,
    is_terminal: false,
  },
  {
    value: 'esperando_info',
    label: 'Esperando info',
    description: 'Pendiente de información',
    color: 'amber',
    icon: 'heroicons_outline:clock',
    order: 3,
    is_terminal: false,
  },
  {
    value: 'info_recibida',
    label: 'Info recibida',
    description: 'Información recibida',
    color: 'indigo',
    icon: 'heroicons_outline:inbox-arrow-down',
    order: 4,
    is_terminal: false,
  },
  {
    value: 'citado',
    label: 'Citado',
    description: 'Cita agendada',
    color: 'teal',
    icon: 'heroicons_outline:calendar',
    order: 5,
    is_terminal: false,
  },
  {
    value: 'acudio_cita',
    label: 'Acudió a cita',
    description: 'Asistió a la cita',
    color: 'emerald',
    icon: 'heroicons_outline:check-circle',
    order: 6,
    is_terminal: false,
  },
  {
    value: 'convertido',
    label: 'Convertido',
    description: 'Convertido a paciente',
    color: 'emerald',
    icon: 'heroicons_outline:check',
    order: 7,
    is_terminal: true,
  },
  {
    value: 'descartado',
    label: 'Descartado',
    description: 'Lead descartado',
    color: 'rose',
    icon: 'heroicons_outline:x-circle',
    order: 8,
    is_terminal: true,
  },
]);

const LEAD_ALLOWED_TRANSITIONS = Object.freeze({
  nuevo: ['contactado', 'esperando_info', 'citado', 'descartado'],
  contactado: ['esperando_info', 'info_recibida', 'citado', 'descartado'],
  esperando_info: ['info_recibida', 'contactado', 'citado', 'descartado'],
  info_recibida: ['citado', 'contactado', 'descartado'],
  citado: ['acudio_cita', 'descartado'],
  acudio_cita: ['convertido', 'descartado'],
  convertido: [],
  descartado: [],
});

const CITA_STATUS_VALUES = Object.freeze(CITA_STATUSES.map((item) => item.value));
const LEAD_STATUS_VALUES = Object.freeze(LEAD_STATUSES.map((item) => item.value));

const CITA_STATUS_SET = new Set(CITA_STATUS_VALUES);
const LEAD_STATUS_SET = new Set(LEAD_STATUS_VALUES);

function normalizeValue(raw) {
  if (raw === undefined || raw === null) return null;
  const normalized = String(raw).trim().toLowerCase();
  return normalized || null;
}

function normalizeCitaStatus(raw) {
  const value = normalizeValue(raw);
  if (!value) return null;
  return CITA_STATUS_SET.has(value) ? value : null;
}

function normalizeLeadStatus(raw) {
  const value = normalizeValue(raw);
  if (!value) return null;
  return LEAD_STATUS_SET.has(value) ? value : null;
}

function getStatusesByEntity(entity) {
  const normalized = normalizeValue(entity);
  if (normalized === 'cita') {
    return {
      statuses: CITA_STATUSES,
      allowed_transitions: CITA_ALLOWED_TRANSITIONS,
      default_status: 'pendiente',
    };
  }
  if (normalized === 'lead') {
    return {
      statuses: LEAD_STATUSES,
      allowed_transitions: LEAD_ALLOWED_TRANSITIONS,
      default_status: 'nuevo',
    };
  }
  return null;
}

module.exports = {
  CITA_STATUSES,
  CITA_ALLOWED_TRANSITIONS,
  CITA_STATUS_VALUES,
  LEAD_STATUSES,
  LEAD_ALLOWED_TRANSITIONS,
  LEAD_STATUS_VALUES,
  normalizeCitaStatus,
  normalizeLeadStatus,
  getStatusesByEntity,
};
