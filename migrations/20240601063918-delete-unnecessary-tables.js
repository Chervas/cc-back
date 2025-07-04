'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Eliminar claves foráneas que referencian a la tabla usuarios
    await queryInterface.removeConstraint('usuarios_clinicas', 'usuarios_clinicas_ibfk_1');
    
    // Eliminar claves foráneas que referencian a otras tablas si es necesario
    // await queryInterface.removeConstraint('otra_tabla', 'nombre_de_la_clave_foranea');

    // Eliminar tablas innecesarias
    await queryInterface.dropTable('usuarios_clinicas');
    await queryInterface.dropTable('usuarios');
    await queryInterface.dropTable('clinica_servicio');
    await queryInterface.dropTable('clinicas_servicios');
    await queryInterface.dropTable('checklists');
    await queryInterface.dropTable('servicios_contratados');
    await queryInterface.dropTable('servicios_disponibles');
  },

  down: async (queryInterface, Sequelize) => {
    // Aquí puedes agregar la lógica para revertir los cambios si es necesario
  }
};
