'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Conversations', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      channel: {
        type: Sequelize.ENUM('whatsapp', 'instagram', 'internal'),
        allowNull: false,
        defaultValue: 'internal',
      },
      contact_id: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Pacientes',
          key: 'id_paciente',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      lead_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Leads',
          key: 'id',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      last_message_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      unread_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      last_inbound_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('Conversations', ['clinic_id', 'channel']);
    await queryInterface.addIndex('Conversations', ['contact_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('Conversations');
  },
};
