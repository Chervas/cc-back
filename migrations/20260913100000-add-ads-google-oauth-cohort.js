'use strict';
const tables = ['GoogleOAuthBrokerBindings', 'GoogleOAuthBrokerRequests'];
const before = "enum('business_profile','search_console','analytics')";
const after = "enum('business_profile','search_console','analytics','ads')";
async function inspect(qi, expected) {
  for (const table of tables) {
    const [rows] = await qi.sequelize.query('SHOW COLUMNS FROM `' + table + "` LIKE 'cohort'");
    if (rows.length !== 1 || rows[0].Type !== expected || rows[0].Null !== 'NO' || rows[0].Default !== 'business_profile') {
      throw Error('google_oauth_cohort_schema_mismatch');
    }
  }
}
module.exports = {
  async up(qi) {
    await inspect(qi, before);
    for (const table of tables) await qi.sequelize.query('ALTER TABLE `' + table + '` MODIFY COLUMN cohort ' + after + " NOT NULL DEFAULT 'business_profile'");
  },
  async down(qi) {
    await inspect(qi, after);
    for (const table of tables) {
      const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `' + table + "` WHERE cohort='ads'");
      if (Number(rows[0].n)) throw Error('Preserve Ads OAuth history; rollback requires an approved cut');
    }
    for (const table of tables) await qi.sequelize.query('ALTER TABLE `' + table + '` MODIFY COLUMN cohort ' + before + " NOT NULL DEFAULT 'business_profile'");
  },
};
