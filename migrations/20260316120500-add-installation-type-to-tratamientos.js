'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'Tratamientos',
        'tipo_instalacion_requerida',
        {
          type: Sequelize.ENUM('box', 'quirofano', 'sala', 'consulta', 'laboratorio', 'sala_pruebas', 'sala_polivalente', 'otro'),
          allowNull: true,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('Tratamientos', 'tipo_instalacion_requerida', { transaction });
    });
  },
};
