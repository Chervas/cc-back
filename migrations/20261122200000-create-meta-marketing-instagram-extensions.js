'use strict';

const { tableName, fields, uniqueKeys } = require('../src/lib/metaMarketingInstagramExtensionSchema');

module.exports = {
  async up(queryInterface, dataTypes) {
    await queryInterface.createTable(tableName, fields(dataTypes), { engine: 'InnoDB', charset: 'ascii', collate: 'ascii_bin', uniqueKeys });
  },
  async down() {
    throw Error('meta_instagram_extension_history_must_be_preserved');
  },
};
