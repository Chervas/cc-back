'use strict';

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables
    .map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name))
    .includes(tableName);
}

async function columnExists(queryInterface, tableName, columnName) {
  if (!(await tableExists(queryInterface, tableName))) return false;
  const description = await queryInterface.describeTable(tableName);
  return Boolean(description[columnName]);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, 'PatientNutritionReports', 'snapshot_html'))) return;
    await queryInterface.changeColumn('PatientNutritionReports', 'snapshot_html', {
      type: Sequelize.TEXT('medium'),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, 'PatientNutritionReports', 'snapshot_html'))) return;
    await queryInterface.changeColumn('PatientNutritionReports', 'snapshot_html', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },
};
