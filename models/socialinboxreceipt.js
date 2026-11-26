'use strict';

module.exports = (sequelize, D) =>
  sequelize.define(
    'SocialInboxReceipt',
    {
      key: { type: D.CHAR(64), primaryKey: true },
      state: { type: D.STRING(16), allowNull: false },
      event: { type: D.JSON, allowNull: false },
      route: D.JSON,
      message_id: D.INTEGER,
      reason: D.STRING(100),
    },
    { tableName: 'SocialInboxReceipts' },
  );
