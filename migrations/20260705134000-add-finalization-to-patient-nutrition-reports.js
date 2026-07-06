'use strict';

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name))
    .includes(tableName);
}

async function addColumnIfMissing(queryInterface, Sequelize, tableName, columnName, definition) {
  if (!(await tableExists(queryInterface, tableName))) return;
  const description = await queryInterface.describeTable(tableName);
  if (description[columnName]) return;
  await queryInterface.addColumn(tableName, columnName, definition);
}

async function removeColumnIfExists(queryInterface, tableName, columnName) {
  if (!(await tableExists(queryInterface, tableName))) return;
  const description = await queryInterface.describeTable(tableName);
  if (!description[columnName]) return;
  await queryInterface.removeColumn(tableName, columnName);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, Sequelize, 'PatientNutritionReports', 'finalized_by', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Usuarios', key: 'id_usuario' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, Sequelize, 'PatientNutritionReports', 'finalized_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'PatientNutritionReports', 'finalized_at');
    await removeColumnIfExists(queryInterface, 'PatientNutritionReports', 'finalized_by');
  },
};
