'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable('Notifications');
    if (!definition.dedupe_key) {
      await queryInterface.addColumn('Notifications', 'dedupe_key', {
        type: Sequelize.STRING(191),
        allowNull: true,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    const definition = await queryInterface.describeTable('Notifications');
    if (definition.dedupe_key) {
      await queryInterface.removeColumn('Notifications', 'dedupe_key');
    }
  },
};
