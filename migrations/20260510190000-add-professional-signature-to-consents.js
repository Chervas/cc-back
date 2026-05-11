'use strict';

async function addColumnIfMissing(queryInterface, tableName, columnName, definition) {
  const table = await queryInterface.describeTable(tableName);
  if (!table[columnName]) {
    await queryInterface.addColumn(tableName, columnName, definition);
  }
}

async function removeColumnIfExists(queryInterface, tableName, columnName) {
  const table = await queryInterface.describeTable(tableName);
  if (table[columnName]) {
    await queryInterface.removeColumn(tableName, columnName);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'PatientConsentDocuments', 'professional_signed_by', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'PatientConsentDocuments', 'professional_signed_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'PatientConsentDocuments', 'professional_signed_at');
    await removeColumnIfExists(queryInterface, 'PatientConsentDocuments', 'professional_signed_by');
  },
};
