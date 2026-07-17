#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const outboxService = require('../../services/intakeQuickChatOutbox.service');
const { materializeIntakeQuickChatSummary } = require('../../services/intakeQuickChatSummary.service');
const jobRequestsService = require('../../services/jobRequests.service');
const jobExecutor = require('../../services/jobExecutor.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { BACKGROUND_INTEGRATION_JOB_TYPES } = require('../../config/scheduledJobCatalog');

function makeTransactionalPersistence() {
  const committed = { leads: [], audits: [], jobs: [] };
  const sequelize = {
    async transaction(work) {
      const transaction = {
        LOCK: { UPDATE: 'UPDATE' },
        staged: { leads: [], audits: [], jobs: [] },
      };
      const result = await work(transaction);
      committed.leads.push(...transaction.staged.leads);
      committed.audits.push(...transaction.staged.audits);
      committed.jobs.push(...transaction.staged.jobs);
      return result;
    },
  };
  return { committed, sequelize };
}

async function testAtomicLeadAuditAndEnqueue() {
  const persistence = makeTransactionalPersistence();
  let transactionSeen = null;
  const result = await outboxService.persistLeadAuditAndQuickChatOutbox({
    createLead: async (transaction) => {
      transactionSeen = transaction;
      const lead = { id: 8101 };
      transaction.staged.leads.push(lead);
      return lead;
    },
    rawPayload: {
      source_detail: 'chatbot',
      chat_state: { data: { telefono: '+34600111222', email: 'qa@example.com' } },
      gclid: 'must-stay-in-audit',
    },
    attributionSteps: {
      clinic_match_source: 'chat_location',
      resolved_clinic_id: 56,
      resolved_group_id: 5,
    },
  }, {
    sequelize: persistence.sequelize,
    LeadAttributionAudit: {
      create: async (values, options) => {
        assert.equal(options.transaction, transactionSeen);
        const audit = { id: 8201, ...values };
        options.transaction.staged.audits.push(audit);
        return audit;
      },
    },
    enqueueJobRequest: async (values, options) => {
      assert.equal(options.transaction, transactionSeen);
      const job = { id: 8301, ...values };
      options.transaction.staged.jobs.push(job);
      return job;
    },
  });

  assert.equal(result.lead.id, 8101);
  assert.equal(result.audit.id, 8201);
  assert.equal(result.audit.attribution_steps.resolved_clinic_id, 56);
  assert.equal(result.audit.attribution_steps.resolved_group_id, 5);
  assert.equal(result.job.id, 8301);
  assert.equal(persistence.committed.leads.length, 1);
  assert.equal(persistence.committed.audits.length, 1);
  assert.equal(persistence.committed.jobs.length, 1);
  assert.equal(result.job.type, outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE);
  assert.equal(result.job.priority, 'high');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.maxAttempts, 5);
  assert.deepEqual(result.job.payload, { lead_id: 8101, audit_id: 8201 });
  assert.doesNotMatch(JSON.stringify(result.job.payload), /phone|telefono|email|gclid|consent|chat_state/i);
}

async function testNewDirectSummaryUsesSameAtomicOutbox() {
  const persistence = makeTransactionalPersistence();
  const rawPayload = {
    source_detail: 'chatbot_quickchat',
    chat_state: { data: { telefono: '+34600111222', email: 'direct@example.com' } },
  };
  const result = await outboxService.persistLeadAuditAndQuickChatOutbox({
    createLead: async (transaction) => {
      const lead = { id: 8111 };
      transaction.staged.leads.push(lead);
      return lead;
    },
    rawPayload,
  }, {
    sequelize: persistence.sequelize,
    LeadAttributionAudit: {
      create: async (values, options) => {
        const audit = { id: 8211, ...values };
        options.transaction.staged.audits.push(audit);
        return audit;
      },
    },
    enqueueJobRequest: async (values, options) => {
      const job = { id: 8311, ...values };
      options.transaction.staged.jobs.push(job);
      return job;
    },
  });

  assert.equal(result.audit.raw_payload, rawPayload);
  assert.deepEqual(result.job.payload, { lead_id: 8111, audit_id: 8211 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(persistence.committed).map(([key, rows]) => [key, rows.length])),
    { leads: 1, audits: 1, jobs: 1 },
  );
}

async function testDeduplicatedBothSourcesKeepCurrentAuditAndOutbox() {
  for (const [index, sourceDetail] of ['chatbot', 'chatbot_quickchat'].entries()) {
    const persistence = makeTransactionalPersistence();
    const leadId = 8120 + index;
    const auditId = 8220 + index;
    const existingLead = {
      id: leadId,
      telefono: '+34600111222',
      email: `${sourceDetail}@example.com`,
      async update(patch, options) {
        assert.ok(options.transaction);
        Object.assign(this, patch);
      },
    };
    const rawPayload = {
      source_detail: sourceDetail,
      chat_state: {
        data: {
          telefono: '+34600111222',
          email: `${sourceDetail}@example.com`,
          motivo: `payload-actual-${sourceDetail}`,
        },
      },
    };
    let locked = false;
    const result = await outboxService.persistExistingLeadAuditAndQuickChatOutbox({
      leadId,
      rawPayload,
      attributionSteps: {
        clinic_match_source: 'chat_location',
        resolved_clinic_id: 56,
        resolved_group_id: 5,
      },
      leadUpdates: { clinic_match_value: '56' },
    }, {
      sequelize: persistence.sequelize,
      LeadIntake: {
        findByPk: async (id, options) => {
          assert.equal(id, leadId);
          assert.equal(options.lock, 'UPDATE');
          locked = true;
          return existingLead;
        },
      },
      LeadAttributionAudit: {
        create: async (values, options) => {
          const audit = { id: auditId, ...values };
          options.transaction.staged.audits.push(audit);
          return audit;
        },
      },
      enqueueJobRequest: async (values, options) => {
        const job = { id: 8320 + index, ...values };
        options.transaction.staged.jobs.push(job);
        return job;
      },
    });

    assert.equal(locked, true);
    assert.equal(result.lead, existingLead);
    assert.equal(result.audit.raw_payload, rawPayload, 'the retry payload must not be replaced by the old lead payload');
    assert.equal(result.audit.attribution_steps.resolved_clinic_id, 56);
    assert.equal(result.audit.attribution_steps.resolved_group_id, 5);
    assert.deepEqual(result.job.payload, { lead_id: leadId, audit_id: auditId });
    assert.equal(existingLead.clinic_match_value, '56');
    assert.equal(persistence.committed.leads.length, 0, 'dedupe must not create another LeadIntake');
    assert.equal(persistence.committed.audits.length, 1);
    assert.equal(persistence.committed.jobs.length, 1);
  }
}

async function testBaseEnqueueJoinsCallerTransaction() {
  const transaction = { id: 'intake-transaction' };
  let createOptions = null;
  const job = await jobRequestsService.enqueueJobRequest({
    type: outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE,
    payload: { lead_id: 8011, audit_id: 8012 },
  }, {
    transaction,
    JobRequestModel: {
      create: async (values, options) => {
        createOptions = options;
        return { id: 8013, ...values };
      },
    },
  });
  assert.equal(createOptions.transaction, transaction);
  assert.equal(job.id, 8013);
  assert.equal(job.payload.lead_id, 8011);
  assert.ok(job.payload.__runtime_namespace);
}

async function testEnqueueFailureRollsBackLeadAndAudit() {
  const persistence = makeTransactionalPersistence();
  await assert.rejects(
    outboxService.persistLeadAuditAndQuickChatOutbox({
      createLead: async (transaction) => {
        const lead = { id: 8401 };
        transaction.staged.leads.push(lead);
        return lead;
      },
      rawPayload: { source_detail: 'chatbot', chat_state: { data: { telefono: '+34600111222' } } },
    }, {
      sequelize: persistence.sequelize,
      LeadAttributionAudit: {
        create: async (values, options) => {
          const audit = { id: 8501, ...values };
          options.transaction.staged.audits.push(audit);
          return audit;
        },
      },
      enqueueJobRequest: async (_values, options) => {
        options.transaction.staged.jobs.push({ id: 8601 });
        throw new Error('transient database enqueue failure');
      },
    }),
    /transient database enqueue failure/,
  );
  assert.deepEqual(persistence.committed, { leads: [], audits: [], jobs: [] });
}

async function testInvalidContactRollsBackBeforeAuditAndJob() {
  const persistence = makeTransactionalPersistence();
  let auditCreates = 0;
  let enqueueCalls = 0;
  await assert.rejects(
    outboxService.persistLeadAuditAndQuickChatOutbox({
      createLead: async (transaction) => {
        const lead = { id: 8701, telefono: '14725', email: 'qa@example.com' };
        transaction.staged.leads.push(lead);
        return lead;
      },
      rawPayload: {
        source_detail: 'chatbot',
        chat_state: { data: { telefono: '14725', email: 'qa@example.com' } },
      },
    }, {
      sequelize: persistence.sequelize,
      LeadAttributionAudit: {
        create: async () => {
          auditCreates += 1;
          return { id: 8702 };
        },
      },
      enqueueJobRequest: async () => {
        enqueueCalls += 1;
        return { id: 8703 };
      },
    }),
    (error) => error?.status === 422 && error?.code === 'quickchat_phone_invalid',
  );
  assert.equal(auditCreates, 0);
  assert.equal(enqueueCalls, 0);
  assert.deepEqual(
    persistence.committed,
    { leads: [], audits: [], jobs: [] },
    'phone 14725 must leave zero lead/audit/job rows after transaction rollback',
  );

  const invalidEmailPersistence = makeTransactionalPersistence();
  await assert.rejects(
    outboxService.persistLeadAuditAndQuickChatOutbox({
      createLead: async (transaction) => {
        const lead = { id: 8801, telefono: '+34600111222', email: 'correo-invalido' };
        transaction.staged.leads.push(lead);
        return lead;
      },
      rawPayload: {
        source_detail: 'chatbot',
        chat_state: { data: { telefono: '+34600111222', email: 'correo-invalido' } },
      },
    }, {
      sequelize: invalidEmailPersistence.sequelize,
      LeadAttributionAudit: { create: async () => ({ id: 8802 }) },
      enqueueJobRequest: async () => ({ id: 8803 }),
    }),
    (error) => error?.status === 422 && error?.code === 'quickchat_email_invalid',
  );
  assert.deepEqual(invalidEmailPersistence.committed, { leads: [], audits: [], jobs: [] });
}

function auditModel(rawPayload, {
  auditId = 9201,
  leadId = 9101,
  attributionSteps = {},
} = {}) {
  const audit = {
    id: auditId,
    lead_intake_id: leadId,
    raw_payload: rawPayload,
    attribution_steps: attributionSteps,
  };
  return {
    findOne: async ({ where }) => (
      Number(where.id) === auditId && Number(where.lead_intake_id) === leadId ? audit : null
    ),
    findByPk: async (id) => (Number(id) === auditId ? audit : null),
  };
}

async function testHandlerIsExactAndIdempotent() {
  const rawPayload = {
    source_detail: 'chatbot',
    attribution: {
      page_url: 'https://example.test/actual',
      landing_url: 'https://example.test/landing',
    },
    chat_state: { data: { telefono: '+34600111222', nombre: 'QA outbox' } },
  };
  let materialized = false;
  let messageCount = 0;
  const materializeCalls = [];
  const materialize = async (input) => {
    materializeCalls.push(input);
    const created = !materialized;
    if (created) messageCount += 1;
    materialized = true;
    return {
      created,
      updated: false,
      consolidated: false,
      clinic_id: 56,
      lead_id: 9101,
      conversation_id: 9301,
      message_id: 9401,
      message: { id: 9401 },
    };
  };
  const overrides = {
    LeadAttributionAudit: auditModel(rawPayload),
    materializeIntakeQuickChatSummary: materialize,
    emitQuickChatSummarySocketEvent: () => {},
  };

  const first = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: 9101,
    audit_id: 9201,
  }, overrides);
  const duplicate = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: 9101,
    audit_id: 9201,
  }, overrides);

  assert.equal(first.status, 'completed');
  assert.equal(first.result.created, true);
  assert.equal(duplicate.status, 'completed');
  assert.equal(duplicate.result.created, false);
  assert.equal(messageCount, 1, 'a duplicate outbox execution must not create a second summary');
  assert.equal(materializeCalls[0].leadId, 9101);
  assert.equal(materializeCalls[0].auditId, 9201);
  assert.equal(materializeCalls[0].clinicId, null, 'legacy audits fall back to the persisted lead clinic');
  assert.equal(materializeCalls[0].body.source_detail, 'chatbot_quickchat');
  assert.equal(materializeCalls[0].pageUrl, 'https://example.test/actual');
  assert.equal(materializeCalls[0].landingUrl, 'https://example.test/landing');

  const mismatch = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: 9999,
    audit_id: 9201,
  }, overrides);
  assert.equal(mismatch.status, 'failed');
  assert.equal(mismatch.retryable, false);
  assert.equal(mismatch.result.reason, 'audit_lead_mismatch');
}

async function testStaleAuditCompletesWithoutSocketOrRewrite() {
  let socketEmits = 0;
  const result = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: 9131,
    audit_id: 9231,
  }, {
    LeadAttributionAudit: auditModel({
      source_detail: 'chatbot',
      chat_state: { data: { telefono: '+34600111222', nombre: 'Antiguo' } },
    }, { leadId: 9131, auditId: 9231 }),
    materializeIntakeQuickChatSummary: async (input) => {
      assert.equal(input.auditId, 9231);
      return {
        created: false,
        updated: false,
        consolidated: false,
        stale: true,
        persisted_audit_id: 9232,
        clinic_id: 56,
        lead_id: 9131,
        conversation_id: 9331,
        message_id: 9431,
        message: null,
      };
    },
    emitQuickChatSummarySocketEvent: () => {
      socketEmits += 1;
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.result.quickchat_summary_saved, true);
  assert.equal(result.result.skipped, true);
  assert.equal(result.result.stale, true);
  assert.equal(result.result.reason, 'stale_audit');
  assert.equal(result.result.persisted_audit_id, 9232);
  assert.equal(socketEmits, 0, 'a stale audit must not emit a realtime update');
}

async function testResolvedClinicMismatchIsTerminalBeforeMessageOrSocket() {
  let messageCreates = 0;
  let canonicalCalls = 0;
  let socketEmits = 0;
  const lead = {
    id: 9141,
    clinica_id: 56,
    telefono: '+34600111222',
    email: 'cross-clinic@example.com',
  };
  const result = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: lead.id,
    audit_id: 9241,
  }, {
    LeadAttributionAudit: auditModel({
      source_detail: 'chatbot',
      chat_state: { data: { telefono: '+34600111222', email: lead.email } },
    }, {
      leadId: lead.id,
      auditId: 9241,
      attributionSteps: {
        resolved_clinic_id: 58,
        resolved_group_id: 5,
      },
    }),
    materializeIntakeQuickChatSummary: (input) => materializeIntakeQuickChatSummary(input, {
      sequelize: {
        transaction: async (work) => work({ LOCK: { UPDATE: 'UPDATE' } }),
      },
      LeadIntake: {
        findByPk: async (id) => (Number(id) === lead.id ? lead : null),
      },
      Message: {
        findAll: async () => [],
        create: async () => {
          messageCreates += 1;
          return { id: 9441 };
        },
      },
      findCanonicalWhatsappConversation: async () => {
        canonicalCalls += 1;
        return { id: 9341 };
      },
    }),
    emitQuickChatSummarySocketEvent: () => {
      socketEmits += 1;
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.error.status, 409);
  assert.equal(result.error.code, 'quickchat_summary_clinic_mismatch');
  assert.equal(result.result.reason, 'quickchat_summary_clinic_mismatch');
  assert.equal(result.result.http_status, 409);
  assert.equal(result.result.error_code, 'quickchat_summary_clinic_mismatch');
  assert.equal(result.result.error_message, 'El lead pertenece a otra clínica');
  assert.equal(messageCreates, 0);
  assert.equal(canonicalCalls, 0);
  assert.equal(socketEmits, 0);

  const fastPathResult = await outboxService.triggerIntakeQuickChatSummaryFastPath(9541, {
    jobScheduler: { triggerImmediate: async () => false },
    jobRequestsService: {
      findJobById: async () => ({
        id: 9541,
        status: 'failed',
        result_summary: result.result,
      }),
    },
  });
  assert.equal(fastPathResult.quickchat_summary_saved, false);
  assert.equal(fastPathResult.quickchat_summary_queued, false);
  assert.equal(fastPathResult.http_status, 409);
  assert.equal(fastPathResult.error_code, 'quickchat_summary_clinic_mismatch');
  assert.equal(fastPathResult.error_message, 'El lead pertenece a otra clínica');
}

async function testInvalidResolvedClinicIsTerminalBeforeMaterializer() {
  let materializeCalls = 0;
  const result = await outboxService.runIntakeQuickChatSummaryMaterializeJob({
    lead_id: 9142,
    audit_id: 9242,
  }, {
    LeadAttributionAudit: auditModel({
      source_detail: 'chatbot_quickchat',
      chat_state: { data: { telefono: '+34600111222' } },
    }, {
      leadId: 9142,
      auditId: 9242,
      attributionSteps: { resolved_clinic_id: 'sede-manipulada' },
    }),
    materializeIntakeQuickChatSummary: async () => {
      materializeCalls += 1;
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.result.http_status, 422);
  assert.equal(result.result.error_code, 'quickchat_summary_resolved_clinic_invalid');
  assert.equal(materializeCalls, 0);
}

async function testHandlerRetriesTransientMaterializationForBothSources() {
  for (const [index, sourceDetail] of ['chatbot', 'chatbot_quickchat'].entries()) {
    const leadId = 9110 + index;
    const auditId = 9210 + index;
    const materializeInputs = [];
    let attempts = 0;
    const overrides = {
      LeadAttributionAudit: auditModel({
        source_detail: sourceDetail,
        chat_state: { data: { telefono: '+34600111222', motivo: sourceDetail } },
      }, { auditId, leadId }),
      materializeIntakeQuickChatSummary: async (input) => {
        materializeInputs.push(input);
        attempts += 1;
        if (attempts === 1) throw new Error(`ECONNRESET ${sourceDetail}`);
        return {
          created: true,
          updated: false,
          consolidated: false,
          clinic_id: 56,
          lead_id: leadId,
          conversation_id: 9310 + index,
          message_id: 9410 + index,
          message: { id: 9410 + index },
        };
      },
      emitQuickChatSummarySocketEvent: () => {},
    };

    await assert.rejects(
      outboxService.runIntakeQuickChatSummaryMaterializeJob({ lead_id: leadId, audit_id: auditId }, overrides),
      new RegExp(`ECONNRESET ${sourceDetail}`),
    );
    const retried = await outboxService.runIntakeQuickChatSummaryMaterializeJob(
      { lead_id: leadId, audit_id: auditId },
      overrides,
    );
    assert.equal(retried.status, 'completed');
    assert.equal(retried.result.quickchat_summary_saved, true);
    assert.equal(materializeInputs.length, 2);
    assert.equal(materializeInputs[1].body.source_detail, 'chatbot_quickchat');
  }
}

async function testTransientFailureUsesStandardRetryContract() {
  const originalRun = outboxService.runIntakeQuickChatSummaryMaterializeJob;
  let attempts = 0;
  outboxService.runIntakeQuickChatSummaryMaterializeJob = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('ECONNRESET while reading the audit');
    return {
      status: 'completed',
      result: { quickchat_summary_saved: true, lead_id: 9501, audit_id: 9502 },
    };
  };

  try {
    const job = {
      id: 9503,
      type: outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE,
      attempts: 1,
      max_attempts: 5,
      payload: { lead_id: 9501, audit_id: 9502 },
    };
    const failed = await jobExecutor.runJob(job);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error.message, /ECONNRESET/);
    assert.equal(jobScheduler._hasRetryAttemptRemaining(job), true);
    assert.ok(jobScheduler._buildRetryAt(job).getTime() > Date.now());

    const originalMarkWaiting = jobRequestsService.markWaiting;
    let waitingSettlement = null;
    jobRequestsService.markWaiting = async (jobId, patch) => {
      waitingSettlement = { jobId, patch };
      return { updated: 1 };
    };
    try {
      const now = new Date('2026-07-14T00:00:00.000Z');
      await jobScheduler._settleJobResult(job, failed, { now });
      assert.equal(waitingSettlement.jobId, job.id);
      assert.match(waitingSettlement.patch.errorMessage, /ECONNRESET/);
      assert.ok(waitingSettlement.patch.nextRunAt.getTime() > now.getTime());
    } finally {
      jobRequestsService.markWaiting = originalMarkWaiting;
    }

    const retried = await jobExecutor.runJob({ ...job, attempts: 2 });
    assert.equal(retried.status, 'completed');
    assert.equal(retried.result.result.quickchat_summary_saved, true);
    assert.equal(attempts, 2);
  } finally {
    outboxService.runIntakeQuickChatSummaryMaterializeJob = originalRun;
  }
}

async function testPostCommitFastPathReadsSafeResult() {
  const job = {
    id: 9701,
    type: outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE,
    attempts: 1,
    max_attempts: 5,
    status: 'pending',
    result_summary: null,
  };
  const originalMarkCompleted = jobRequestsService.markCompleted;
  jobRequestsService.markCompleted = async (jobId, { resultSummary }) => {
    assert.equal(jobId, job.id);
    job.status = 'completed';
    // Settlement persiste el `result` que recibe; este caso cubre el formato
    // directo y los casos inferiores cubren también el wrapper del executor.
    job.result_summary = resultSummary;
    return { updated: 1 };
  };
  try {
    await jobScheduler._settleJobResult(job, {
      status: 'completed',
      result: {
        quickchat_summary_saved: true,
        lead_id: 9702,
        audit_id: 9703,
        conversation_id: 9704,
        message_id: 9705,
      },
    });
  } finally {
    jobRequestsService.markCompleted = originalMarkCompleted;
  }
  const result = await outboxService.triggerIntakeQuickChatSummaryFastPath(job.id, {
    jobScheduler: {
      triggerImmediate: async (id) => {
        assert.equal(id, job.id);
        return false;
      },
    },
    jobRequestsService: {
      findJobById: async () => job,
    },
  });
  assert.equal(result.quickchat_summary_saved, true);
  assert.equal(result.message_id, 9705);

  job.status = 'waiting';
  job.result_summary = { skipped: true, reason: 'transient_failure' };
  const waitingResult = await outboxService.triggerIntakeQuickChatSummaryFastPath(job.id, {
    jobScheduler: { triggerImmediate: async () => false },
    jobRequestsService: { findJobById: async () => job },
  });
  assert.equal(waitingResult.quickchat_summary_saved, false);
  assert.equal(waitingResult.quickchat_summary_queued, true);
  assert.equal(waitingResult.job_status, 'waiting');

  job.status = 'completed';
  job.result_summary = { skipped: true, reason: 'audit_not_found' };
  const skippedResult = await outboxService.triggerIntakeQuickChatSummaryFastPath(job.id, {
    jobScheduler: { triggerImmediate: async () => true },
    jobRequestsService: { findJobById: async () => job },
  });
  assert.equal(skippedResult.quickchat_summary_saved, false);
  assert.equal(skippedResult.quickchat_summary_queued, false);
  assert.equal(skippedResult.job_status, 'completed');

  const waitingAfterTriggerError = await outboxService.triggerIntakeQuickChatSummaryFastPath(9801, {
    jobScheduler: {
      triggerImmediate: async () => {
        throw new Error('dispatcher response lost');
      },
    },
    jobRequestsService: {
      findJobById: async () => ({ id: 9801, status: 'waiting', result_summary: null }),
    },
  });
  assert.equal(waitingAfterTriggerError.quickchat_summary_saved, false);
  assert.equal(waitingAfterTriggerError.quickchat_summary_queued, true);
  assert.equal(waitingAfterTriggerError.job_status, 'waiting');
  assert.equal(waitingAfterTriggerError.quickchat_summary_state, 'queued');

  const savedAfterTriggerError = await outboxService.triggerIntakeQuickChatSummaryFastPath(9802, {
    jobScheduler: {
      triggerImmediate: async () => {
        throw new Error('response lost after settlement');
      },
    },
    jobRequestsService: {
      findJobById: async () => ({
        id: 9802,
        status: 'completed',
        result_summary: {
          quickchat_summary_saved: true,
          lead_id: 9803,
          audit_id: 9804,
          conversation_id: 9805,
          message_id: 9806,
        },
      }),
    },
  });
  assert.equal(savedAfterTriggerError.quickchat_summary_saved, true);
  assert.equal(savedAfterTriggerError.job_status, 'completed');

  const unknownAfterReadError = await outboxService.triggerIntakeQuickChatSummaryFastPath(9807, {
    jobScheduler: {
      triggerImmediate: async () => {
        throw new Error('dispatcher unavailable');
      },
    },
    jobRequestsService: {
      findJobById: async () => {
        throw new Error('database read unavailable');
      },
    },
  });
  assert.equal(unknownAfterReadError.quickchat_summary_saved, false);
  assert.equal(unknownAfterReadError.quickchat_summary_queued, false);
  assert.equal(unknownAfterReadError.quickchat_summary_outcome_unknown, true);
  assert.equal(unknownAfterReadError.quickchat_summary_state, 'unknown_durable');
}

function testRegistrationInventoryAndNoProviderPath() {
  assert.equal(Object.keys(jobExecutor.JOB_HANDLERS).length, 49);
  assert.equal(
    typeof jobExecutor.JOB_HANDLERS[outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE],
    'function',
  );
  assert.equal(
    BACKGROUND_INTEGRATION_JOB_TYPES.includes(outboxService.INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE),
    false,
    'the outbox must use the standard high-priority lane, not the provider integration lane',
  );

  const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/intakeQuickChatOutbox.service.js'),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /sendMetaEvent|maybeUploadGoogleConversion|outboundWhatsApp|queues\.|sendMessage\(/,
    'the QuickChat outbox must not call advertising or message transports',
  );
  assert.doesNotMatch(
    source,
    /node-cron|cron\.schedule|setInterval\(|setTimeout\(|repeat\s*:/,
    'the QuickChat outbox must rely only on JobRequest scheduling/retries',
  );
}

async function run() {
  await testAtomicLeadAuditAndEnqueue();
  await testNewDirectSummaryUsesSameAtomicOutbox();
  await testDeduplicatedBothSourcesKeepCurrentAuditAndOutbox();
  await testBaseEnqueueJoinsCallerTransaction();
  await testEnqueueFailureRollsBackLeadAndAudit();
  await testInvalidContactRollsBackBeforeAuditAndJob();
  await testHandlerIsExactAndIdempotent();
  await testStaleAuditCompletesWithoutSocketOrRewrite();
  await testResolvedClinicMismatchIsTerminalBeforeMessageOrSocket();
  await testInvalidResolvedClinicIsTerminalBeforeMaterializer();
  await testHandlerRetriesTransientMaterializationForBothSources();
  await testTransientFailureUsesStandardRetryContract();
  await testPostCommitFastPathReadsSafeResult();
  testRegistrationInventoryAndNoProviderPath();
  console.log('intake_quickchat_outbox.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
