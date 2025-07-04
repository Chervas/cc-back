'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    /**
     * Añadir campos faltantes a la tabla Clinicas
     */
    
    // ✅ CAMPOS DE CONTACTO
    await queryInterface.addColumn('Clinicas', 'telefono', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'email', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'descripcion', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    
    // ✅ CAMPOS DE DIRECCIÓN
    await queryInterface.addColumn('Clinicas', 'direccion', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'codigo_postal', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'ciudad', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'provincia', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    await queryInterface.addColumn('Clinicas', 'pais', {
      type: Sequelize.STRING,
      allowNull: true
    });
    
    // ✅ CAMPO DE HORARIOS
    await queryInterface.addColumn('Clinicas', 'horario_atencion', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    
    // ✅ CAMPOS JSON PARA ESTRUCTURAS COMPLEJAS
    await queryInterface.addColumn('Clinicas', 'redes_sociales', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'JSON con redes sociales: {instagram, facebook, tiktok, linkedin, doctoralia}'
    });
    
    await queryInterface.addColumn('Clinicas', 'configuracion', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'JSON con configuración: {citas_online, notificaciones_email, notificaciones_sms}'
    });
  },

  async down (queryInterface, Sequelize) {
    /**
     * Revertir cambios - eliminar campos añadidos
     */
    
    // ✅ ELIMINAR CAMPOS DE CONTACTO
    await queryInterface.removeColumn('Clinicas', 'telefono');
    await queryInterface.removeColumn('Clinicas', 'email');
    await queryInterface.removeColumn('Clinicas', 'descripcion');
    
    // ✅ ELIMINAR CAMPOS DE DIRECCIÓN
    await queryInterface.removeColumn('Clinicas', 'direccion');
    await queryInterface.removeColumn('Clinicas', 'codigo_postal');
    await queryInterface.removeColumn('Clinicas', 'ciudad');
    await queryInterface.removeColumn('Clinicas', 'provincia');
    await queryInterface.removeColumn('Clinicas', 'pais');
    
    // ✅ ELIMINAR CAMPO DE HORARIOS
    await queryInterface.removeColumn('Clinicas', 'horario_atencion');
    
    // ✅ ELIMINAR CAMPOS JSON
    await queryInterface.removeColumn('Clinicas', 'redes_sociales');
    await queryInterface.removeColumn('Clinicas', 'configuracion');
  }
};

