// backendclinicaclick/migrations/[TIMESTAMP]-create-clinic-meta-assets-table.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ClinicMetaAssets', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      clinicaId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas', // Nombre de tu tabla de clínicas
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      metaConnectionId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'MetaConnections', // Nombre de tu tabla MetaConnections
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      assetType: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      metaAssetId: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      metaAssetName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      pageAccessToken: { // Token de página (solo para páginas de Facebook)
        type: Sequelize.STRING(512),
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    // Añadir índice único para clinicaId, assetType y metaAssetId
    await queryInterface.addConstraint('ClinicMetaAssets', {
      fields: ['clinicaId', 'assetType', 'metaAssetId'],
      type: 'unique',
      name: 'unique_clinic_asset'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('ClinicMetaAssets');
  }
};
