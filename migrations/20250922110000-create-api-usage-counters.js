'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ApiUsageCounters', {
      provider: { type: Sequelize.STRING(32), primaryKey: true },
      usage_date: { type: Sequelize.DATEONLY, allowNull: false },
      request_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      usage_pct: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 0 },
      pause_until: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ApiUsageCounters');
  }
};
