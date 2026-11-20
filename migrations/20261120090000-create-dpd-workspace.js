'use strict';

module.exports = {
  async up(queryInterface, S) {
    await queryInterface.createTable('DpdWorkspaceEntries', {
      key: { type: S.STRING(96), primaryKey: true },
      value: { type: S.JSON, allowNull: false },
      revision: { type: S.INTEGER.UNSIGNED, allowNull: false },
      updated_by: { type: S.INTEGER.UNSIGNED, allowNull: false },
      updated_at: { type: S.DATE, allowNull: false },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('DpdWorkspaceEntries');
  },
};
