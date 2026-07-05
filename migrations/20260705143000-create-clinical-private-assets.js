'use strict';

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  return tables.some((item) => (typeof item === 'string' ? item : item.tableName || item.table_name) === tableName);
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
    if (!(await tableExists(queryInterface, 'ClinicalPrivateAssets'))) {
      await queryInterface.createTable('ClinicalPrivateAssets', {
        id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
        public_id: { type: Sequelize.STRING(80), allowNull: false, unique: true },
        scope_type: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'clinic' },
        clinic_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Clinicas', key: 'id_clinica' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        group_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'GruposClinicas', key: 'id_grupo' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        patient_id: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Pacientes', key: 'id_paciente' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        owner_type: { type: Sequelize.STRING(80), allowNull: true },
        owner_id: { type: Sequelize.STRING(128), allowNull: true },
        purpose: { type: Sequelize.STRING(80), allowNull: false },
        provider: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'local_private' },
        bucket: { type: Sequelize.STRING(255), allowNull: false },
        region: { type: Sequelize.STRING(64), allowNull: true },
        object_key: { type: Sequelize.STRING(768), allowNull: false },
        original_filename: { type: Sequelize.STRING(255), allowNull: true },
        content_type: { type: Sequelize.STRING(128), allowNull: false },
        size_bytes: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        sha256: { type: Sequelize.STRING(64), allowNull: false },
        encryption_status: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'provider_managed' },
        sensitivity: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'clinical_private' },
        status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
        metadata: { type: Sequelize.JSON, allowNull: true },
        created_by: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'Usuarios', key: 'id_usuario' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      });
    }

    await addIndexIfMissing(queryInterface, 'ClinicalPrivateAssets', ['public_id'], {
      name: 'idx_clinical_private_assets_public_id',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'ClinicalPrivateAssets', ['object_key'], {
      name: 'idx_clinical_private_assets_object_key',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'ClinicalPrivateAssets', ['clinic_id', 'patient_id', 'purpose'], {
      name: 'idx_clinical_private_assets_patient_purpose',
    });
    await addIndexIfMissing(queryInterface, 'ClinicalPrivateAssets', ['owner_type', 'owner_id'], {
      name: 'idx_clinical_private_assets_owner',
    });
    await addIndexIfMissing(queryInterface, 'ClinicalPrivateAssets', ['created_at'], {
      name: 'idx_clinical_private_assets_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ClinicalPrivateAssets').catch(() => null);
  },
};
