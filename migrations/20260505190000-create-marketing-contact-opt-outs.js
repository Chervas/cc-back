'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingContactOptOuts', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      phone: { type: Sequelize.STRING(64), allowNull: true },
      phone_digits: { type: Sequelize.STRING(32), allowNull: false },
      channel: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'whatsapp' },
      scope: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'marketing' },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
      reason_text: { type: Sequelize.TEXT, allowNull: true },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'whatsapp_inbound' },
      trigger_message_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Messages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      inbound_message_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Messages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      trigger_list_id: { type: Sequelize.INTEGER, allowNull: true },
      trigger_item_id: { type: Sequelize.INTEGER, allowNull: true },
      trigger_objective_id: { type: Sequelize.STRING(64), allowNull: true },
      opted_out_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('MarketingContactOptOuts', ['clinica_id', 'phone_digits', 'channel', 'scope', 'status'], {
      name: 'idx_marketing_contact_optouts_scope_phone',
      unique: true,
    });
    await queryInterface.addIndex('MarketingContactOptOuts', ['paciente_id', 'channel', 'status'], {
      name: 'idx_marketing_contact_optouts_patient',
    });
    await queryInterface.addIndex('MarketingContactOptOuts', ['trigger_list_id'], {
      name: 'idx_marketing_contact_optouts_trigger_list',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MarketingContactOptOuts', 'idx_marketing_contact_optouts_trigger_list');
    await queryInterface.removeIndex('MarketingContactOptOuts', 'idx_marketing_contact_optouts_patient');
    await queryInterface.removeIndex('MarketingContactOptOuts', 'idx_marketing_contact_optouts_scope_phone');
    await queryInterface.dropTable('MarketingContactOptOuts');
  },
};
