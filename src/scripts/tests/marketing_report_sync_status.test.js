'use strict';

const assert = require('node:assert/strict');
const { Op } = require('sequelize');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const { __testing } = require('../../controllers/marketingReports.controller');

const config = {
  source: 'Meta Ads',
  label: 'Meta Ads',
};
const clinicScope = {
  scope: 'clinic',
  clinicIds: [72],
  isAll: false,
};
const now = new Date('2026-08-24T08:00:00.000Z').getTime();

function testJobMustBeRelatedToTheEffectiveAccount() {
  const globalJob = {
    status: 'running',
    updated_at: '2026-08-24T07:59:00.000Z',
    payload: { __dedupe_scope: 'global', __runtime_namespace: 'staging' },
  };
  assert.equal(__testing.jobMatchesScope(globalJob, clinicScope, {
    accountIds: ['act_5651594564879938'],
    assetIds: [391],
  }), false);

  const accountJob = {
    ...globalJob,
    payload: { ad_account_ids: ['5651594564879938'] },
  };
  assert.equal(__testing.jobMatchesScope(accountJob, clinicScope, {
    accountIds: ['act_5651594564879938'],
    assetIds: [391],
  }), true);

  const otherAccountJob = {
    ...globalJob,
    payload: { accounts: [{ ad_account_id: 'act_999' }] },
  };
  assert.equal(__testing.jobMatchesScope(otherAccountJob, clinicScope, {
    accountIds: ['act_5651594564879938'],
    assetIds: [391],
  }), false);

  const mixedAccountJob = {
    ...globalJob,
    payload: { accounts: [{ id: 391, ad_account_id: 'act_5651594564879938' }] },
  };
  assert.equal(__testing.jobMatchesScope(mixedAccountJob, clinicScope, {
    accountIds: ['act_5651594564879938'],
    assetIds: [391],
  }), true, 'remote account id must win over a generic object id');
}

function testOnlyFreshActiveJobsAreLive() {
  assert.equal(__testing.isLiveSyncJob({
    status: 'running',
    updated_at: '2026-08-24T07:55:00.000Z',
  }, now), true);
  assert.equal(__testing.isLiveSyncJob({
    status: 'running',
    updated_at: '2026-08-24T01:00:00.000Z',
  }, now), false);
  assert.equal(__testing.isLiveSyncJob({
    status: 'completed',
    updated_at: '2026-08-24T07:55:00.000Z',
  }, now), false);
}

function testUnattributedDataNeverMasqueradesAsSyncing() {
  const state = __testing.buildSourceSyncState({
    config,
    mapped: true,
    lastSync: '2026-08-23T22:17:34.000Z',
    jobs: [],
    attributionPending: true,
    now,
  });
  assert.equal(state.state, 'attribution_pending');
  assert.equal(state.active, false);
  assert.match(state.message, /sin asignar a esta clínica/i);
}

function testSyncErrorsRequireReviewButAreNotActiveWork() {
  const state = __testing.buildSourceSyncState({
    config,
    mapped: true,
    lastSync: null,
    jobs: [{
      id: 101,
      status: 'failed',
      updated_at: '2026-08-24T07:59:00.000Z',
      last_error: 'Provider rejected the request',
    }],
    now,
  });
  assert.equal(state.state, 'error');
  assert.equal(state.active, false);
}

function testNoJobAndNoFactsIsPendingNotSyncing() {
  const state = __testing.buildSourceSyncState({
    config,
    mapped: true,
    lastSync: null,
    jobs: [],
    now,
  });
  assert.equal(state.state, 'pending');
  assert.equal(state.active, false);
}

function testMatchingFreshJobStillReportsSyncing() {
  const state = __testing.buildSourceSyncState({
    config,
    mapped: true,
    lastSync: null,
    jobs: [{
      id: 100,
      status: 'running',
      updated_at: '2026-08-24T07:59:00.000Z',
    }],
    attributionPending: true,
    now,
  });
  assert.equal(state.state, 'syncing');
  assert.equal(state.active, true);
  assert.equal(state.jobId, 100);
}

async function testMetaAttributionPendingUsesUnassignedRowsOnly() {
  let receivedWhere = null;
  const result = await __testing.resolveMetaAttributionStatus(clinicScope, {
    meta: {
      available_assets: {
        ad_accounts: [{
          ad_account_id: 'act_5651594564879938',
          group_id: 29,
        }],
      },
    },
  }, {
    SocialAdsInsightsDaily: {
      async findOne(options) {
        receivedWhere = options.where;
        return {
          id: 1898,
          date: '2026-08-23',
          updated_at: '2026-08-23T22:17:14.000Z',
        };
      },
    },
  });

  assert.equal(receivedWhere.ad_account_id, 'act_5651594564879938');
  assert.equal(receivedWhere.grupo_clinica_id, undefined);
  assert.equal(receivedWhere.clinica_id[Op.is], null);
  assert.deepEqual(result, {
    pending: true,
    unattributedRows: 1,
    lastUnattributedAt: '2026-08-23T22:17:14.000Z',
  });
}

async function run() {
  testJobMustBeRelatedToTheEffectiveAccount();
  testOnlyFreshActiveJobsAreLive();
  testUnattributedDataNeverMasqueradesAsSyncing();
  testSyncErrorsRequireReviewButAreNotActiveWork();
  testNoJobAndNoFactsIsPendingNotSyncing();
  testMatchingFreshJobStillReportsSyncing();
  await testMetaAttributionPendingUsesUnassignedRowsOnly();
  console.log('marketing_report_sync_status.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
