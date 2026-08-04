'use strict';

const assert = require('assert');
const db = require('../../../models');
const service = require('../../services/marketingBulkSends.service');

async function main() {
  const list = {
    id: 672,
    status: 'sending',
    criteria: {
      dispatch: { status: 'sending', job_id: 31682, batch_size: 1 },
      dispatch_config: { status: 'sending', job_id: 31682, timezone: 'Europe/Madrid' },
    },
    async update(payload) {
      Object.assign(this, payload);
    },
  };

  const result = await service.reconcileDispatchJobState(list, {
    JobRequest: {
      async findByPk(id, options) {
        assert.equal(id, 31682);
        assert(options.attributes.includes('updated_at'));
        return {
          id,
          status: 'failed',
          error_message: 'review_team_photo_https_url_required',
          completed_at: null,
          updated_at: new Date('2026-07-31T18:00:00.000Z'),
        };
      },
    },
  });

  assert.equal(result.reconciled, true);
  assert.equal(result.status, 'failed');
  assert.equal(list.status, 'failed');
  assert.equal(list.criteria.dispatch.status, 'failed');
  assert.equal(list.criteria.dispatch_config.status, 'failed');
  assert.equal(list.criteria.dispatch.last_error, 'review_team_photo_https_url_required');
  assert.equal(list.criteria.dispatch_config.job_id, 31682);

  console.log('marketing_dispatch_job_reconciliation.test.js: OK');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
