'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Campaigns', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      nombre: { type: Sequelize.STRING(255), allowNull: false },
      tipo: { type: Sequelize.ENUM('meta_ads', 'google_ads', 'web_snippet', 'local_services'), allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      campaign_id_externo: { type: Sequelize.STRING(128), allowNull: true },
      gestionada: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      activa: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      fecha_inicio: { type: Sequelize.DATE, allowNull: true },
      fecha_fin: { type: Sequelize.DATE, allowNull: true },
      presupuesto: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      total_leads: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      gasto: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      cpl: { type: Sequelize.DECIMAL(12, 2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('Campaigns', { name: 'idx_campaigns_clinica', fields: ['clinica_id'] });
    await queryInterface.addIndex('Campaigns', { name: 'idx_campaigns_grupo', fields: ['grupo_clinica_id'] });
    await queryInterface.addIndex('Campaigns', { name: 'idx_campaigns_tipo', fields: ['tipo'] });
    await queryInterface.addIndex('Campaigns', { name: 'idx_campaigns_gestionada', fields: ['gestionada'] });
    await queryInterface.addIndex('Campaigns', { name: 'idx_campaigns_activa', fields: ['activa'] });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Campaigns', 'idx_campaigns_activa');
    await queryInterface.removeIndex('Campaigns', 'idx_campaigns_gestionada');
    await queryInterface.removeIndex('Campaigns', 'idx_campaigns_tipo');
    await queryInterface.removeIndex('Campaigns', 'idx_campaigns_grupo');
    await queryInterface.removeIndex('Campaigns', 'idx_campaigns_clinica');
    await queryInterface.dropTable('Campaigns');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Campaigns_tipo";');
  }
};
