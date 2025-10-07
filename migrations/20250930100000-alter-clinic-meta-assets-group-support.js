'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });

    await queryInterface.addColumn('ClinicMetaAssets', 'grupoClinicaId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {
        model: 'GruposClinicas',
        key: 'id_grupo'
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL'
    });

    await queryInterface.addColumn('ClinicMetaAssets', 'assignmentScope', {
      type: Sequelize.ENUM('clinic', 'group'),
      allowNull: false,
      defaultValue: 'clinic'
    });

    try {
      await queryInterface.removeConstraint('ClinicMetaAssets', 'unique_clinic_asset');
    } catch (error) {
      // ignore if the constraint does not exist
    }

    await queryInterface.addConstraint('ClinicMetaAssets', {
      fields: ['metaConnectionId', 'metaAssetId'],
      type: 'unique',
      name: 'uniq_meta_connection_asset'
    });

    await queryInterface.addIndex('ClinicMetaAssets', {
      name: 'idx_clinic_meta_assets_group_active',
      fields: ['grupoClinicaId', 'isActive']
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ClinicMetaAssets', 'idx_clinic_meta_assets_group_active');

    try {
      await queryInterface.removeConstraint('ClinicMetaAssets', 'uniq_meta_connection_asset');
    } catch (error) {
      // ignore if already removed
    }

    await queryInterface.addConstraint('ClinicMetaAssets', {
      fields: ['clinicaId', 'assetType', 'metaAssetId'],
      type: 'unique',
      name: 'unique_clinic_asset'
    });

    await queryInterface.removeColumn('ClinicMetaAssets', 'assignmentScope');
    await queryInterface.removeColumn('ClinicMetaAssets', 'grupoClinicaId');

    await queryInterface.changeColumn('ClinicMetaAssets', 'clinicaId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    });
  }
};
