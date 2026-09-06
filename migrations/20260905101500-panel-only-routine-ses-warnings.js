'use strict';

const SNAPSHOT_TABLE = 'AutomationIntentMigrationSnapshots';
const SNAPSHOT_KEY = 'panel_only_routine_ses_warnings_20260905';
const EVENT_KEYS = Object.freeze(['email_bounces_7d', 'email_active_suppressions']);

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const snapshots = await queryInterface.sequelize.query(
        `SELECT snapshot_key FROM ${SNAPSHOT_TABLE} WHERE snapshot_key = :snapshotKey LIMIT 1`,
        {
          replacements: { snapshotKey: SNAPSHOT_KEY },
          type: queryInterface.sequelize.QueryTypes.SELECT,
          transaction,
        },
      );
      if (snapshots.length) return;

      const rows = await queryInterface.sequelize.query(
        `SELECT id, event_rules FROM SystemNotificationSettings WHERE scope = 'global' LIMIT 1 FOR UPDATE`,
        { type: queryInterface.sequelize.QueryTypes.SELECT, transaction },
      );
      const setting = rows[0];
      if (!setting) return;

      const originalRules = parseJson(setting.event_rules, {});
      const nextRules = JSON.parse(JSON.stringify(originalRules));
      for (const key of EVENT_KEYS) {
        nextRules[key] = {
          ...(nextRules[key] && typeof nextRules[key] === 'object' ? nextRules[key] : {}),
          email: false,
          panel: true,
        };
      }
      const now = new Date();
      await queryInterface.bulkInsert(SNAPSHOT_TABLE, [{
        snapshot_key: SNAPSHOT_KEY,
        payload: JSON.stringify({ setting_id: Number(setting.id), original_event_rules: originalRules }),
        created_at: now,
        updated_at: now,
      }], { transaction });
      await queryInterface.bulkUpdate(
        'SystemNotificationSettings',
        { event_rules: JSON.stringify(nextRules), updated_at: now },
        { id: Number(setting.id) },
        { transaction },
      );
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
      if (!snapshot?.setting_id || !snapshot.original_event_rules) return;
      await queryInterface.bulkUpdate(
        'SystemNotificationSettings',
        { event_rules: JSON.stringify(snapshot.original_event_rules), updated_at: new Date() },
        { id: Number(snapshot.setting_id) },
        { transaction },
      );
      await queryInterface.bulkDelete(SNAPSHOT_TABLE, { snapshot_key: SNAPSHOT_KEY }, { transaction });
    });
  },

  _test: { EVENT_KEYS, parseJson },
};
