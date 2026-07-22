'use strict';

const TABLE = 'MarketingPatientListItems';
const INDEXES = [
  {
    name: 'idx_marketing_list_items_conversation',
    fields: ['conversation_id'],
  },
  {
    name: 'idx_marketing_list_items_phone',
    fields: ['phone'],
  },
];

module.exports = {
  async up(queryInterface) {
    const existing = await queryInterface.showIndex(TABLE);

    for (const index of INDEXES) {
      if (!existing.some((item) => item.name === index.name)) {
        await queryInterface.addIndex(TABLE, index.fields, { name: index.name });
      }
    }
  },

  async down(queryInterface) {
    const existing = await queryInterface.showIndex(TABLE);

    for (const index of [...INDEXES].reverse()) {
      if (existing.some((item) => item.name === index.name)) {
        await queryInterface.removeIndex(TABLE, index.name);
      }
    }
  },
};
