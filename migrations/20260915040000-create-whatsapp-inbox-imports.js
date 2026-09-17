'use strict';
const { SCHEMA } = require('../src/lib/whatsappInboxImport');
module.exports = {
  async up(queryInterface) { for (const sql of SCHEMA) await queryInterface.sequelize.query(sql); },
  async down() { throw Error('Preserve WhatsApp inbox receipts on rollback; stop the consumer instead.'); },
};
