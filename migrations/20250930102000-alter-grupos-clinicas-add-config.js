'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('GruposClinicas', 'ads_assignment_mode', {
      type: Sequelize.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    });

    await queryInterface.addColumn('GruposClinicas', 'ads_assignment_delimiter', {
      type: Sequelize.STRING(8),
      allowNull: false,
      defaultValue: '**'
    });

    await queryInterface.addColumn('GruposClinicas', 'ads_assignment_last_run', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addColumn('GruposClinicas', 'web_assignment_mode', {
      type: Sequelize.ENUM('manual', 'automatic'),
      allowNull: false,
      defaultValue: 'automatic'
    });

    await queryInterface.addColumn('GruposClinicas', 'web_primary_url', {
      type: Sequelize.STRING(512),
      allowNull: true
    });

    await queryInterface.addColumn('GruposClinicas', 'web_assignment_updated_at', {
      type: Sequelize.DATE,
      allowNull: true
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('GruposClinicas', 'web_assignment_updated_at');
    await queryInterface.removeColumn('GruposClinicas', 'web_primary_url');
    await queryInterface.removeColumn('GruposClinicas', 'web_assignment_mode');
    await queryInterface.removeColumn('GruposClinicas', 'ads_assignment_last_run');
    await queryInterface.removeColumn('GruposClinicas', 'ads_assignment_delimiter');
    await queryInterface.removeColumn('GruposClinicas', 'ads_assignment_mode');
  }
};
