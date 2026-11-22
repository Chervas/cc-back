'use strict';

const { tableName, uniqueKeys, fields } = require('../src/lib/metaMarketingInstagramExtensionSchema');

module.exports = (sequelize, D) => sequelize.define('MetaMarketingInstagramExtension', fields(D), {
  tableName, timestamps: false, charset: 'ascii', collate: 'ascii_bin',
  indexes: Object.entries(uniqueKeys).map(([name, { fields }]) => ({ name, fields, unique: true })),
});
