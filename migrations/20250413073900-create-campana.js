'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Campanas', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      nombre: {
        type: Sequelize.STRING,
        allowNull: false
      },
      campaign_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      estado: {
        type: Sequelize.ENUM('ACTIVE', 'PAUSED', 'DELETED'),
        defaultValue: 'ACTIVE'
      },
      gastoTotal: {
        type: Sequelize.DECIMAL(10, 2),
        defaultValue: 0
      },
      fechaInicio: {
        type: Sequelize.DATE,
        allowNull: true
      },
      fechaFin: {
        type: Sequelize.DATE,
        allowNull: true
      },
      leads: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      preset: {
        type: Sequelize.STRING,
        allowNull: true
      },
      frecuenciaMaxima: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: true
      },
      reproducciones75: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      reproduccionesTotales: {
        type: Sequelize.INTEGER,
        defaultValue: 0
      },
      curvaVisionado: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      orden: {
        type: Sequelize.STRING,
        allowNull: true
      },
      precioPorLead: {
        type: Sequelize.DECIMAL(10, 2),
        defaultValue: 0
      },
      mostrar: {
        type: Sequelize.BOOLEAN,
        defaultValue: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        references: {
          model: 'Clinicas',
          key: 'id'
        },
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
    await queryInterface.dropTable('Campanas');
  }
};
