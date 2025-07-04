'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('ClinicaServicio', 'estado_servicio', {
      type: Sequelize.ENUM('activo', 'pausa', 'pausar hasta', 'pausado hasta fecha'),
      allowNull: false
    });
  },

  down: async (queryInterface, Sequelize) => {
    // Revertir los cambios si es necesario
    await queryInterface.changeColumn('ClinicaServicio', 'estado_servicio', {
      type: Sequelize.ENUM('activo', 'pausa', 'pausado hasta fecha'),
      allowNull: false
    });
  }
};
