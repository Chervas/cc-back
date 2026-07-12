'use strict';

const assert = require('node:assert/strict');
const { configuredClinicMarketingAliases } = require('../../lib/clinic-marketing-aliases');

assert.deepEqual(configuredClinicMarketingAliases({
  configuracion: {
    marketing_aliases: ['Sant Martí', 'Glòries', 'Glòries', '  Encants  '],
    campaign_aliases: ['Sant Marti'],
  },
}), ['Sant Martí', 'Glòries', 'Encants', 'Sant Marti']);

assert.deepEqual(configuredClinicMarketingAliases({
  configuracion: JSON.stringify({ marketing_aliases: ['Glories'] }),
}), ['Glories']);

assert.deepEqual(configuredClinicMarketingAliases(null), []);

console.log('clinic_marketing_aliases.test.js OK');
