'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Cambiar la columna 'rol' a ENUM con los valores permitidos
    await queryInterface.changeColumn('Usuarios', 'rol', {
      type: Sequelize.ENUM('administrador', 'personaldeclinica', 'paciente'),
      allowNull: false,
      defaultValue: 'paciente'
    });

    
  },

  async down(queryInterface, Sequelize) {
    // 1. Eliminar la columna 'subrol'
    await queryInterface.removeColumn('Usuarios', 'subrol');

    // 2. Revertir el cambio de la columna 'rol' (asumiendo que antes era STRING)
    await queryInterface.changeColumn('Usuarios', 'rol', {
      type: Sequelize.STRING,
      allowNull: true
    });

    // Nota: Si tu SGBD es Postgres, es posible que debas eliminar manualmente los tipos ENUM
    // con queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Usuarios_rol";')
    // y 'DROP TYPE IF EXISTS "enum_Usuarios_subrol";'
    // dependiendo de cómo hayas configurado el proyecto.
  }
};
