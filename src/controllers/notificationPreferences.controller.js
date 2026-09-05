'use strict';

const {
  NotificationPreference,
  UserNotificationPresentationPreference,
} = require('../../models');
const {
  USER_NOTIFICATION_PRESENTATION_PREFERENCES,
} = require('../config/notifications.config');
const {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  NOTIFICATION_ROLE_GROUPS,
  ensurePreferencesForRole
} = require('../services/notifications.service');

function normalizeSubrole(subrole) {
  return subrole ? String(subrole) : '';
}

function buildPreferencesPayload(role, subrole, preferences) {
  const eventsByCategory = NOTIFICATION_EVENTS.reduce((acc, event) => {
    if (!acc[event.category]) {
      acc[event.category] = [];
    }
    acc[event.category].push(event);
    return acc;
  }, {});

  return NOTIFICATION_CATEGORIES.map((category) => {
    const events = (eventsByCategory[category.id] || []).map((event) => {
      const pref = preferences.find((item) => item.event === event.event);
      return {
        event: event.event,
        label: event.label,
        enabled: pref ? pref.enabled : true,
        level: event.level || 'info'
      };
    });
    return {
      id: category.id,
      label: category.label,
      icon: category.icon,
      events
    };
  });
}

exports.getMeta = (req, res) => {
  res.json({
    roles: NOTIFICATION_ROLE_GROUPS,
    categories: NOTIFICATION_CATEGORIES,
    events: NOTIFICATION_EVENTS
  });
};

exports.getPreferences = async (req, res) => {
  try {
    const role = req.query.role;
    const subrole = req.query.subrole || null;
    if (!role) {
      return res.status(400).json({ message: 'El parámetro "role" es obligatorio' });
    }

    await ensurePreferencesForRole(role, subrole);
    const preferences = await NotificationPreference.findAll({
      where: {
        role,
        subrole: subrole || null
      }
    });

    res.json({
      role,
      subrole,
      categories: buildPreferencesPayload(role, subrole, preferences)
    });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ message: 'No se pudieron obtener las preferencias' });
  }
};

exports.updatePreferences = async (req, res) => {
  try {
    const { role, subrole = null, updates } = req.body;
    if (!role || !Array.isArray(updates)) {
      return res.status(400).json({ message: 'Datos inválidos' });
    }

    await ensurePreferencesForRole(role, subrole);

    const tasks = updates.map(async (item) => {
      const preference = await NotificationPreference.findOne({
        where: {
          role,
          subrole: normalizeSubrole(subrole),
          event: item.event
        }
      });
      if (!preference) {
        return null;
      }
      return preference.update({ enabled: Boolean(item.enabled) });
    });

    await Promise.all(tasks);
    const refreshed = await NotificationPreference.findAll({
      where: {
        role,
        subrole: subrole || null
      }
    });

    res.json({
      role,
      subrole,
      categories: buildPreferencesPayload(role, subrole, refreshed)
    });
  } catch (error) {
    console.error('Error updating notification preferences:', error);
    res.status(500).json({ message: 'No se pudieron actualizar las preferencias' });
  }
};

function buildPresentationPreferences(rows) {
  const values = new Map(rows.map((row) => [row.preferenceKey, Boolean(row.enabled)]));
  return USER_NOTIFICATION_PRESENTATION_PREFERENCES.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    enabled: values.has(definition.key)
      ? values.get(definition.key)
      : definition.defaultEnabled,
  }));
}

exports.getPresentationPreferences = async (req, res) => {
  try {
    const userId = Number(req.userData?.userId);
    const rows = await UserNotificationPresentationPreference.findAll({ where: { userId } });
    res.json({ preferences: buildPresentationPreferences(rows) });
  } catch (error) {
    console.error('Error fetching notification presentation preferences:', error);
    res.status(500).json({ message: 'No se pudieron obtener las preferencias de avisos laterales' });
  }
};

exports.updatePresentationPreferences = async (req, res) => {
  try {
    const userId = Number(req.userData?.userId);
    const { key, enabled } = req.body || {};
    const definition = USER_NOTIFICATION_PRESENTATION_PREFERENCES.find((item) => item.key === key);
    if (!definition || typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'Preferencia de aviso lateral no válida' });
    }

    const [preference] = await UserNotificationPresentationPreference.findOrCreate({
      where: { userId, preferenceKey: key },
      defaults: { enabled },
    });
    if (Boolean(preference.enabled) !== enabled) {
      await preference.update({ enabled });
    }

    const rows = await UserNotificationPresentationPreference.findAll({ where: { userId } });
    return res.json({ preferences: buildPresentationPreferences(rows) });
  } catch (error) {
    console.error('Error updating notification presentation preferences:', error);
    return res.status(500).json({ message: 'No se pudo actualizar la preferencia de aviso lateral' });
  }
};

exports._test = {
  buildPresentationPreferences,
};
