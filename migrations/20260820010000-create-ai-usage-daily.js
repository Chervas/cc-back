'use strict';

const TABLE = 'AiUsageDaily';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map(String).includes(TABLE)) return;

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      usage_date: { type: Sequelize.DATEONLY, allowNull: false },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      model: { type: Sequelize.STRING(160), allowNull: false },
      use_case: { type: Sequelize.STRING(80), allowNull: false },
      request_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      success_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      error_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      fallback_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      input_tokens: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      output_tokens: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      latency_ms_total: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      estimated_cost_usd: { type: Sequelize.DECIMAL(14, 6), allowNull: false, defaultValue: 0 },
      last_status: { type: Sequelize.STRING(32), allowNull: true },
      last_error_code: { type: Sequelize.STRING(100), allowNull: true },
      last_used_at: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex(TABLE, ['usage_date', 'provider', 'model', 'use_case'], {
      unique: true,
      name: 'uq_ai_usage_daily_scope',
    });
    await queryInterface.addIndex(TABLE, ['usage_date', 'provider'], {
      name: 'idx_ai_usage_daily_provider',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (tables.map(String).includes(TABLE)) await queryInterface.dropTable(TABLE);
  },
};
