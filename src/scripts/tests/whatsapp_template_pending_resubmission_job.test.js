#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const axios = require('axios');

const db = require('../../../models');
const { queues } = require('../../services/queue.service');
const whatsappTemplatesService = require('../../services/whatsappTemplates.service');
const jobExecutor = require('../../services/jobExecutor.service');

const WABA_ID = '455445070989662';
const SOURCE_TEMPLATE_ID = 1036;
const REPLACEMENT_TEMPLATE_ID = 1078;

async function testJobRoutesStalePendingModeOnlyToResubmissionService() {
  const originalResubmit = whatsappTemplatesService.runStalePendingTemplateResubmission;
  const originalCreateFromCatalog = whatsappTemplatesService.createTemplatesFromCatalog;
  const payload = {
    mode: 'resubmit_stale_pending',
    source_template_id: SOURCE_TEMPLATE_ID,
    waba_id: WABA_ID,
    replacement_name: 'clinicaclick_recordatorio_acceso_dificil_v11',
  };
  const calls = {
    resubmit: [],
    createFromCatalog: [],
  };

  whatsappTemplatesService.runStalePendingTemplateResubmission = async (received) => {
    calls.resubmit.push(received);
    return {
      source_template_id: SOURCE_TEMPLATE_ID,
      replacement_template_id: REPLACEMENT_TEMPLATE_ID,
      resumed_cleanup_only: true,
    };
  };
  whatsappTemplatesService.createTemplatesFromCatalog = async (received) => {
    calls.createFromCatalog.push(received);
    throw new Error('createTemplatesFromCatalog must not run for stale-pending resubmission');
  };

  try {
    const execution = await jobExecutor.runJob({
      type: 'whatsapp_template_create',
      payload,
    });

    assert.equal(execution.status, 'completed');
    assert.equal(calls.resubmit.length, 1);
    assert.equal(calls.resubmit[0], payload, 'the handler must preserve the durable job payload');
    assert.equal(calls.createFromCatalog.length, 0);
    assert.equal(execution.result.status, 'completed');
    assert.deepEqual(execution.result.result, {
      wabaId: WABA_ID,
      mode: 'resubmit_stale_pending',
      source_template_id: SOURCE_TEMPLATE_ID,
      replacement_template_id: REPLACEMENT_TEMPLATE_ID,
      resumed_cleanup_only: true,
    });
  } finally {
    whatsappTemplatesService.runStalePendingTemplateResubmission = originalResubmit;
    whatsappTemplatesService.createTemplatesFromCatalog = originalCreateFromCatalog;
  }
}

async function testCleanupRetryNeverCreatesAnotherRemoteTemplate() {
  const originalFindTemplateByPk = db.WhatsappTemplate.findByPk;
  const originalUpdateTemplate = db.WhatsappTemplate.update;
  const originalFindAsset = db.ClinicMetaAsset.findOne;
  const originalAxiosGet = axios.get;
  const originalAxiosPost = axios.post;
  const originalAxiosDelete = axios.delete;

  const source = {
    id: SOURCE_TEMPLATE_ID,
    waba_id: WABA_ID,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v8',
    meta_template_id: '1396277975650530',
    superseded_by_template_id: REPLACEMENT_TEMPLATE_ID,
    auto_resubmit_error: 'previous cleanup failure',
    async update(values) {
      Object.assign(this, values);
      return this;
    },
  };
  const replacement = {
    id: REPLACEMENT_TEMPLATE_ID,
    waba_id: WABA_ID,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v11',
    meta_template_id: '986959627638045',
  };
  const calls = {
    get: 0,
    post: 0,
    delete: 0,
    errorUpdates: [],
  };

  db.WhatsappTemplate.findByPk = async (id) => {
    if (Number(id) === SOURCE_TEMPLATE_ID) return source;
    if (Number(id) === REPLACEMENT_TEMPLATE_ID) return replacement;
    return null;
  };
  db.WhatsappTemplate.update = async (values, options) => {
    calls.errorUpdates.push({ values, options });
    return [1];
  };
  db.ClinicMetaAsset.findOne = async () => ({
    wabaId: WABA_ID,
    waAccessToken: 'asset-access-token',
    metaConnection: { accessToken: 'connection-access-token' },
  });
  axios.get = async (url, options) => {
    calls.get += 1;
    assert.match(url, new RegExp(`/${WABA_ID}/message_templates$`));
    assert.equal(options.params.access_token, 'asset-access-token');
    return {
      data: {
        data: [{
          id: source.meta_template_id,
          name: source.name,
          status: 'PENDING',
        }],
      },
    };
  };
  axios.post = async () => {
    calls.post += 1;
    throw new Error('cleanup-only retry must never create a second remote template');
  };
  axios.delete = async (url, options) => {
    calls.delete += 1;
    assert.match(url, new RegExp(`/${WABA_ID}/message_templates$`));
    assert.equal(options.params.name, source.name);
    assert.equal(options.params.hsm_id, source.meta_template_id);
    assert.equal(
      options.params.access_token,
      calls.delete === 2 ? 'asset-access-token' : 'connection-access-token',
    );
    if (calls.delete <= 2) {
      throw new Error('forced remote cleanup failure');
    }
    return { data: { success: true } };
  };

  const payload = {
    mode: 'resubmit_stale_pending',
    source_template_id: SOURCE_TEMPLATE_ID,
    wabaId: WABA_ID,
    replacement_name: replacement.name,
  };

  try {
    await assert.rejects(
      whatsappTemplatesService.runStalePendingTemplateResubmission(payload),
      (error) => {
        assert.equal(error.message, 'forced remote cleanup failure');
        assert.equal(error.autoResubmitCleanupOnly, true);
        assert.equal(error.replacementTemplateId, REPLACEMENT_TEMPLATE_ID);
        return true;
      },
    );

    assert.equal(calls.post, 0);
    assert.equal(calls.delete, 2, 'cleanup tries MetaConnection and then the WABA token');
    assert.equal(calls.errorUpdates.length, 1);
    assert.equal(calls.errorUpdates[0].options.where.id, SOURCE_TEMPLATE_ID);
    assert.match(calls.errorUpdates[0].values.auto_resubmit_error, /forced remote cleanup failure/);

    const retryResult = await whatsappTemplatesService.runStalePendingTemplateResubmission(payload);

    assert.equal(calls.get, 2, 'each cleanup attempt must re-read Meta');
    assert.equal(calls.delete, 3);
    assert.equal(calls.post, 0, 'the retry must remain cleanup-only after replacement exists');
    assert.equal(source.auto_resubmit_error, null);
    assert.deepEqual(retryResult, {
      source_template_id: SOURCE_TEMPLATE_ID,
      replacement_template_id: REPLACEMENT_TEMPLATE_ID,
      resumed_cleanup_only: true,
      deleted_old_remote: true,
      old_remote_already_absent: false,
    });
  } finally {
    db.WhatsappTemplate.findByPk = originalFindTemplateByPk;
    db.WhatsappTemplate.update = originalUpdateTemplate;
    db.ClinicMetaAsset.findOne = originalFindAsset;
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
    axios.delete = originalAxiosDelete;
  }
}

async function testApprovedSourceOnSecondMetaPageWinsCleanupRace() {
  const originalFindTemplateByPk = db.WhatsappTemplate.findByPk;
  const originalFindTemplates = db.WhatsappTemplate.findAll;
  const originalFindCatalogByPk = db.WhatsappTemplateCatalog.findByPk;
  const originalFindAsset = db.ClinicMetaAsset.findOne;
  const originalTransaction = db.sequelize.transaction;
  const originalAxiosGet = axios.get;
  const originalAxiosPost = axios.post;
  const originalAxiosDelete = axios.delete;

  const catalog = {
    id: 39,
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: 'Hola {{1}}, te enviamos indicaciones para llegar a la clínica.',
    }],
    variables: [],
    is_active: true,
  };
  const source = {
    id: SOURCE_TEMPLATE_ID,
    waba_id: WABA_ID,
    clinic_id: null,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v8',
    language: 'es',
    category: 'UTILITY',
    status: 'PENDING',
    components: catalog.components,
    meta_template_id: '1396277975650530',
    catalog_template_id: catalog.id,
    is_active: false,
    pending_since_at: new Date('2026-07-15T04:00:00.000Z'),
    superseded_by_template_id: REPLACEMENT_TEMPLATE_ID,
    auto_resubmit_error: null,
    updateCalls: [],
    async update(values, options) {
      this.updateCalls.push({ values, options });
      Object.assign(this, values);
      return this;
    },
  };
  const replacement = {
    id: REPLACEMENT_TEMPLATE_ID,
    waba_id: WABA_ID,
    clinic_id: null,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v11',
    language: 'es',
    status: 'PENDING',
    meta_template_id: '986959627638045',
    catalog_template_id: catalog.id,
    is_active: true,
    resubmitted_from_template_id: SOURCE_TEMPLATE_ID,
    superseded_by_template_id: null,
    updateCalls: [],
    async update(values, options) {
      this.updateCalls.push({ values, options });
      Object.assign(this, values);
      return this;
    },
  };
  const calls = {
    get: [],
    post: 0,
    delete: 0,
    transactions: 0,
  };

  db.WhatsappTemplate.findByPk = async (id) => {
    if (Number(id) === SOURCE_TEMPLATE_ID) return source;
    if (Number(id) === REPLACEMENT_TEMPLATE_ID) return replacement;
    return null;
  };
  db.WhatsappTemplate.findAll = async () => [];
  db.WhatsappTemplateCatalog.findByPk = async (id) => (
    Number(id) === catalog.id ? catalog : null
  );
  db.ClinicMetaAsset.findOne = async () => ({
    wabaId: WABA_ID,
    waAccessToken: 'asset-access-token',
    metaConnection: { accessToken: 'connection-access-token' },
  });
  db.sequelize.transaction = async (callback) => {
    calls.transactions += 1;
    return callback({
      id: 'mock-recovery-transaction',
      LOCK: { UPDATE: 'UPDATE' },
    });
  };
  axios.get = async (url, options) => {
    calls.get.push({ url, params: options.params });
    assert.match(url, new RegExp(`/${WABA_ID}/message_templates$`));
    assert.equal(options.params.access_token, 'asset-access-token');
    assert.equal(options.params.limit, 200);

    if (!options.params.after) {
      return {
        data: {
          data: [{ id: 'unrelated-template', name: 'unrelated_template', status: 'APPROVED' }],
          paging: {
            next: `https://graph.facebook.com/v24.0/${WABA_ID}/message_templates?after=page-2-cursor`,
            cursors: { after: 'page-2-cursor' },
          },
        },
      };
    }

    assert.equal(options.params.after, 'page-2-cursor');
    return {
      data: {
        data: [
          {
            id: source.meta_template_id,
            name: source.name,
            language: source.language,
            category: 'UTILITY',
            status: 'APPROVED',
            components: catalog.components,
          },
          {
            id: replacement.meta_template_id,
            name: replacement.name,
            language: replacement.language,
            category: 'UTILITY',
            status: 'PENDING',
            components: catalog.components,
          },
        ],
      },
    };
  };
  axios.post = async () => {
    calls.post += 1;
    throw new Error('approval-race cleanup must never create another template');
  };
  axios.delete = async (_url, options) => {
    calls.delete += 1;
    assert.equal(options.params.name, replacement.name);
    assert.equal(options.params.hsm_id, replacement.meta_template_id);
    assert.notEqual(options.params.hsm_id, source.meta_template_id);
    return { data: { success: true } };
  };

  const payload = {
    mode: 'resubmit_stale_pending',
    source_template_id: SOURCE_TEMPLATE_ID,
    replacement_template_id: REPLACEMENT_TEMPLATE_ID,
    wabaId: WABA_ID,
    replacement_name: replacement.name,
  };

  try {
    const result = await whatsappTemplatesService.runStalePendingTemplateResubmission(payload);

    assert.equal(calls.get.length, 4, 'source recovery and replacement cleanup must both follow pagination');
    assert.equal(calls.get[0].params.after, undefined);
    assert.equal(calls.get[1].params.after, 'page-2-cursor');
    assert.equal(calls.post, 0);
    assert.equal(calls.delete, 1, 'only the replacement may be deleted after source approval');
    assert.equal(calls.transactions, 1);

    assert.equal(source.status, 'APPROVED');
    assert.equal(source.is_active, true);
    assert.equal(source.pending_since_at, null);
    assert.equal(source.superseded_by_template_id, null);
    assert.equal(source.auto_resubmit_error, null);
    assert.equal(source.updateCalls.length, 1);

    assert.equal(replacement.is_active, false);
    assert.equal(replacement.superseded_by_template_id, SOURCE_TEMPLATE_ID);
    assert.match(replacement.rejection_reason, /source_approved_during_cleanup/);
    assert.equal(replacement.updateCalls.length, 2);

    assert.deepEqual(result, {
      source_template_id: SOURCE_TEMPLATE_ID,
      replacement_template_id: REPLACEMENT_TEMPLATE_ID,
      resumed_cleanup_only: true,
      deleted_old_remote: false,
      old_remote_already_absent: false,
      old_remote_became_approved: true,
      source_reactivated_after_approval_race: true,
      recovered_override_count: 0,
      cancelled_replacement: true,
      replacement_template_id: REPLACEMENT_TEMPLATE_ID,
      replacement_remote_deleted: true,
      replacement_remote_already_absent: false,
    });
  } finally {
    db.WhatsappTemplate.findByPk = originalFindTemplateByPk;
    db.WhatsappTemplate.findAll = originalFindTemplates;
    db.WhatsappTemplateCatalog.findByPk = originalFindCatalogByPk;
    db.ClinicMetaAsset.findOne = originalFindAsset;
    db.sequelize.transaction = originalTransaction;
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
    axios.delete = originalAxiosDelete;
  }
}

async function closeQueues() {
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  await testJobRoutesStalePendingModeOnlyToResubmissionService();
  await testCleanupRetryNeverCreatesAnotherRemoteTemplate();
  await testApprovedSourceOnSecondMetaPageWinsCleanupRace();
  console.log('whatsapp_template_pending_resubmission_job.test.js: OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeQueues);
