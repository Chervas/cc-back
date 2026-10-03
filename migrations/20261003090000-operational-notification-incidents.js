'use strict';

const { DataTypes: D } = require('sequelize');

module.exports = {
  async up(qi) {
    const tables = await qi.showAllTables();
    if (!tables.includes('SystemNotificationIncidents')) {
      await qi.createTable('SystemNotificationIncidents', {
        incident_key: { type: D.CHAR(64), primaryKey: true },
        namespace: { type: D.STRING(32), allowNull: false },
        event_key: { type: D.STRING(120), allowNull: false },
        scope_key: { type: D.STRING(128), allowNull: false },
        state: { type: D.STRING(16), allowNull: false },
        severity: { type: D.STRING(24), allowNull: false },
        opened_at: { type: D.DATE(3), allowNull: false },
        observed_at: { type: D.DATE(3), allowNull: false },
        closed_at: D.DATE(3),
        snapshot: { type: D.JSON, allowNull: false },
        channel_state: { type: D.JSON, allowNull: false },
      });
    }
    const indexes = await qi.showIndex('SystemNotificationIncidents');
    if (!indexes.some(index => index.name === 'system_notification_open_incidents')) {
      await qi.addIndex('SystemNotificationIncidents', ['namespace', 'state'],
        { name: 'system_notification_open_incidents' });
    }
    const columns = await qi.describeTable('WhatsappInboxAdminSync');
    if (!columns.archived_at) await qi.addColumn('WhatsappInboxAdminSync', 'archived_at', { type: D.DATE(3), allowNull: true });
    if (!columns.archive_reason) await qi.addColumn('WhatsappInboxAdminSync', 'archive_reason', { type: D.STRING(120), allowNull: true });
  },
  async down() { throw Error('Preserve incident and archived-notice evidence; roll back code, not data.'); },
};
