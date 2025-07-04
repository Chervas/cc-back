'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Leads', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      nombre: {
        type: Sequelize.STRING,
        allowNull: true
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true
      },
      telefono: {
        type: Sequelize.STRING,
        allowNull: true
      },
      facebook_lead_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      form_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      fecha_creacion: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW
      },
      datos_adicionales: {
        type: Sequelize.JSON,
        allowNull: true
      },
      estado: {
        type: Sequelize.ENUM('NUEVO', 'CONTACTADO', 'CONVERTIDO', 'DESCARTADO'),
        defaultValue: 'NUEVO'
      },
      notas: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      campana_id: {
        type: Sequelize.INTEGER,
        //references: {
          //model: 'Campanas',
          //key: 'id'
        //},
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        //references: {
        //  model: 'Clinicas',
        //  key: 'id'
        //},
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('Leads');
  }
};
