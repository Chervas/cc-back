'use strict';

const TABLE = 'AiUsageDaily';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes(TABLE)) return;

    const description = await queryInterface.describeTable(TABLE);
    if (!description.scope_key) {
      await queryInterface.addColumn(TABLE, 'scope_key', {
        type: Sequelize.STRING(64),
        allowNull: false,
        defaultValue: 'global',
        after: 'use_case',
      });
    }
    if (!description.clinic_id) {
      await queryInterface.addColumn(TABLE, 'clinic_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        after: 'scope_key',
      });
    }
    if (!description.group_id) {
      await queryInterface.addColumn(TABLE, 'group_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
        after: 'clinic_id',
      });
    }

    const indexes = await queryInterface.showIndex(TABLE);
    const names = new Set(indexes.map((index) => index.name));
    if (names.has('uq_ai_usage_daily_scope')) {
      await queryInterface.removeIndex(TABLE, 'uq_ai_usage_daily_scope');
    }
    await queryInterface.addIndex(TABLE, ['usage_date', 'provider', 'model', 'use_case', 'scope_key'], {
      unique: true,
      name: 'uq_ai_usage_daily_scope',
    });
    if (!names.has('idx_ai_usage_daily_clinic')) {
      await queryInterface.addIndex(TABLE, ['usage_date', 'clinic_id'], {
        name: 'idx_ai_usage_daily_clinic',
      });
    }
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes(TABLE)) return;
    const indexes = await queryInterface.showIndex(TABLE);
    const names = new Set(indexes.map((index) => index.name));
    if (names.has('idx_ai_usage_daily_clinic')) await queryInterface.removeIndex(TABLE, 'idx_ai_usage_daily_clinic');
    if (names.has('uq_ai_usage_daily_scope')) await queryInterface.removeIndex(TABLE, 'uq_ai_usage_daily_scope');
    const description = await queryInterface.describeTable(TABLE);
    if (description.group_id) await queryInterface.removeColumn(TABLE, 'group_id');
    if (description.clinic_id) await queryInterface.removeColumn(TABLE, 'clinic_id');
    if (description.scope_key) await queryInterface.removeColumn(TABLE, 'scope_key');
    await queryInterface.addIndex(TABLE, ['usage_date', 'provider', 'model', 'use_case'], {
      unique: true,
      name: 'uq_ai_usage_daily_scope',
    });
  },
};
