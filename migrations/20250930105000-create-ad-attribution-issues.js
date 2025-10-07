'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AdAttributionIssues', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      provider: { type: Sequelize.ENUM('meta', 'google'), allowNull: false },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: true },
      customer_id: { type: Sequelize.STRING(64), allowNull: true },
      entity_level: { type: Sequelize.ENUM('campaign', 'adset', 'ad', 'ad_group', 'asset_group'), allowNull: false },
      entity_id: { type: Sequelize.STRING(128), allowNull: false },
      campaign_id: { type: Sequelize.STRING(64), allowNull: true },
      campaign_name: { type: Sequelize.STRING(256), allowNull: true },
      adset_name: { type: Sequelize.STRING(256), allowNull: true },
      detected_tokens: { type: Sequelize.JSON, allowNull: true },
      match_candidates: { type: Sequelize.JSON, allowNull: true },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'GruposClinicas',
          key: 'id_grupo'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      status: { type: Sequelize.ENUM('open', 'resolved'), allowNull: false, defaultValue: 'open' },
      last_seen_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      resolved_at: { type: Sequelize.DATE, allowNull: true },
      resolution_note: { type: Sequelize.STRING(512), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('AdAttributionIssues', {
      name: 'uniq_ad_issue_provider_entity',
      unique: true,
      fields: ['provider', 'entity_level', 'entity_id']
    });

    await queryInterface.addIndex('AdAttributionIssues', {
      name: 'idx_ad_issue_status_last_seen',
      fields: ['status', 'last_seen_at']
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('AdAttributionIssues', 'idx_ad_issue_status_last_seen');
    await queryInterface.removeIndex('AdAttributionIssues', 'uniq_ad_issue_provider_entity');
    await queryInterface.dropTable('AdAttributionIssues');
  }
};
