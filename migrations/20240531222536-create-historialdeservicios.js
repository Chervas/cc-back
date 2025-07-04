'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('HistorialDeServicios', {
      id_servicio_asignado: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      fecha_cobro_servicio: {
        type: Sequelize.DATE,
        allowNull: false
      },
      id_clinica: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      nombre_clinica: {
        type: Sequelize.STRING,
        allowNull: false
      },
      nombre_servicio: {
        type: Sequelize.STRING,
        allowNull: false
      },
      descripcion_detallada_servicio: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      servicio_recurrente: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      precio_servicio: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      iva_servicio: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      num_factura_asociada: {
        type: Sequelize.STRING,
        allowNull: false
      },
      empresa_servicio: {
        type: Sequelize.STRING,
        allowNull: false
      },
      datos_fiscales_clinica: {
        type: Sequelize.JSON,
        allowNull: false
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('HistorialDeServicios');
  }
};
