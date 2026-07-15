'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DELETE older
      FROM BusinessProfileDailyMetrics AS older
      INNER JOIN BusinessProfileDailyMetrics AS newer
        ON newer.business_location_id = older.business_location_id
       AND newer.metric_type = older.metric_type
       AND COALESCE(newer.metric_subtype, '') = COALESCE(older.metric_subtype, '')
       AND newer.date = older.date
       AND (
         newer.updated_at > older.updated_at
         OR (newer.updated_at IS NOT NULL AND older.updated_at IS NULL)
         OR (
           (newer.updated_at = older.updated_at OR (newer.updated_at IS NULL AND older.updated_at IS NULL))
           AND newer.id > older.id
         )
       )
    `);
    await queryInterface.sequelize.query(`
      UPDATE BusinessProfileDailyMetrics
      SET metric_subtype = ''
      WHERE metric_subtype IS NULL
    `);
    await queryInterface.changeColumn('BusinessProfileDailyMetrics', 'metric_subtype', {
      type: Sequelize.STRING(64),
      allowNull: false,
      defaultValue: '',
    });
    await queryInterface.addIndex(
      'BusinessProfileDailyMetrics',
      ['business_location_id', 'metric_type', 'metric_subtype', 'date'],
      {
        unique: true,
        name: 'uniq_business_profile_metric_location_type_subtype_date',
      }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex(
      'BusinessProfileDailyMetrics',
      'uniq_business_profile_metric_location_type_subtype_date'
    );
    await queryInterface.changeColumn('BusinessProfileDailyMetrics', 'metric_subtype', {
      type: Sequelize.STRING(64),
      allowNull: true,
      defaultValue: null,
    });
  },
};
