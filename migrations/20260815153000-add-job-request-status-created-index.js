'use strict';

const TABLE_NAME = 'JobRequests';
const INDEXES = [
  {
    name: 'idx_job_requests_status_created_at',
    fields: ['status', 'created_at'],
  },
  {
    name: 'idx_job_requests_status_updated_at',
    fields: ['status', 'updated_at'],
  },
];

module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex(TABLE_NAME);
    for (const indexDefinition of INDEXES) {
      if (!indexes.some((index) => index.name === indexDefinition.name)) {
        await queryInterface.addIndex(TABLE_NAME, indexDefinition.fields, {
          name: indexDefinition.name,
        });
      }
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex(TABLE_NAME);
    for (const indexDefinition of INDEXES) {
      if (indexes.some((index) => index.name === indexDefinition.name)) {
        await queryInterface.removeIndex(TABLE_NAME, indexDefinition.name);
      }
    }
  },
};
