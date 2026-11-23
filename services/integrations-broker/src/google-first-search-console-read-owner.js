'use strict';
const { createFirstPropertyReadOwner } = require('./google-first-property-read-owner');
const TABLE = 'google_first_sc_read_authorities_v1';
const createFirstSearchConsoleReadOwner = options => createFirstPropertyReadOwner('search_console',options);
module.exports = { createFirstSearchConsoleReadOwner,TABLE };
