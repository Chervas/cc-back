'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    console.log('🔄 Verificando campos de compatibilidad con Fuse...');
    
    try {
      // Obtener la descripción de la tabla para ver qué columnas existen
      const tableDescription = await queryInterface.describeTable('Usuarios');
      
      // Verificar si avatar existe
      if (!tableDescription.avatar) {
        console.log('➕ Añadiendo campo avatar...');
        await queryInterface.addColumn('Usuarios', 'avatar', {
          type: Sequelize.STRING(500),
          allowNull: true,
          comment: 'URL del avatar del usuario (compatibilidad con Fuse)'
        });
      } else {
        console.log('✅ Campo avatar ya existe');
      }
      
      // Verificar si status existe
      if (!tableDescription.status) {
        console.log('➕ Añadiendo campo status...');
        await queryInterface.addColumn('Usuarios', 'status', {
          type: Sequelize.ENUM('online', 'away', 'busy', 'offline'),
          allowNull: true,
          defaultValue: 'offline',
          comment: 'Estado del usuario (compatibilidad con Fuse)'
        });
      } else {
        console.log('✅ Campo status ya existe');
      }
      
      console.log('✅ Verificación completada exitosamente');
      
    } catch (error) {
      console.error('❌ Error en verificación:', error.message);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    console.log('🔄 Revirtiendo campos de compatibilidad con Fuse...');
    
    try {
      // Obtener la descripción de la tabla
      const tableDescription = await queryInterface.describeTable('Usuarios');
      
      // Eliminar status si existe
      if (tableDescription.status) {
        console.log('➖ Eliminando campo status...');
        await queryInterface.removeColumn('Usuarios', 'status');
      }
      
      // Eliminar avatar si existe
      if (tableDescription.avatar) {
        console.log('➖ Eliminando campo avatar...');
        await queryInterface.removeColumn('Usuarios', 'avatar');
      }
      
      console.log('✅ Reversión completada exitosamente');
      
    } catch (error) {
      console.error('❌ Error en reversión:', error.message);
      throw error;
    }
  }
};
