'use strict';
// Preserve every durable boundary row. No credentials, mappings or grants move.
module.exports = {
  async up(qi) {
    await qi.sequelize.query('ALTER TABLE `SearchConsoleBrokerBindings` DROP PRIMARY KEY, ADD PRIMARY KEY (`site_hash`, `mapping_id`)');
  },
  async down(qi) {
    const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM `SearchConsoleBrokerBindings`');
    if (Number(rows[0].n)) throw Error('Preserve managed Search Console boundaries; rollback requires an approved cut');
    await qi.sequelize.query('ALTER TABLE `SearchConsoleBrokerBindings` DROP PRIMARY KEY, ADD PRIMARY KEY (`site_hash`)');
  },
};
