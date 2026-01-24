'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'assignmentScope', {
      type: Sequelize.ENUM('unassigned', 'clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic',
      comment: 'Indica si el activo se asigna a una clínica específica, al grupo completo o queda sin asignar',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'assignmentScope', {
      type: Sequelize.ENUM('clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic',
      comment: 'Indica si el activo se asigna a una clínica específica o al grupo completo',
    });
  },
};
