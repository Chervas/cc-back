'use strict';

const { fields } = require('../models/metamarketinginstagramextension');

module.exports = {
  async up(queryInterface, dataTypes) {
    await queryInterface.createTable('MetaMarketingInstagramExtensions', fields(dataTypes), { charset: 'ascii', collate: 'ascii_bin' });
  },
  async down() {
    throw Error('meta_instagram_extension_history_must_be_preserved');
  },
};
