'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('WebPsiSnapshots', 'https_ok', { type: Sequelize.BOOLEAN, allowNull: true });
    await queryInterface.addColumn('WebPsiSnapshots', 'https_status', { type: Sequelize.INTEGER, allowNull: true });
    await queryInterface.addColumn('WebPsiSnapshots', 'sitemap_found', { type: Sequelize.BOOLEAN, allowNull: true });
    await queryInterface.addColumn('WebPsiSnapshots', 'sitemap_url', { type: Sequelize.STRING(1024), allowNull: true });
    await queryInterface.addColumn('WebPsiSnapshots', 'sitemap_status', { type: Sequelize.INTEGER, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('WebPsiSnapshots', 'https_ok');
    await queryInterface.removeColumn('WebPsiSnapshots', 'https_status');
    await queryInterface.removeColumn('WebPsiSnapshots', 'sitemap_found');
    await queryInterface.removeColumn('WebPsiSnapshots', 'sitemap_url');
    await queryInterface.removeColumn('WebPsiSnapshots', 'sitemap_status');
  }
};

