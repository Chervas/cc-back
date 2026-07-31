'use strict';

const INDEXES = [
  {
    table: 'MarketingPatientListItems',
    name: 'idx_marketing_list_items_clinic_name',
    fields: ['clinica_id', 'name'],
  },
  {
    table: 'MarketingPatientListItems',
    name: 'idx_marketing_list_items_clinic_email',
    fields: ['clinica_id', 'email'],
  },
];

async function hasIndex(queryInterface, table, name) {
  const indexes = await queryInterface.showIndex(table);
  return indexes.some((index) => index.name === name);
}

module.exports = {
  async up(queryInterface) {
    for (const index of INDEXES) {
      if (!(await hasIndex(queryInterface, index.table, index.name))) {
        await queryInterface.addIndex(index.table, index.fields, { name: index.name });
      }
    }
  },

  async down(queryInterface) {
    for (const index of [...INDEXES].reverse()) {
      if (await hasIndex(queryInterface, index.table, index.name)) {
        await queryInterface.removeIndex(index.table, index.name);
      }
    }
  },
};
