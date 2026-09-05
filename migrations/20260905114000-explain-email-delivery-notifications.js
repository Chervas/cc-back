'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'explain_email_delivery_notifications_v1';
const EVENT_KEYS = Object.freeze(['email_bounces_7d', 'email_active_suppressions']);

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function extractCount(message) {
  const match = String(message || '').match(/\d+/);
  const count = Number(match?.[0]);
  return Number.isInteger(count) && count > 0 ? count : null;
}

function renderNotification(event, message) {
  const count = extractCount(message);
  if (event === 'email_bounces_7d') {
    return {
      title: count === 1 ? 'Correo no entregado' : 'Correos no entregados',
      message: count === 1
        ? 'Un correo no pudo entregarse durante los últimos 7 días. Comprueba que la dirección sea correcta antes de volver a enviar.'
        : `${count || 'Varios'} correos no pudieron entregarse durante los últimos 7 días. Comprueba que las direcciones sean correctas antes de volver a enviar.`,
    };
  }
  if (event === 'email_active_suppressions') {
    return {
      title: count === 1
        ? 'Dirección bloqueada para nuevos envíos'
        : 'Direcciones bloqueadas para nuevos envíos',
      message: count === 1
        ? 'Clinicaclick ha detenido los envíos a una dirección tras un rechazo, una queja o una baja. Corrígela o confírmala antes de reactivar los envíos.'
        : `Clinicaclick ha detenido los envíos a ${count || 'varias'} direcciones tras rechazos, quejas o bajas. Corrígelas o confírmalas antes de reactivar los envíos.`,
    };
  }
  return null;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const existing = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (existing.length) return;

      const notifications = await queryInterface.sequelize.query(
        `SELECT id, event, title, message
           FROM Notifications
          WHERE is_read = 0
            AND event IN (:eventKeys)
          FOR UPDATE`,
        {
          replacements: { eventKeys: EVENT_KEYS },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshots = [];
      for (const notification of notifications) {
        const replacement = renderNotification(notification.event, notification.message);
        if (!replacement) continue;
        snapshots.push({
          id: Number(notification.id),
          title: notification.title,
          message: notification.message,
        });
        await queryInterface.bulkUpdate(
          'Notifications',
          replacement,
          { id: Number(notification.id), is_read: false },
          { transaction },
        );
      }

      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ notifications: snapshots }),
        created_at: now,
        updated_at: now,
      }], { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const rows = await queryInterface.sequelize.query(
        `SELECT payload FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      const snapshot = parseJson(rows[0]?.payload, null);
      for (const notification of snapshot?.notifications || []) {
        await queryInterface.bulkUpdate(
          'Notifications',
          { title: notification.title, message: notification.message },
          { id: Number(notification.id) },
          { transaction },
        );
      }
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: {
    EVENT_KEYS,
    SNAPSHOT_KEY,
    extractCount,
    renderNotification,
  },
};
