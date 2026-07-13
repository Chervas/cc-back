'use strict';

const INDEX_NAME = 'idx_job_requests_type_status_created_at';

module.exports = {
  async up(queryInterface) {
    const indexes = await queryInterface.showIndex('JobRequests');
    if (!indexes.some((index) => index.name === INDEX_NAME)) {
      await queryInterface.addIndex('JobRequests', ['type', 'status', 'created_at'], {
        name: INDEX_NAME,
      });
    }
  },

  async down(queryInterface) {
    const indexes = await queryInterface.showIndex('JobRequests');
    if (indexes.some((index) => index.name === INDEX_NAME)) {
      await queryInterface.removeIndex('JobRequests', INDEX_NAME);
    }
  },
};
