'use strict';

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44')
  .split(',')
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => Number.isInteger(id));

const NOTIFICATION_CATEGORIES = [
  {
    id: 'ads',
    label: 'Campañas publicitarias',
    icon: 'heroicons_outline:megaphone'
  },
  {
    id: 'jobs',
    label: 'Jobs del sistema',
    icon: 'heroicons_outline:cpu-chip'
  },
  {
    id: 'crm',
    label: 'CRM y seguimiento',
    icon: 'heroicons_outline:phone-arrow-up-right'
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: 'heroicons_outline:chat-bubble-left-right'
  }
];

const NOTIFICATION_EVENTS = [
  {
    event: 'ads.sync_error',
    category: 'ads',
    label: 'Errores al sincronizar campañas',
    level: 'warning'
  },
  {
    event: 'ads.new_lead',
    category: 'ads',
    label: 'Nuevo lead',
    level: 'info'
  },
  {
    event: 'ads.health_issue',
    category: 'ads',
    label: 'Problemas en la salud de campañas',
    level: 'warning'
  },
  {
    event: 'jobs.failed',
    category: 'jobs',
    label: 'Ejecución de job fallida',
    level: 'error'
  },
  {
    event: 'jobs.automation_health_issue',
    category: 'jobs',
    label: 'Barrido de automatizaciones con incidencias',
    level: 'error'
  },
  {
    event: 'crm.call_back_reminder',
    category: 'crm',
    label: 'Recordatorio de volver a llamar',
    level: 'info'
  },
  {
    event: 'whatsapp.payment_missing',
    category: 'whatsapp',
    label: 'WhatsApp sin método de pago',
    level: 'error'
  },
  {
    event: 'whatsapp.coexistence_disconnected',
    category: 'whatsapp',
    label: 'WhatsApp compartido desconectado',
    level: 'error'
  },
  {
    event: 'whatsapp.coexistence_reconnected',
    category: 'whatsapp',
    label: 'WhatsApp compartido reconectado',
    level: 'info'
  },
  {
    event: 'whatsapp.review_photo_template_approved',
    category: 'whatsapp',
    label: 'Plantilla de reseñas con foto aprobada',
    level: 'info'
  },
  {
    event: 'whatsapp.account_compliance_incident',
    category: 'whatsapp',
    label: 'Restricción o infracción de WhatsApp',
    level: 'error'
  },
  {
    event: 'whatsapp.account_compliance_help_requested',
    category: 'whatsapp',
    label: 'Clínica solicita revisar una suspensión de WhatsApp',
    level: 'warning'
  },
  {
    event: 'whatsapp.account_compliance_resolved',
    category: 'whatsapp',
    label: 'WhatsApp restablecido por Meta',
    level: 'info'
  },
  {
    event: 'whatsapp.delivery_governance_incident',
    category: 'whatsapp',
    label: 'Cola o plantilla de WhatsApp detenida',
    level: 'error'
  }
];

const NOTIFICATION_ROLE_GROUPS = [
  {
    role: 'personaldeclinica',
    label: 'Personal de clínica',
    subroles: [
      { id: 'Doctores', label: 'Doctores' },
      { id: 'Auxiliares y enfermeros', label: 'Auxiliares y enfermeros' },
      { id: 'Administrativos', label: 'Administrativos' },
      { id: 'Recepción / Comercial ventas', label: 'Recepción / Comercial ventas' }
    ]
  },
  {
    role: 'propietario',
    label: 'Propietario de clínica',
    subroles: []
  },
  {
    role: 'admin',
    label: 'Administrador',
    subroles: []
  }
];

const DEFAULT_NOTIFICATION_PREFERENCES = [
  { role: 'personaldeclinica', subrole: 'Doctores', event: 'ads.sync_error', enabled: true },
  { role: 'personaldeclinica', subrole: 'Doctores', event: 'ads.new_lead', enabled: true },
  { role: 'personaldeclinica', subrole: 'Doctores', event: 'ads.health_issue', enabled: true },
  { role: 'personaldeclinica', subrole: 'Auxiliares y enfermeros', event: 'ads.sync_error', enabled: false },
  { role: 'personaldeclinica', subrole: 'Auxiliares y enfermeros', event: 'ads.new_lead', enabled: true },
  { role: 'personaldeclinica', subrole: 'Auxiliares y enfermeros', event: 'ads.health_issue', enabled: false },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'ads.sync_error', enabled: false },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'ads.new_lead', enabled: false },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'ads.health_issue', enabled: false },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'ads.sync_error', enabled: false },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'ads.new_lead', enabled: true },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'ads.health_issue', enabled: false },
  { role: 'propietario', subrole: null, event: 'ads.sync_error', enabled: true },
  { role: 'propietario', subrole: null, event: 'ads.new_lead', enabled: true },
  { role: 'propietario', subrole: null, event: 'ads.health_issue', enabled: true },
  { role: 'admin', subrole: null, event: 'jobs.failed', enabled: true },
  { role: 'admin', subrole: null, event: 'jobs.automation_health_issue', enabled: true },
  { role: 'admin', subrole: null, event: 'ads.sync_error', enabled: true },
  { role: 'admin', subrole: null, event: 'ads.new_lead', enabled: true },
  { role: 'admin', subrole: null, event: 'ads.health_issue', enabled: true },
  { role: 'admin', subrole: null, event: 'crm.call_back_reminder', enabled: true },
  { role: 'propietario', subrole: null, event: 'crm.call_back_reminder', enabled: true },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'crm.call_back_reminder', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.payment_missing', enabled: true },
  { role: 'propietario', subrole: null, event: 'whatsapp.payment_missing', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.coexistence_disconnected', enabled: true },
  { role: 'propietario', subrole: null, event: 'whatsapp.coexistence_disconnected', enabled: true },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'whatsapp.coexistence_disconnected', enabled: true },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'whatsapp.coexistence_disconnected', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.coexistence_reconnected', enabled: true },
  { role: 'propietario', subrole: null, event: 'whatsapp.coexistence_reconnected', enabled: true },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'whatsapp.coexistence_reconnected', enabled: true },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'whatsapp.coexistence_reconnected', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.review_photo_template_approved', enabled: true },
  { role: 'propietario', subrole: null, event: 'whatsapp.review_photo_template_approved', enabled: true },
  { role: 'personaldeclinica', subrole: 'Administrativos', event: 'whatsapp.review_photo_template_approved', enabled: true },
  { role: 'personaldeclinica', subrole: 'Recepción / Comercial ventas', event: 'whatsapp.review_photo_template_approved', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.account_compliance_incident', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.account_compliance_help_requested', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.account_compliance_resolved', enabled: true },
  { role: 'admin', subrole: null, event: 'whatsapp.delivery_governance_incident', enabled: true }
];

module.exports = {
  ADMIN_USER_IDS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLE_GROUPS,
  DEFAULT_NOTIFICATION_PREFERENCES
};
