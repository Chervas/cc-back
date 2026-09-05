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
    id: 'system',
    label: 'Sistema',
    icon: 'heroicons_outline:bell-alert'
  },
  {
    id: 'users',
    label: 'Usuarios',
    icon: 'heroicons_outline:user-plus'
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
    event: 'system.notification_test',
    category: 'system',
    label: 'Prueba de notificación de sistema',
    level: 'info'
  },
  {
    event: 'users.new_registration',
    category: 'users',
    label: 'Nuevo registro de usuario',
    level: 'info'
  },
  {
    event: 'email_provider_disabled',
    category: 'system',
    label: 'Email: proveedor desactivado',
    level: 'error'
  },
  {
    event: 'email_from_missing',
    category: 'system',
    label: 'Email: remitente ausente',
    level: 'error'
  },
  {
    event: 'email_encryption_missing',
    category: 'system',
    label: 'Email: cifrado ausente',
    level: 'error'
  },
  {
    event: 'email_ses_credentials_missing',
    category: 'system',
    label: 'Email: credenciales SES incompletas',
    level: 'error'
  },
  {
    event: 'email_webhook_token_missing',
    category: 'system',
    label: 'Email: token webhook ausente',
    level: 'warning'
  },
  {
    event: 'email_failures_24h',
    category: 'system',
    label: 'Email: fallos recientes',
    level: 'warning'
  },
  {
    event: 'email_queue_stuck',
    category: 'system',
    label: 'Email: cola atascada',
    level: 'warning'
  },
  {
    event: 'email_sent_without_events',
    category: 'system',
    label: 'Email: sin eventos SES',
    level: 'warning'
  },
  {
    event: 'email_complaints_7d',
    category: 'system',
    label: 'Email: quejas SES',
    level: 'error'
  },
  {
    event: 'email_bounces_7d',
    category: 'system',
    label: 'Email: correos no entregados',
    level: 'warning'
  },
  {
    event: 'email_active_suppressions',
    category: 'system',
    label: 'Email: direcciones bloqueadas',
    level: 'warning'
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

const USER_NOTIFICATION_PRESENTATION_PREFERENCES = Object.freeze([
  {
    key: 'automation.appointment_data.confirmed_with_reply',
    label: 'Confirmación con pregunta o comentario',
    description: 'Muestra un aviso lateral cuando el paciente confirma lo solicitado por una automatización de cita y añade algo que debe revisar la clínica.',
    defaultEnabled: true,
  },
  {
    key: 'automation.appointment_data.response_needs_human',
    label: 'Respuesta que necesita atención',
    description: 'Muestra un aviso lateral cuando el mensaje requiere intervención humana y no contiene una confirmación clara.',
    defaultEnabled: true,
  },
]);

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
  { role: 'admin', subrole: null, event: 'system.notification_test', enabled: true },
  { role: 'admin', subrole: null, event: 'users.new_registration', enabled: true },
  { role: 'admin', subrole: null, event: 'email_provider_disabled', enabled: true },
  { role: 'admin', subrole: null, event: 'email_from_missing', enabled: true },
  { role: 'admin', subrole: null, event: 'email_encryption_missing', enabled: true },
  { role: 'admin', subrole: null, event: 'email_ses_credentials_missing', enabled: true },
  { role: 'admin', subrole: null, event: 'email_webhook_token_missing', enabled: true },
  { role: 'admin', subrole: null, event: 'email_failures_24h', enabled: true },
  { role: 'admin', subrole: null, event: 'email_queue_stuck', enabled: true },
  { role: 'admin', subrole: null, event: 'email_sent_without_events', enabled: true },
  { role: 'admin', subrole: null, event: 'email_complaints_7d', enabled: true },
  { role: 'admin', subrole: null, event: 'email_bounces_7d', enabled: true },
  { role: 'admin', subrole: null, event: 'email_active_suppressions', enabled: true },
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
  DEFAULT_NOTIFICATION_PREFERENCES,
  USER_NOTIFICATION_PRESENTATION_PREFERENCES,
};
