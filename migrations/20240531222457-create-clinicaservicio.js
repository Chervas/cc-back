'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ClinicaServicios', {
      id_servicio_asignado: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      id_clinica: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        }
      },
      nombre_clinica: {
        type: Sequelize.STRING,
        allowNull: false
      },
      id_servicio: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Servicios',
          key: 'id_servicio'
        }
      },
      nombre_servicio: {
        type: Sequelize.STRING,
        allowNull: false
      },
      descripcion_servicio: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      descripcion_detallada_servicio: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      precio_servicio: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      iva_servicio: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      servicio_recurrente: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      fecha_cobro: {
        type: Sequelize.DATE,
        allowNull: true
      },
      precio_especial: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      empresa_servicio: {
        type: Sequelize.STRING,
        allowNull: false
      },
      estado_servicio: {
        type: Sequelize.ENUM('activo', 'pausa', 'pausado hasta fecha'),
        allowNull: false
      },
      fecha_pausa: {
        type: Sequelize.DATE,
        allowNull: true
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('ClinicaServicios');
  }
};
