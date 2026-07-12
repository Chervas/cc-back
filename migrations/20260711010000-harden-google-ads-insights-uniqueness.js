'use strict';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // El índice histórico no incluía adGroupId y MySQL permite múltiples NULL
    // en un UNIQUE. Las sincronizaciones repetidas podían multiplicar filas.
    await sequelize.query(`
      CREATE TEMPORARY TABLE GoogleAdsInsightsDailyKeepIds AS
      SELECT MAX(id) AS id
      FROM GoogleAdsInsightsDaily
      GROUP BY
        campaignId,
        date,
        clinicGoogleAdsAccountId,
        COALESCE(adGroupId, '__CAMPAIGN__'),
        COALESCE(network, '__UNSPECIFIED__'),
        COALESCE(device, '__UNSPECIFIED__')
    `);
    await sequelize.query('ALTER TABLE GoogleAdsInsightsDailyKeepIds ADD PRIMARY KEY (id)');
    await sequelize.query(`
      DELETE insights
      FROM GoogleAdsInsightsDaily AS insights
      LEFT JOIN GoogleAdsInsightsDailyKeepIds AS keep_row ON keep_row.id = insights.id
      WHERE keep_row.id IS NULL
    `);
    await sequelize.query('DROP TEMPORARY TABLE GoogleAdsInsightsDailyKeepIds');

    await queryInterface.removeIndex('GoogleAdsInsightsDaily', 'uniq_google_ads_campaign_date_account');
    await sequelize.query(`
      ALTER TABLE GoogleAdsInsightsDaily
        ADD COLUMN adGroupIdKey VARCHAR(64)
          GENERATED ALWAYS AS (COALESCE(adGroupId, '__CAMPAIGN__')) STORED,
        ADD COLUMN networkKey VARCHAR(64)
          GENERATED ALWAYS AS (COALESCE(network, '__UNSPECIFIED__')) STORED,
        ADD COLUMN deviceKey VARCHAR(64)
          GENERATED ALWAYS AS (COALESCE(device, '__UNSPECIFIED__')) STORED
    `);
    await queryInterface.addIndex('GoogleAdsInsightsDaily', {
      name: 'uniq_google_ads_insights_dimension',
      unique: true,
      fields: [
        'campaignId',
        'date',
        'clinicGoogleAdsAccountId',
        'adGroupIdKey',
        'networkKey',
        'deviceKey'
      ]
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('GoogleAdsInsightsDaily', 'uniq_google_ads_insights_dimension');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'deviceKey');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'networkKey');
    await queryInterface.removeColumn('GoogleAdsInsightsDaily', 'adGroupIdKey');
    await queryInterface.addIndex('GoogleAdsInsightsDaily', {
      name: 'uniq_google_ads_campaign_date_account',
      unique: true,
      fields: ['campaignId', 'date', 'clinicGoogleAdsAccountId', 'network', 'device']
    });
  }
};
