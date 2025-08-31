'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const addCol = (name, type, opts={}) => queryInterface.addColumn('SocialStatsDaily', name, { type, allowNull: false, defaultValue: opts.defaultValue ?? 0 });
    await addCol('reach_total', Sequelize.INTEGER);
    await addCol('views', Sequelize.INTEGER);
    await addCol('likes', Sequelize.INTEGER);
    await addCol('reactions', Sequelize.INTEGER);
    await addCol('posts_count', Sequelize.INTEGER);
    await addCol('reach_instagram', Sequelize.INTEGER);
    await addCol('reach_facebook', Sequelize.INTEGER);
    await addCol('impressions_instagram', Sequelize.INTEGER);
    await addCol('impressions_facebook', Sequelize.INTEGER);
    await queryInterface.addColumn('SocialStatsDaily', 'spend_instagram', { type: Sequelize.DECIMAL(12,2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('SocialStatsDaily', 'spend_facebook', { type: Sequelize.DECIMAL(12,2), allowNull: false, defaultValue: 0 });
    await queryInterface.addIndex('SocialStatsDaily', ['asset_type', 'date'], { name: 'idx_social_stats_assettype_date' });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('SocialStatsDaily', 'idx_social_stats_assettype_date');
    const cols = [
      'reach_total','views','likes','reactions','posts_count',
      'reach_instagram','reach_facebook','impressions_instagram','impressions_facebook','spend_instagram','spend_facebook'
    ];
    for (const c of cols) {
      await queryInterface.removeColumn('SocialStatsDaily', c);
    }
  }
};

