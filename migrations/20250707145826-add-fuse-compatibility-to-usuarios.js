'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      console.log('🔄 Iniciando migración: Añadir campos de compatibilidad con Fuse...');
      
      // Añadir campo avatar
      await queryInterface.addColumn('Usuarios', 'avatar', {
        type: Sequelize.STRING(500),
        allowNull: true,
        comment: 'URL del avatar del usuario (compatibilidad con Fuse)'
      });
      console.log('✅ Campo avatar añadido');
      
      // Añadir campo status
      await queryInterface.addColumn('Usuarios', 'status', {
        type: Sequelize.ENUM('online', 'away', 'busy', 'offline'),
        allowNull: false,
        defaultValue: 'offline',
        comment: 'Estado del usuario (compatibilidad con Fuse)'
      });
      console.log('✅ Campo status añadido');
      
      // Añadir índice para status
      await queryInterface.addIndex('Usuarios', ['status'], {
        name: 'idx_usuarios_status'
      });
      console.log('✅ Índice para status añadido');
      
      console.log('🎉 Migración completada exitosamente');
      
    } catch (error) {
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      console.log('🔄 Revirtiendo migración: Eliminar campos de compatibilidad con Fuse...');
      
      // Eliminar índice
      await queryInterface.removeIndex('Usuarios', 'idx_usuarios_status');
      console.log('✅ Índice para status eliminado');
      
      // Eliminar campo status
      await queryInterface.removeColumn('Usuarios', 'status');
      console.log('✅ Campo status eliminado');
      
      // Eliminar campo avatar
      await queryInterface.removeColumn('Usuarios', 'avatar');
      console.log('✅ Campo avatar eliminado');
      
      console.log('🎉 Migración revertida exitosamente');
      
    } catch (error) {
      console.error('❌ Error revirtiendo migración:', error);
      throw error;
    }
  }
};