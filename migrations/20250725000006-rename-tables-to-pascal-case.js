'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Renombrar tablas a PascalCase para mantener consistencia con el resto del proyecto
    await queryInterface.renameTable('social_stats_daily', 'SocialStatsDaily');
    await queryInterface.renameTable('social_posts', 'SocialPosts');
    await queryInterface.renameTable('social_post_stats_daily', 'SocialPostStatsDaily');
    await queryInterface.renameTable('sync_logs', 'SyncLogs');
    await queryInterface.renameTable('token_validations', 'TokenValidations');

    console.log('✅ Tablas renombradas a PascalCase exitosamente');
  },

  down: async (queryInterface, Sequelize) => {
    // Revertir cambios (volver a snake_case)
    await queryInterface.renameTable('SocialStatsDaily', 'social_stats_daily');
    await queryInterface.renameTable('SocialPosts', 'social_posts');
    await queryInterface.renameTable('SocialPostStatsDaily', 'social_post_stats_daily');
    await queryInterface.renameTable('SyncLogs', 'sync_logs');
    await queryInterface.renameTable('TokenValidations', 'token_validations');

    console.log('✅ Tablas renombradas a snake_case exitosamente');
  }
};

