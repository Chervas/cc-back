"use strict";

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('SocialAdsAdsetDailyAgg', 'leads', {
      type: Sequelize.DECIMAL(12, 4),
      allowNull: false,
      defaultValue: 0
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('SocialAdsAdsetDailyAgg', 'leads', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
  }
};
