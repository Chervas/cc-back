'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('HistorialDeServicios', 'descripcion_servicio', {
      type: Sequelize.TEXT,
      allowNull: false,
      defaultValue: ''
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('HistorialDeServicios', 'descripcion_servicio');
  }
};
