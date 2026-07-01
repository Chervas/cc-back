'use strict';

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((item) => (typeof item === 'string' ? item : item.tableName) === tableName);
}

async function addIndexIfMissing(queryInterface, table, fields, options) {
  const indexes = await queryInterface.showIndex(table);
  if (options?.name && indexes.some((index) => index.name === options.name)) {
    return;
  }
  await queryInterface.addIndex(table, fields, options);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'PublicMediaAssets'))) {
      await queryInterface.createTable('PublicMediaAssets', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        scope_type: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'clinic' },
        clinica_id: { type: Sequelize.INTEGER, allowNull: true },
        grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
        owner_type: { type: Sequelize.STRING(64), allowNull: true },
        owner_id: { type: Sequelize.STRING(128), allowNull: true },
        purpose: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'public_asset' },
        provider: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 's3_cloudfront' },
        bucket: { type: Sequelize.STRING(255), allowNull: false },
        region: { type: Sequelize.STRING(64), allowNull: false },
        object_key: { type: Sequelize.STRING(768), allowNull: false },
        public_url: { type: Sequelize.TEXT, allowNull: false },
        content_type: { type: Sequelize.STRING(128), allowNull: false },
        size_bytes: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        sha256: { type: Sequelize.STRING(64), allowNull: false },
        etag: { type: Sequelize.STRING(255), allowNull: true },
        cache_control: { type: Sequelize.STRING(255), allowNull: true },
        sensitivity: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'public' },
        status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
        metadata: { type: Sequelize.JSON, allowNull: true },
        created_by: { type: Sequelize.INTEGER, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    } else {
      await queryInterface.changeColumn('PublicMediaAssets', 'object_key', {
        type: Sequelize.STRING(768),
        allowNull: false,
      }).catch(() => null);
    }

    await addIndexIfMissing(queryInterface, 'PublicMediaAssets', ['object_key'], {
      name: 'idx_public_media_assets_object_key',
      unique: true
    });
    await addIndexIfMissing(queryInterface, 'PublicMediaAssets', ['scope_type', 'clinica_id', 'purpose'], {
      name: 'idx_public_media_assets_clinic_usage'
    });
    await addIndexIfMissing(queryInterface, 'PublicMediaAssets', ['scope_type', 'grupo_clinica_id', 'purpose'], {
      name: 'idx_public_media_assets_group_usage'
    });
    await addIndexIfMissing(queryInterface, 'PublicMediaAssets', ['created_at'], {
      name: 'idx_public_media_assets_created_at'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PublicMediaAssets').catch(() => null);
  },
};
