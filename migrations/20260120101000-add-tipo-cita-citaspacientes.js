'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('CitasPacientes', 'tipo_cita', {
      type: Sequelize.ENUM('primera_sin_trat', 'primera_con_trat', 'continuacion', 'urgencia', 'revision'),
      allowNull: false,
      defaultValue: 'continuacion'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('CitasPacientes', 'tipo_cita');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_CitasPacientes_tipo_cita";');
  }
};
