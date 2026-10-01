'use strict';

const { DataTypes: D } = require('sequelize');

module.exports = {
  async up(qi) {
    if (!(await qi.showAllTables()).includes('WhatsappInboxPlaybackImports')) {
      await qi.createTable('WhatsappInboxPlaybackImports', {
        receipt: { type: D.CHAR(36), allowNull: false, primaryKey: true },
        phone_id: { type: D.STRING(30), allowNull: false, primaryKey: true },
        waba_id: { type: D.STRING(30), allowNull: false },
        digest: { type: D.CHAR(64), allowNull: false },
        import_receipt: { type: D.CHAR(36), allowNull: false },
        clinic_ids: { type: D.JSON, allowNull: false },
        event_count: { type: D.INTEGER, allowNull: false },
        created_at: { type: D.DATE(3), allowNull: false },
      });
    }
  },
  async down() { throw Error('Preserve imported WhatsApp playback evidence; roll back code, not data.'); },
};
