'use strict';

const TABLE = 'MetaMarketingEnrollmentDestinationPlans';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable(TABLE, {
      enrollment_id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      plan: { type: Sequelize.TEXT('medium'), allowNull: false },
      digest: { type: Sequelize.CHAR(64), allowNull: false },
      asset_labels: { type: Sequelize.JSON, allowNull: true },
    }, { engine: 'InnoDB', charset: 'ascii', collate: 'ascii_bin' });
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT enrollment_id FROM MetaMarketingEnrollmentDestinationPlans LIMIT 1', { logging: false }
    );
    if (rows.length) throw new Error('Preserve Meta enrollment destination history. Roll back code only.');
    await queryInterface.dropTable(TABLE);
  },
};
