'use strict';
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  const C = require('../../services/metaMarketingEnrollment.contract');
  const B = require('../../../services/integrations-broker/src/meta-marketing-business-contract');
  const { createDrain } = require('../../services/metaMarketingBusinessDrain.service');
  const define = (name, fields) => sql.define(name, fields, { tableName: name, timestamps: false });
  models.MetaMarketingEnrollmentRequest = define('MetaMarketingEnrollmentRequests', { enrollment_id: { type: D.CHAR(36), primaryKey: true },
    scope_key: D.STRING, state: D.STRING, mapping_ids: D.TEXT, assets: D.TEXT, clinic_ids: D.TEXT });
  models.MetaMarketingBrokerBinding = define('MetaMarketingBrokerBindings', { mapping_id: { type: D.INTEGER, primaryKey: true }, enrollment_id: D.CHAR(36), state: D.STRING });
  models.MetaMarketingBusinessDrain = require('../../../models/metamarketingbusinessdrain')(sql, D);
  models.JobRequest = require('../../../models/jobrequest')(sql, D);
  models.LeadIntake = define('LeadIntakes', { id: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER, external_id: D.STRING, external_source: D.STRING });
  await sql.sync();
  const asset = (kind, id) => ({ assetRef: 'meta-' + kind + ':' + id, kind, id, parentPageId: null });
  const bs = { enrollment_id: randomUUID(), scope_key: 'group:29', state: 'active', mapping_ids: '[10,11,12,13]', clinic_ids: '[66,72]',
    assets: JSON.stringify(C.assets([asset('ad_account', '301'), asset('ad_account', '302'), asset('facebook_page', '401'), asset('facebook_page', '402')])) };
  const other = { enrollment_id: randomUUID(), scope_key: 'group:28', state: 'active', mapping_ids: '[20,21]', clinic_ids: '[1,70]',
    assets: JSON.stringify(C.assets([asset('ad_account', '303'), asset('facebook_page', '403')])) };
  await models.MetaMarketingEnrollmentRequest.bulkCreate([bs, other]);
  await models.MetaMarketingBrokerBinding.bulkCreate([...JSON.parse(bs.mapping_ids).map(mapping_id => ({ mapping_id, enrollment_id: bs.enrollment_id, state: 'active' })),
    ...JSON.parse(other.mapping_ids).map(mapping_id => ({ mapping_id, enrollment_id: other.enrollment_id, state: 'active' }))]);
  const drain = createDrain({ models }), tx = fn => sql.transaction({ isolationLevel: 'REPEATABLE READ' }, fn);
  const grant = C.hash('FICTITIOUS_OLD_GRANT'), handover1 = randomUUID();
  const owner = (refs, handoverId, oldGrantDigest = grant) => ({ closed: true, activeOperations: 0, receiptRefs: refs.slice().sort(),
    receiptSetDigest: B.drainDigest(handoverId, oldGrantDigest, refs.slice().sort()) });
  const options = (transaction, handoverId, refs = []) => ({ transaction, handoverId, oldGrantDigest: grant, ownerDrain: owner(refs, handoverId) });
  const payload = (ref = randomUUID()) => ({ receipt_ref: ref, page_asset_id: 12, account_asset_id: 10,
    lead_id: '701', page_id: '401', form_id: '801', ad_id: null });
  const empty = await tx(transaction => drain.begin(bs, options(transaction, handover1)));
  assert.equal(empty.ready, true);
  await assert.rejects(tx(transaction => drain.assertAdmission(payload(), { transaction })), { code: 'meta_business_drain_pending' });
  await tx(transaction => drain.assertAdmission({ ...payload(), page_asset_id: 21, account_asset_id: 20 }, { transaction }));
  await assert.rejects(tx(transaction => drain.release(bs.enrollment_id, { transaction, handoverId: randomUUID() })), { code: 'meta_business_drain_invalid' });
  await tx(transaction => drain.release(bs.enrollment_id, { transaction, handoverId: handover1 }));
  assert.equal((await models.MetaMarketingBusinessDrain.findByPk(handover1)).state, 'released');
  report.checks.push('SQL drain blocks only the affected grant; a different group stays available; release retains history and rejects another handover identity');

  const handover2 = randomUUID(), ref = randomUUID(), p = payload(ref);
  await assert.rejects(tx(transaction => drain.begin(bs, { ...options(transaction, handover2, [ref]),
    ownerDrain: { ...owner([ref], handover2), receiptSetDigest: C.hash(JSON.stringify([ref])) } })), { code: 'meta_business_drain_invalid' });
  await assert.rejects(tx(transaction => drain.begin(bs, { ...options(transaction, handover2, [ref]),
    ownerDrain: owner([ref], handover1) })), { code: 'meta_business_drain_invalid' });
  const pending = await tx(transaction => drain.begin(bs, options(transaction, handover2, [ref])));
  assert.equal(pending.ready, false);
  assert.equal(await models.MetaMarketingBusinessDrain.count(), 2);
  await tx(transaction => drain.assertAdmission(p, { transaction }));
  await assert.rejects(tx(transaction => drain.assertAdmission(payload(), { transaction })), { code: 'meta_business_drain_pending' });
  const { enqueueAcceptedMetaLeadJob } = require('../../services/metaLeadReception.service');
  let enqueues = 0;
  const enqueue = async (job, opts) => {
    enqueues++; assert(opts.transaction);
    return { job: await models.JobRequest.create({ type: job.type, status: 'pending', priority: 'high', payload: job.payload }, { transaction: opts.transaction }), created: true };
  };
  const job = { type: 'campaign_meta_lead_receive', payload: p };
  const accepted = await enqueueAcceptedMetaLeadJob({ models, enqueue, job });
  assert.equal(accepted.created, true);
  assert.equal((await tx(transaction => drain.begin(bs, options(transaction, handover2, [ref])))).ready, false);
  await assert.rejects(tx(transaction => drain.assert(bs.enrollment_id, pending.drainDigest, options(transaction, handover2, [ref]))), { code: 'meta_business_drain_pending' });
  await models.LeadIntake.create({ id: 901, clinica_id: 66, external_source: 'meta_leadgen', external_id: '701' });
  await models.JobRequest.update({ status: 'completed', result_summary: { lead_id: 901 } }, { where: { id: accepted.job.id } });
  assert.equal((await tx(transaction => drain.begin(bs, options(transaction, handover2, [ref])))).ready, true);
  await tx(transaction => drain.assert(bs.enrollment_id, pending.drainDigest, options(transaction, handover2, [ref])));
  const duplicate = await enqueueAcceptedMetaLeadJob({ models, enqueue, job });
  assert.equal(duplicate.created, false); assert.equal(enqueues, 1); assert.equal(await models.JobRequest.count(), 1);
  report.checks.push('Accepted-before-enqueue receipt can drain naturally, new notifications stay fenced, completed receipt redelivery creates no second job or historical automation');

  await models.LeadIntake.update({ clinica_id: 1 }, { where: { id: 901 } });
  assert.equal((await tx(transaction => drain.begin(bs, options(transaction, handover2, [ref])))).ready, false);
  await models.LeadIntake.update({ clinica_id: 66 }, { where: { id: 901 } });
  await models.JobRequest.update({ status: 'failed' }, { where: { id: accepted.job.id } });
  assert.equal((await tx(transaction => drain.begin(bs, options(transaction, handover2, [ref])))).ready, false);
  await models.JobRequest.update({ status: 'completed' }, { where: { id: accepted.job.id } });
  await assert.rejects(tx(transaction => drain.assert(bs.enrollment_id, pending.drainDigest,
    { ...options(transaction, handover2, [ref]), ownerDrain: { ...owner([ref], handover2), activeOperations: 1 } })), { code: 'meta_business_drain_pending' });
  const changedGrant = C.hash('FICTITIOUS_CHANGED_GRANT');
  await assert.rejects(tx(transaction => drain.begin(bs, { ...options(transaction, handover2, [ref]), oldGrantDigest: changedGrant,
    ownerDrain: owner([ref], handover2, changedGrant) })),
    { code: 'meta_business_drain_scope_changed' });
  report.checks.push('Unknown or failed jobs, wrong clinic, changed grant/receipt set and in-flight provider work cannot satisfy the cutover proof');
  await tx(transaction => drain.release(bs.enrollment_id, { transaction, handoverId: handover2 }));
  const handover3 = randomUUID();
  await assert.rejects(tx(async transaction => { await drain.begin(bs, options(transaction, handover3)); throw Error('FICTITIOUS_ROLLBACK'); }), /FICTITIOUS_ROLLBACK/);
  assert.equal(await models.MetaMarketingBusinessDrain.findByPk(handover3), null);
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => tx(transaction => drain.begin(bs, options(transaction, handover3)))));
  assert(concurrent.every(value => value.ready)); assert.equal(await models.MetaMarketingBusinessDrain.count(), 3);
  report.checks.push('Rollback is atomic and eight concurrent drain requests converge on one barrier, with prior cancelled histories preserved');
  report.providerRequests = 0; report.messagesSent = 0;
});
