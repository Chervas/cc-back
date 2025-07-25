'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('token_validations', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      connection_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'MetaConnections',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
        comment: 'ID de la conexión Meta validada'
      },
      validation_date: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Fecha y hora de la validación'
      },
      status: {
        type: Sequelize.ENUM('valid', 'invalid', 'expired'),
        allowNull: false,
        comment: 'Resultado de la validación del token'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Mensaje de error (si aplica)'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Crear índices para optimizar consultas
    await queryInterface.addIndex('token_validations', ['connection_id', 'validation_date'], {
      name: 'idx_token_validations_connection_date'
    });

    await queryInterface.addIndex('token_validations', ['status'], {
      name: 'idx_token_validations_status'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('token_validations');
  }
};

