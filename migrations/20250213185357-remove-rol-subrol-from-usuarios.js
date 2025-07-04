'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Eliminar las columnas 'rol' y 'subrol' de la tabla 'Usuarios'
    await queryInterface.removeColumn('Usuarios', 'rol');
    await queryInterface.removeColumn('Usuarios', 'subrol');
  },

  async down(queryInterface, Sequelize) {
    // Volver a agregar las columnas en caso de rollback
    await queryInterface.addColumn('Usuarios', 'rol', {
      type: Sequelize.ENUM('administrador', 'personaldeclinica', 'paciente'),
      allowNull: false,
      defaultValue: 'paciente'
    });

    await queryInterface.addColumn('Usuarios', 'subrol', {
      type: Sequelize.ENUM('propietario', 'doctor', 'auxiliar'),
      allowNull: true,
      defaultValue: null
    });
  }
};
