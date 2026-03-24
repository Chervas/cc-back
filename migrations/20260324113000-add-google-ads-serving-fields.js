'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'campaignServingStatus', {
      type: Sequelize.STRING(64),
      allowNull: true,
      after: 'campaignStatus',
    });
    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'campaignPrimaryStatus', {
      type: Sequelize.STRING(64),
      allowNull: true,
      after: 'campaignServingStatus',
    });
    await queryInterface.addColumn('GoogleAdsInsightsDaily', 'campaignPrimaryStatusReasons', {
      type: Sequelize.TEXT('long'),
      allowNull: true,
      after: 'campaignPrimaryStatus',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'campaignPrimaryStatusReasons');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'campaignPrimaryStatus');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'campaignServingStatus');
  },
};
