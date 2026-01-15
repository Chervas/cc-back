'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CampaignRequests', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      campaign_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Campaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      estado: {
        type: Sequelize.ENUM('pendiente_aceptacion', 'en_creacion', 'solicitar_cambio', 'aprobada', 'activa', 'pausada', 'finalizada'),
        allowNull: false,
        defaultValue: 'pendiente_aceptacion'
      },
      solicitud: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('CampaignRequests', { name: 'idx_campaign_requests_clinica', fields: ['clinica_id'] });
    await queryInterface.addIndex('CampaignRequests', { name: 'idx_campaign_requests_estado', fields: ['estado'] });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('CampaignRequests', 'idx_campaign_requests_estado');
    await queryInterface.removeIndex('CampaignRequests', 'idx_campaign_requests_clinica');
    await queryInterface.dropTable('CampaignRequests');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_CampaignRequests_estado";');
  }
};
