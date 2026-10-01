'use strict';

const { DataTypes: D } = require('sequelize');

module.exports = {
  async up(qi) {
    const tables = await qi.showAllTables();
    if (!tables.includes('WhatsappInboxAdminSync')) {
      await qi.createTable('WhatsappInboxAdminSync', {
        receipt: { type: D.CHAR(36), allowNull: false, primaryKey: true },
        waba_id: { type: D.STRING(30), allowNull: false, primaryKey: true },
        digest: { type: D.CHAR(64), allowNull: false },
        import_receipt: { type: D.CHAR(36), allowNull: false },
        created_at: { type: D.DATE(3), allowNull: false },
        reconciled_at: { type: D.DATE(3), allowNull: true },
      });
    }
    if (!(await qi.showIndex('WhatsappInboxAdminSync')).some(index => index.name === 'wa_inbox_admin_pending')) {
      await qi.addIndex('WhatsappInboxAdminSync', ['reconciled_at', 'waba_id', 'created_at'],
        { name: 'wa_inbox_admin_pending' });
    }
  },
  async down() { throw Error('Preserve imported WhatsApp account-event evidence; roll back code, not data.'); },
};
