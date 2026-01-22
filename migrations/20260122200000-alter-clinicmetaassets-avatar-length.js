'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'assetAvatarUrl', {
      type: Sequelize.STRING(1024),
      allowNull: true,
      comment: 'URL del avatar/icono del activo (página, perfil, etc.)'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('ClinicMetaAssets', 'assetAvatarUrl', {
      type: Sequelize.STRING(512),
      allowNull: true,
      comment: 'URL del avatar/icono del activo (página, perfil, etc.)'
    });
  }
};
