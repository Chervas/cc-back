'use strict';
const { SCHEMA } = require('../src/lib/whatsappInboxRoutingReview');
module.exports = {
  async up(queryInterface) { for (const sql of SCHEMA) await queryInterface.sequelize.query(sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')); },
  async down(queryInterface) {
    await queryInterface.dropTable('WhatsappInboxRoutingReviewReceipts');
    await queryInterface.dropTable('WhatsappInboxRoutingReviews');
  },
};
