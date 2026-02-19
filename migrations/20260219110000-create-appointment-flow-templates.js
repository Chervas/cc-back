'use strict';

/**
 * Catálogo de plantillas de flujo de cita (P0).
 *
 * API esperada por frontend:
 * - GET/POST/PUT/DELETE /api/appointment-flow-templates
 * - Estructura { success, data }
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AppointmentFlowTemplates', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      discipline: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      version: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: '1.0',
      },
      steps: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      is_system: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Clinicas',
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'GruposClinicas',
          key: 'id_grupo',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('AppointmentFlowTemplates', ['discipline']);
    await queryInterface.addIndex('AppointmentFlowTemplates', ['clinic_id']);
    await queryInterface.addIndex('AppointmentFlowTemplates', ['group_id']);
    await queryInterface.addIndex('AppointmentFlowTemplates', ['is_system']);
    await queryInterface.addIndex('AppointmentFlowTemplates', ['is_active']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('AppointmentFlowTemplates', ['is_active']);
    await queryInterface.removeIndex('AppointmentFlowTemplates', ['is_system']);
    await queryInterface.removeIndex('AppointmentFlowTemplates', ['group_id']);
    await queryInterface.removeIndex('AppointmentFlowTemplates', ['clinic_id']);
    await queryInterface.removeIndex('AppointmentFlowTemplates', ['discipline']);
    await queryInterface.dropTable('AppointmentFlowTemplates');
  },
};
