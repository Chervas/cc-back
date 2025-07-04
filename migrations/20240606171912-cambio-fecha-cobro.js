'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn('HistorialDeServicios', 'fecha_cobro_servicio', 'fecha_cobro');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.renameColumn('HistorialDeServicios', 'fecha_cobro', 'fecha_cobro_servicio');
  }
};
