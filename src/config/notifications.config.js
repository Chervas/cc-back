'use strict';

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1')
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
  { role: 'admin', subrole: null, event: 'ads.sync_error', enabled: true },
  { role: 'admin', subrole: null, event: 'ads.new_lead', enabled: true },
  { role: 'admin', subrole: null, event: 'ads.health_issue', enabled: true }
];

module.exports = {
  ADMIN_USER_IDS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLE_GROUPS,
  DEFAULT_NOTIFICATION_PREFERENCES
};
