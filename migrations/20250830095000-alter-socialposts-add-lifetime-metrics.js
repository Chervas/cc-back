'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('SocialPosts', 'reactions_and_likes', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'comments_count', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'shares_count', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'saved_count', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'views_count', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'avg_watch_time_ms', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialPosts', 'media_type', { type: Sequelize.STRING(32), allowNull: true });
    await queryInterface.addColumn('SocialPosts', 'reactions_breakdown_json', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn('SocialPosts', 'insights_synced_at', { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addColumn('SocialPosts', 'metrics_source_version', { type: Sequelize.STRING(16), allowNull: true });
  },
  down: async (queryInterface, Sequelize) => {
    const cols = [
      'reactions_and_likes','comments_count','shares_count','saved_count','views_count','avg_watch_time_ms','media_type','reactions_breakdown_json','insights_synced_at','metrics_source_version'
    ];
    for (const c of cols) {
      await queryInterface.removeColumn('SocialPosts', c);
    }
  }
};

