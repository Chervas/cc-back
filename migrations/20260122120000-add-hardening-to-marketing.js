'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // LeadIntakes: extender estados y añadir campos de hardening
    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM('nuevo', 'contactado', 'esperando_info', 'info_recibida', 'citado', 'acudio_cita', 'convertido', 'descartado'),
      allowNull: false,
      defaultValue: 'nuevo'
    });

    await queryInterface.addColumn('LeadIntakes', 'agenda_ocupada', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    await queryInterface.addColumn('LeadIntakes', 'info_requerida', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: []
    });

    await queryInterface.addColumn('LeadIntakes', 'info_recibida_items', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: []
    });

    await queryInterface.addColumn('LeadIntakes', 'cita_propuesta', {
      type: Sequelize.JSON,
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'consent_basis', {
      type: Sequelize.ENUM('contract', 'legitimate_interest', 'consent'),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'consent_captured_at', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'consent_source', {
      type: Sequelize.STRING(255),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'consent_version', {
      type: Sequelize.STRING(64),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'external_source', {
      type: Sequelize.STRING(64),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'external_id', {
      type: Sequelize.STRING(128),
      allowNull: true
    });

    await queryInterface.addColumn('LeadIntakes', 'intake_payload_hash', {
      type: Sequelize.STRING(64),
      allowNull: true
    });

    await queryInterface.addIndex('LeadIntakes', {
      name: 'uniq_leadintakes_external_source_id',
      fields: ['external_source', 'external_id'],
      unique: true
    });

    await queryInterface.addIndex('LeadIntakes', {
      name: 'idx_leadintakes_payload_hash',
      fields: ['intake_payload_hash']
    });

    await queryInterface.addIndex('LeadIntakes', {
      name: 'idx_leadintakes_status_created',
      fields: ['status_lead', 'created_at']
    });

    // LeadContactAttempts
    await queryInterface.createTable('LeadContactAttempts', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      lead_intake_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'LeadIntakes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      usuario_id: { type: Sequelize.INTEGER, allowNull: true },
      canal: {
        type: Sequelize.ENUM('llamada', 'whatsapp', 'email', 'dm', 'otro'),
        allowNull: false,
        defaultValue: 'llamada'
      },
      motivo: { type: Sequelize.STRING(128), allowNull: true },
      notas: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('LeadContactAttempts', {
      name: 'idx_lead_contact_attempts_lead_created',
      fields: ['lead_intake_id', 'created_at']
    });

    // LeadFlowInstances
    await queryInterface.createTable('LeadFlowInstances', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      lead_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'LeadIntakes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      flow_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'AutomationFlows', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      paso_actual: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      datos_recopilados: { type: Sequelize.JSON, allowNull: true, defaultValue: {} },
      historial_acciones: { type: Sequelize.JSON, allowNull: true, defaultValue: [] },
      estado: {
        type: Sequelize.ENUM('activo', 'completado', 'cancelado'),
        allowNull: false,
        defaultValue: 'activo'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('LeadFlowInstances', {
      name: 'idx_lead_flow_instances_lead',
      fields: ['lead_id']
    });
    await queryInterface.addIndex('LeadFlowInstances', {
      name: 'idx_lead_flow_instances_flow',
      fields: ['flow_id']
    });

    // AppointmentHolds
    await queryInterface.createTable('AppointmentHolds', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      lead_intake_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'LeadIntakes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      doctor_id: { type: Sequelize.INTEGER, allowNull: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      inicio: { type: Sequelize.DATE, allowNull: false },
      fin: { type: Sequelize.DATE, allowNull: false },
      estado: {
        type: Sequelize.ENUM('propuesto', 'confirmado', 'expirado', 'cancelado'),
        allowNull: false,
        defaultValue: 'propuesto'
      },
      motivo: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('AppointmentHolds', {
      name: 'idx_appointment_holds_clinica_doctor_time',
      fields: ['clinica_id', 'doctor_id', 'inicio', 'fin']
    });
    await queryInterface.addIndex('AppointmentHolds', {
      name: 'idx_appointment_holds_lead_estado',
      fields: ['lead_intake_id', 'estado']
    });

    // CitasPacientes: nuevos estados y campos de soft reservation
    await queryInterface.changeColumn('CitasPacientes', 'estado', {
      type: Sequelize.ENUM('pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio'),
      allowNull: false,
      defaultValue: 'pendiente'
    });

    await queryInterface.addColumn('CitasPacientes', 'es_provisional', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
      defaultValue: false
    });

    await queryInterface.addColumn('CitasPacientes', 'hold_expires_at', {
      type: Sequelize.DATE,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    // Revertir CitasPacientes
    await queryInterface.removeColumn('CitasPacientes', 'hold_expires_at');
    await queryInterface.removeColumn('CitasPacientes', 'es_provisional');
    await queryInterface.changeColumn('CitasPacientes', 'estado', {
      type: Sequelize.ENUM('pendiente', 'confirmada', 'cancelada'),
      allowNull: false,
      defaultValue: 'pendiente'
    });

    // AppointmentHolds
    await queryInterface.removeIndex('AppointmentHolds', 'idx_appointment_holds_lead_estado');
    await queryInterface.removeIndex('AppointmentHolds', 'idx_appointment_holds_clinica_doctor_time');
    await queryInterface.dropTable('AppointmentHolds');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AppointmentHolds_estado";');

    // LeadFlowInstances
    await queryInterface.removeIndex('LeadFlowInstances', 'idx_lead_flow_instances_flow');
    await queryInterface.removeIndex('LeadFlowInstances', 'idx_lead_flow_instances_lead');
    await queryInterface.dropTable('LeadFlowInstances');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadFlowInstances_estado";');

    // LeadContactAttempts
    await queryInterface.removeIndex('LeadContactAttempts', 'idx_lead_contact_attempts_lead_created');
    await queryInterface.dropTable('LeadContactAttempts');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadContactAttempts_canal";');

    // LeadIntakes indexes
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_status_created');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_payload_hash');
    await queryInterface.removeIndex('LeadIntakes', 'uniq_leadintakes_external_source_id');

    // LeadIntakes columns
    await queryInterface.removeColumn('LeadIntakes', 'intake_payload_hash');
    await queryInterface.removeColumn('LeadIntakes', 'external_id');
    await queryInterface.removeColumn('LeadIntakes', 'external_source');
    await queryInterface.removeColumn('LeadIntakes', 'consent_version');
    await queryInterface.removeColumn('LeadIntakes', 'consent_source');
    await queryInterface.removeColumn('LeadIntakes', 'consent_captured_at');
    await queryInterface.removeColumn('LeadIntakes', 'consent_basis');
    await queryInterface.removeColumn('LeadIntakes', 'cita_propuesta');
    await queryInterface.removeColumn('LeadIntakes', 'info_recibida_items');
    await queryInterface.removeColumn('LeadIntakes', 'info_requerida');
    await queryInterface.removeColumn('LeadIntakes', 'agenda_ocupada');

    await queryInterface.changeColumn('LeadIntakes', 'status_lead', {
      type: Sequelize.ENUM('nuevo', 'contactado', 'citado', 'convertido', 'descartado'),
      allowNull: false,
      defaultValue: 'nuevo'
    });

    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_status_lead";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_consent_basis";');
  }
};
