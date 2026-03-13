'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AppointmentFlowInstances', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      cita_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: {
          model: 'CitasPacientes',
          key: 'id_cita',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Pacientes',
          key: 'id_paciente',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      tratamiento_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Tratamientos',
          key: 'id_tratamiento',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      template_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'AppointmentFlowTemplates',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      template_version: {
        type: Sequelize.STRING(20),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('running', 'waiting', 'completed', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'running',
      },
      current_step_index: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      current_step_type: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      current_step_label: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      current_state: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      agenda_icon: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      next_action_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_transition_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      context_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('AppointmentFlowInstances', ['clinica_id'], {
      name: 'idx_afi_clinica',
    });
    await queryInterface.addIndex('AppointmentFlowInstances', ['status'], {
      name: 'idx_afi_status',
    });
    await queryInterface.addIndex('AppointmentFlowInstances', ['next_action_at'], {
      name: 'idx_afi_next_action_at',
    });
    await queryInterface.addIndex('AppointmentFlowInstances', ['template_id'], {
      name: 'idx_afi_template',
    });

    await queryInterface.createTable('AppointmentFlowInstanceLogs', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      flow_instance_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'AppointmentFlowInstances',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      cita_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'CitasPacientes',
          key: 'id_cita',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      step_index: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      step_type: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      step_label: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      event_type: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      status_before: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      status_after: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex('AppointmentFlowInstanceLogs', ['flow_instance_id'], {
      name: 'idx_afil_flow_instance',
    });
    await queryInterface.addIndex('AppointmentFlowInstanceLogs', ['cita_id'], {
      name: 'idx_afil_cita',
    });
    await queryInterface.addIndex('AppointmentFlowInstanceLogs', ['created_at'], {
      name: 'idx_afil_created_at',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('AppointmentFlowInstanceLogs', 'idx_afil_created_at');
    await queryInterface.removeIndex('AppointmentFlowInstanceLogs', 'idx_afil_cita');
    await queryInterface.removeIndex('AppointmentFlowInstanceLogs', 'idx_afil_flow_instance');
    await queryInterface.dropTable('AppointmentFlowInstanceLogs');

    await queryInterface.removeIndex('AppointmentFlowInstances', 'idx_afi_template');
    await queryInterface.removeIndex('AppointmentFlowInstances', 'idx_afi_next_action_at');
    await queryInterface.removeIndex('AppointmentFlowInstances', 'idx_afi_status');
    await queryInterface.removeIndex('AppointmentFlowInstances', 'idx_afi_clinica');
    await queryInterface.dropTable('AppointmentFlowInstances');

    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AppointmentFlowInstances_status";');
  },
};
