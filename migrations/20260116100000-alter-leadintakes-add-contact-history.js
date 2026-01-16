'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Añadir columna historial_contactos
    await queryInterface.addColumn('LeadIntakes', 'historial_contactos', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: []
    });

    // Añadir columnas de avisos
    await queryInterface.addColumn('LeadIntakes', 'es_paciente', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    await queryInterface.addColumn('LeadIntakes', 'suele_cancelar', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    await queryInterface.addColumn('LeadIntakes', 'no_acudio_cita', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    // Modificar el ENUM de status_lead para añadir 'citado'
    // MySQL requiere recrear el ENUM
    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM('nuevo', 'contactado', 'citado', 'convertido', 'descartado'),
      allowNull: false,
      defaultValue: 'nuevo'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('LeadIntakes', 'historial_contactos');
    await queryInterface.removeColumn('LeadIntakes', 'es_paciente');
    await queryInterface.removeColumn('LeadIntakes', 'suele_cancelar');
    await queryInterface.removeColumn('LeadIntakes', 'no_acudio_cita');
    
    // Revertir el ENUM
    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM('nuevo', 'contactado', 'convertido', 'descartado'),
      allowNull: false,
      defaultValue: 'nuevo'
    });
  }
};
