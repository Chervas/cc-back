'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MessageTemplates', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      nombre: { type: Sequelize.STRING(255), allowNull: false },
      tipo: { type: Sequelize.ENUM('whatsapp', 'email', 'sms'), allowNull: false },
      contenido: { type: Sequelize.TEXT, allowNull: false },
      estado: { type: Sequelize.ENUM('pendiente', 'aprobada', 'rechazada'), allowNull: false, defaultValue: 'pendiente' },
      uso: { type: Sequelize.STRING(128), allowNull: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('AutomationFlows', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      nombre: { type: Sequelize.STRING(255), allowNull: false },
      disparador: { type: Sequelize.STRING(128), allowNull: false },
      acciones: { type: Sequelize.JSON, allowNull: false },
      activo: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.createTable('MessageLogs', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      template_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'MessageTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      flow_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'AutomationFlows', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      destinatario: { type: Sequelize.STRING(255), allowNull: false },
      tipo: { type: Sequelize.ENUM('whatsapp', 'email', 'sms'), allowNull: false },
      estado: { type: Sequelize.ENUM('enviado', 'entregado', 'leido', 'fallido'), allowNull: false, defaultValue: 'enviado' },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('MessageTemplates', { name: 'idx_templates_tipo', fields: ['tipo'] });
    await queryInterface.addIndex('AutomationFlows', { name: 'idx_flows_disparador', fields: ['disparador'] });
    await queryInterface.addIndex('MessageLogs', { name: 'idx_messagelogs_tipo', fields: ['tipo'] });
    await queryInterface.addIndex('MessageLogs', { name: 'idx_messagelogs_estado', fields: ['estado'] });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MessageLogs', 'idx_messagelogs_estado');
    await queryInterface.removeIndex('MessageLogs', 'idx_messagelogs_tipo');
    await queryInterface.removeIndex('AutomationFlows', 'idx_flows_disparador');
    await queryInterface.removeIndex('MessageTemplates', 'idx_templates_tipo');
    await queryInterface.dropTable('MessageLogs');
    await queryInterface.dropTable('AutomationFlows');
    await queryInterface.dropTable('MessageTemplates');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_MessageTemplates_tipo";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_MessageTemplates_estado";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AutomationFlows_disparador";'); // safe drop
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_MessageLogs_tipo";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_MessageLogs_estado";');
  }
};
