'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const migration = require('../../../migrations/20260722093000-index-marketing-list-quickchat-lookups');

test('adds the QuickChat marketing fallback indexes once', async () => {
  const added = [];
  const queryInterface = {
    showIndex: async () => [
      { name: 'idx_marketing_list_items_conversation' },
    ],
    addIndex: async (table, fields, options) => added.push({ table, fields, options }),
  };

  await migration.up(queryInterface);

  assert.deepEqual(added, [{
    table: 'MarketingPatientListItems',
    fields: ['phone'],
    options: { name: 'idx_marketing_list_items_phone' },
  }]);
});

test('removes the QuickChat marketing fallback indexes in reverse order', async () => {
  const removed = [];
  const queryInterface = {
    showIndex: async () => [
      { name: 'idx_marketing_list_items_conversation' },
      { name: 'idx_marketing_list_items_phone' },
    ],
    removeIndex: async (table, name) => removed.push({ table, name }),
  };

  await migration.down(queryInterface);

  assert.deepEqual(removed, [
    { table: 'MarketingPatientListItems', name: 'idx_marketing_list_items_phone' },
    { table: 'MarketingPatientListItems', name: 'idx_marketing_list_items_conversation' },
  ]);
});
