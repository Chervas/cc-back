'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'Tratamientos',
        'asignacion_instalacion_tipo',
        {
          type: Sequelize.ENUM('cualquiera', 'especificas'),
          allowNull: false,
          defaultValue: 'cualquiera',
        },
        { transaction }
      );

      await queryInterface.addColumn(
        'Tratamientos',
        'instalaciones_habilitadas',
        {
          type: Sequelize.JSON,
          allowNull: true,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('Tratamientos', 'instalaciones_habilitadas', { transaction });
      await queryInterface.removeColumn('Tratamientos', 'asignacion_instalacion_tipo', { transaction });
    });
  },
};
