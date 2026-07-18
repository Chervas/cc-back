'use strict';

const TABLE = 'WebProjects';
const COLUMN = 'campaign_context';

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

module.exports = {
  TABLE,
  COLUMN,

  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.some((value) => tableNameOf(value) === TABLE)) {
      const error = new Error(`${TABLE} no existe`);
      error.code = 'web_campaign_context_migration_missing_dependency';
      throw error;
    }

    const description = await queryInterface.describeTable(TABLE);
    if (description[COLUMN]) {
      if (description[COLUMN].allowNull === false) {
        const error = new Error(`${TABLE}.${COLUMN} existe con un contrato incompatible`);
        error.code = 'web_campaign_context_migration_incompatible_column';
        throw error;
      }
      return;
    }

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Binding inmutable opcional a strategy/target de Marketing Campanas',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.some((value) => tableNameOf(value) === TABLE)) return;
    const description = await queryInterface.describeTable(TABLE);
    if (description[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
