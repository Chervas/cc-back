'use strict';

function tableNameOf(table) {
  return typeof table === 'string'
    ? table
    : (table?.tableName || table?.table_name || table?.name || '');
}

async function hasTable(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((table) => tableNameOf(table).toLowerCase() === tableName.toLowerCase());
}

async function hasIndex(queryInterface, tableName, indexName) {
  const indexes = await queryInterface.showIndex(tableName);
  return indexes.some((index) => index.name === indexName);
}

async function addIndexIfMissing(queryInterface, tableName, fields, options) {
  if (!await hasIndex(queryInterface, tableName, options.name)) {
    await queryInterface.addIndex(tableName, fields, options);
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!await hasTable(queryInterface, 'MarketingCompetitionHeatmapSearches')) {
      await queryInterface.createTable('MarketingCompetitionHeatmapSearches', {
        id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        primary_clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        search_term: { type: Sequelize.STRING(240), allowNull: false },
        normalized_term: { type: Sequelize.STRING(240), allowNull: false },
        effective_term: { type: Sequelize.STRING(512), allowNull: false },
        zoom_km: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        created_by: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        last_used_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'MarketingCompetitionHeatmapSearches',
      ['primary_clinic_id', 'normalized_term', 'zoom_km'],
      { unique: true, name: 'uniq_marketing_heatmap_saved_search' },
    );
    await addIndexIfMissing(
      queryInterface,
      'MarketingCompetitionHeatmapSearches',
      ['primary_clinic_id', 'last_used_at'],
      { name: 'idx_marketing_heatmap_saved_search_used' },
    );

    if (!await hasTable(queryInterface, 'MarketingCompetitionHeatmapSnapshots')) {
      await queryInterface.createTable('MarketingCompetitionHeatmapSnapshots', {
        id: {
          type: Sequelize.BIGINT.UNSIGNED,
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
        },
        cache_key: { type: Sequelize.STRING(64), allowNull: false },
        primary_clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        search_term: { type: Sequelize.STRING(512), allowNull: false },
        zoom_km: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
        grid_size: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
        algorithm_version: { type: Sequelize.STRING(96), allowNull: false },
        payload: { type: Sequelize.JSON, allowNull: false },
        generated_at: { type: Sequelize.DATE, allowNull: false },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'MarketingCompetitionHeatmapSnapshots',
      ['cache_key', 'generated_at'],
      { unique: true, name: 'uniq_marketing_heatmap_snapshot_generated' },
    );
    await addIndexIfMissing(
      queryInterface,
      'MarketingCompetitionHeatmapSnapshots',
      ['primary_clinic_id', 'search_term', 'zoom_km', 'generated_at'],
      { name: 'idx_marketing_heatmap_snapshot_history' },
    );
    await addIndexIfMissing(
      queryInterface,
      'MarketingCompetitionHeatmapSnapshots',
      ['generated_at'],
      { name: 'idx_marketing_heatmap_snapshot_retention' },
    );
  },

  async down(queryInterface) {
    if (await hasTable(queryInterface, 'MarketingCompetitionHeatmapSnapshots')) {
      await queryInterface.dropTable('MarketingCompetitionHeatmapSnapshots');
    }
    if (await hasTable(queryInterface, 'MarketingCompetitionHeatmapSearches')) {
      await queryInterface.dropTable('MarketingCompetitionHeatmapSearches');
    }
  },
};
