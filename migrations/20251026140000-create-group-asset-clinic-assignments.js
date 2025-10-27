'use strict';

const ASSET_TYPE_MAP = {
  'meta.ad_account': { table: 'ClinicMetaAssets', idField: 'id', clinicField: 'clinicaId', groupField: 'grupoClinicaId', extraWhere: "assetType = 'ad_account'" },
  'meta.facebook_page': { table: 'ClinicMetaAssets', idField: 'id', clinicField: 'clinicaId', groupField: 'grupoClinicaId', extraWhere: "assetType = 'facebook_page'" },
  'meta.instagram_business': { table: 'ClinicMetaAssets', idField: 'id', clinicField: 'clinicaId', groupField: 'grupoClinicaId', extraWhere: "assetType = 'instagram_business'" },
  'google.ads_account': { table: 'ClinicGoogleAdsAccounts', idField: 'id', clinicField: 'clinicaId', groupField: 'grupoClinicaId', extraWhere: '1=1' },
  'google.search_console': { table: 'ClinicWebAssets', idField: 'id', clinicField: 'clinicaId', groupField: null, extraWhere: '1=1' },
  'google.analytics': { table: 'ClinicAnalyticsProperties', idField: 'id', clinicField: 'clinicaId', groupField: null, extraWhere: '1=1' },
  'google.business_profile': { table: 'ClinicBusinessLocations', idField: 'id', clinicField: 'clinica_id', groupField: null, extraWhere: '1=1' }
};

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('GroupAssetClinicAssignments', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      grupoClinicaId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      assetType: { type: Sequelize.STRING(64), allowNull: false },
      assetId: { type: Sequelize.INTEGER, allowNull: false },
      clinicaId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('GroupAssetClinicAssignments', ['grupoClinicaId']);
    await queryInterface.addIndex('GroupAssetClinicAssignments', ['assetType', 'assetId']);
    await queryInterface.addConstraint('GroupAssetClinicAssignments', {
      fields: ['grupoClinicaId', 'assetType', 'assetId', 'clinicaId'],
      type: 'unique',
      name: 'uniq_group_asset_clinic_assignment'
    });

    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const [assetType, meta] of Object.entries(ASSET_TYPE_MAP)) {
        const clinicField = meta.clinicField;
        const groupField = meta.groupField;
        const table = meta.table;
        const extraWhere = meta.extraWhere || '1=1';

        const [rows] = await queryInterface.sequelize.query(
          `
            SELECT t.${meta.idField} AS assetId,
                   t.${clinicField} AS clinicId,
                   ${groupField ? `t.${groupField}` : 'c.grupoClinicaId'} AS groupId
            FROM ${table} t
            LEFT JOIN Clinicas c ON c.id_clinica = t.${clinicField}
            WHERE t.${clinicField} IS NOT NULL
              AND ${extraWhere}
          `,
          { transaction }
        );

        const assignments = rows
          .filter(row => row.clinicId && row.groupId)
          .map(row => ({
            grupoClinicaId: row.groupId,
            assetType,
            assetId: row.assetId,
            clinicaId: row.clinicId,
            created_at: new Date(),
            updated_at: new Date()
          }));

        if (assignments.length) {
          await queryInterface.bulkInsert('GroupAssetClinicAssignments', assignments, { transaction, ignoreDuplicates: true });
        }
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('GroupAssetClinicAssignments', 'uniq_group_asset_clinic_assignment');
    await queryInterface.dropTable('GroupAssetClinicAssignments');
  }
};
