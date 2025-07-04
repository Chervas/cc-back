'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Facturas', {
      id_factura: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      num_factura: {
        type: Sequelize.STRING,
        allowNull: false
      },
      contenido_factura: {
        type: Sequelize.JSON,
        allowNull: false
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
      base_imponible_total: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      impuestos_total: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      precio_con_impuestos_total: {
        type: Sequelize.FLOAT,
        allowNull: false
      },
      factura_enviada: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      factura_enviada_fecha: {
        type: Sequelize.DATE,
        allowNull: true
      },
      factura_conciliada: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      factura_conciliada_fecha: {
        type: Sequelize.DATE,
        allowNull: true
      },
      factura_cobrada: {
        type: Sequelize.BOOLEAN,
        allowNull: false
      },
      factura_cobrada_fecha: {
        type: Sequelize.DATE,
        allowNull: true
      },
      denominacion_social: {
        type: Sequelize.STRING,
        allowNull: false
      },
      incluida_remesa: {
        type: Sequelize.INTEGER,
        allowNull: false
      }
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('Facturas');
  }
};
