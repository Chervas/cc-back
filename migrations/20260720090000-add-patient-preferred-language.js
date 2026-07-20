'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable('Pacientes');
    if (!definition.idioma_preferido) {
      await queryInterface.addColumn('Pacientes', 'idioma_preferido', {
        type: Sequelize.ENUM('es', 'ca', 'en'),
        allowNull: false,
        defaultValue: 'es',
        comment: 'Idioma de comunicaciones del paciente: es, ca o en',
      });
    }
  },

  async down(queryInterface) {
    const definition = await queryInterface.describeTable('Pacientes');
    if (definition.idioma_preferido) {
      await queryInterface.removeColumn('Pacientes', 'idioma_preferido');
    }
  },
};
