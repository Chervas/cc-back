'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('sync_logs', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      job_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Tipo de trabajo de sincronización'
      },
      status: {
        type: Sequelize.ENUM('pending', 'running', 'completed', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'Estado del proceso de sincronización'
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'ID de la clínica relacionada (si aplica)'
      },
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'ClinicMetaAssets',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'ID del activo relacionado (si aplica)'
      },
      asset_type: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Tipo de activo relacionado'
      },
      start_time: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Hora de inicio del proceso'
      },
      end_time: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Hora de finalización del proceso'
      },
      records_processed: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        comment: 'Número de registros procesados'
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
    await queryInterface.addIndex('sync_logs', ['job_type', 'status'], {
      name: 'idx_sync_logs_job_type_status'
    });

    await queryInterface.addIndex('sync_logs', ['clinica_id', 'asset_id'], {
      name: 'idx_sync_logs_clinica_asset'
    });

    await queryInterface.addIndex('sync_logs', ['created_at'], {
      name: 'idx_sync_logs_created_at'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('sync_logs');
  }
};

