'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Enfoque alternativo: Mantener userId como foreign key al usuario de la aplicación
    // y usar metaUserId para el ID del usuario de Meta
    
    // Verificar si la columna metaUserId ya existe
    const tableDescription = await queryInterface.describeTable('MetaConnections');
    
    if (!tableDescription.metaUserId) {
      // Agregar columna metaUserId si no existe
      await queryInterface.addColumn('MetaConnections', 'metaUserId', {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'ID del usuario de Meta (número grande como string)'
      });
      console.log('✅ Columna metaUserId agregada');
    }

    // Cambiar metaUserId existente a VARCHAR(50) si ya existe pero es de otro tipo
    await queryInterface.changeColumn('MetaConnections', 'metaUserId', {
      type: Sequelize.STRING(50),
      allowNull: false,
      comment: 'ID del usuario de Meta (número grande como string)'
    });
    console.log('✅ Columna metaUserId configurada como VARCHAR(50)');

    // Mantener userId como INTEGER (foreign key a Usuarios.id_usuario)
    console.log('✅ userId mantenido como foreign key a Usuarios');
  },

  async down(queryInterface, Sequelize) {
    // Revertir cambios si es necesario
    const tableDescription = await queryInterface.describeTable('MetaConnections');
    
    if (tableDescription.metaUserId) {
      await queryInterface.removeColumn('MetaConnections', 'metaUserId');
      console.log('⚠️  Columna metaUserId eliminada');
    }
  }
};

