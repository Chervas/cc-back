'use strict';

const { Op } = require('sequelize');
const {
  ADMIN_USER_IDS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLE_GROUPS,
  DEFAULT_NOTIFICATION_PREFERENCES
} = require('../config/notifications.config');
const {
  Notification,
  NotificationPreference,
  Usuario,
  UsuarioClinica
} = require('../../models');

function getEventDefinition(event) {
  return NOTIFICATION_EVENTS.find((item) => item.event === event) || null;
}

function getCategoryDefinition(categoryId) {
  return NOTIFICATION_CATEGORIES.find((item) => item.id === categoryId) || null;
}

function buildNotificationContent(event, payload = {}) {
  const defaults = getEventDefinition(event) || {};
  switch (event) {
    case 'ads.sync_error': {
      const clinic = payload.clinicName || 'una clínica';
      const account = payload.accountName ? ` en la cuenta ${payload.accountName}` : '';
      const error = payload.error || 'Revisa los logs para más detalles.';
      return {
        title: `Error de sincronización en ${clinic}`,
        message: `${payload.timestamp || 'Durante la última ejecución'} se detectó un problema${account}: ${error}`,
        icon: 'heroicons_outline:exclamation-triangle',
        level: defaults.level || 'warning'
      };
    }
    case 'ads.new_lead': {
      const clinic = payload.clinicName || 'tu clínica';
      const leadName = payload.leadName || 'Un nuevo lead';
      return {
        title: `${leadName} se registró`,
        message: `${leadName} se ha añadido al embudo de ${clinic}.`,
        icon: 'heroicons_outline:user-plus',
        level: defaults.level || 'info'
      };
    }
    case 'ads.health_issue': {
      const clinic = payload.clinicName || 'una clínica';
      const indicator = payload.indicator || 'los KPIs definidos';
      return {
        title: `Alerta en campañas de ${clinic}`,
        message: `Se detectaron problemas en ${indicator}. Revisa el panel de salud de campañas.`,
        icon: 'heroicons_outline:heart',
        level: defaults.level || 'warning'
      };
    }
    case 'jobs.failed': {
      const jobName = payload.jobName || 'Un job del sistema';
      const error = payload.error || 'Error no especificado';
      return {
        title: `${jobName} ha fallado`,
        message: `${jobName} no pudo completarse correctamente. Detalles: ${error}.`,
        icon: 'heroicons_outline:cpu-chip',
        level: defaults.level || 'error'
      };
    }
    default:
      return {
        title: defaults.label || 'Notificación',
        message: payload.message || 'Se ha emitido una nueva notificación.',
        icon: 'heroicons_outline:bell',
        level: defaults.level || 'info'
      };
  }
}

async function getAdminUsers() {
  if (!ADMIN_USER_IDS.length) {
    return [];
  }
  return Usuario.findAll({
    where: {
      id_usuario: {
        [Op.in]: ADMIN_USER_IDS
      }
    }
  });
}

async function getClinicRoleUsers({ clinicId, role, subrole = null }) {
  if (!clinicId) {
    return [];
  }
  const where = {
    id_clinica: clinicId,
    rol_clinica: role
  };
  if (subrole) {
    where.subrol_clinica = subrole;
  }
  const usuarioClinicas = await UsuarioClinica.findAll({
    where,
    include: [{
      model: Usuario,
      as: 'Usuario',
      required: true
    }]
  });
  return usuarioClinicas
    .map((uc) => uc.Usuario)
    .filter(Boolean);
}

let defaultsEnsured = false;

function normalizeSubrole(subrole) {
  return subrole ? String(subrole) : '';
}

async function ensurePreferenceRecord(role, subrole, event) {
  const normalizedSubrole = normalizeSubrole(subrole);
  const eventDef = getEventDefinition(event);
  if (!eventDef) {
    return null;
  }
  const category = eventDef.category;
  const defaults = DEFAULT_NOTIFICATION_PREFERENCES.find((item) =>
    item.role === role &&
    normalizeSubrole(item.subrole) === normalizedSubrole &&
    item.event === event
  );
  const enabled = defaults ? defaults.enabled : true;
  const [preference] = await NotificationPreference.findOrCreate({
    where: {
      role,
      subrole: normalizedSubrole,
      event
    },
    defaults: {
      category,
      enabled
    }
  });
  return preference;
}

async function ensureDefaultPreferences() {
  if (defaultsEnsured) {
    return;
  }
  for (const item of DEFAULT_NOTIFICATION_PREFERENCES) {
    await ensurePreferenceRecord(item.role, item.subrole, item.event);
  }
  defaultsEnsured = true;
}

async function ensurePreferencesForRole(role, subrole = null) {
  await ensureDefaultPreferences();
  const tasks = NOTIFICATION_EVENTS.map((eventDef) => ensurePreferenceRecord(role, subrole, eventDef.event));
  await Promise.all(tasks);
  return NotificationPreference.findAll({
    where: {
      role,
      subrole: normalizeSubrole(subrole)
    }
  });
}

async function dispatchEvent({ event, clinicId = null, data = {} }) {
  await ensureDefaultPreferences();
  const eventDef = getEventDefinition(event);
  if (!eventDef) {
    return;
  }

  const preferences = await NotificationPreference.findAll({
    where: {
      event,
      enabled: true
    }
  });

  if (!preferences.length) {
    return;
  }

  const uniqueUsers = new Map();

  for (const pref of preferences) {
    let recipients = [];
    if (pref.role === 'admin') {
      recipients = await getAdminUsers();
    } else if (pref.role === 'propietario') {
      recipients = await getClinicRoleUsers({ clinicId, role: 'propietario' });
    } else if (pref.role === 'personaldeclinica') {
      recipients = await getClinicRoleUsers({ clinicId, role: 'personaldeclinica', subrole: pref.subrole });
    }
    recipients.forEach((user) => {
      if (user) {
        uniqueUsers.set(user.id_usuario, {
          user,
          role: pref.role,
          subrole: pref.subrole
        });
      }
    });
  }

  if (!uniqueUsers.size) {
    return;
  }

  const content = buildNotificationContent(event, data);
  const clinicIdValue = clinicId || null;

  const createPromises = [];
  const today = new Date();
  const startOfDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  for (const [userId, meta] of uniqueUsers.entries()) {
    createPromises.push((async () => {
      const existing = await Notification.findOne({
        where: {
          userId,
          event,
          clinicaId: clinicIdValue,
          created_at: {
            [Op.gte]: startOfDay
          }
        }
      });
      if (existing) {
        return null;
      }
      return Notification.create({
        userId,
        role: meta.role,
        subrole: meta.subrole,
        category: eventDef.category,
        event,
        title: content.title,
        message: content.message,
        icon: content.icon,
        level: content.level,
        data,
        clinicaId: clinicIdValue
      });
    })());
  }

  await Promise.all(createPromises);
}

module.exports = {
  getEventDefinition,
  getCategoryDefinition,
  ensurePreferencesForRole,
  dispatchEvent,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLE_GROUPS
};
