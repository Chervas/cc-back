'use strict';

require('dotenv').config();
const db = require('../models');
db.sequelize.options.logging = false;

const SOURCE_CLINIC_ID = 55;
const TARGET_CLINIC_ID = 56;
const GROUP_ID = 5;
const SOURCE_CAMPAIGN_ID = 6;
const TARGET_CAMPAIGN_ID = 7;
const SOURCE_ONBOARDING_REQUEST_ID = 15;
const SOURCE_STRATEGY_REQUEST_ID = 16;
const TARGET_ONBOARDING_REQUEST_ID = 17;
const TARGET_STRATEGY_REQUEST_ID = 18;
const ACTIVE_REVIEW_LIST_ID = 134;
const ACTIVE_REVIEW_JOB_ID = 17361;
const CANONICAL_NAME = 'Propdental Sant Martí';
const CANONICAL_URL = 'https://www.propdental.es/clinicas-dentales/clinica-dental-sant-marti/';

const CLINIC_CONTACTS = Object.freeze({
  19: {
    url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-sants/',
    telefono: '660 70 12 62',
    telefono_fijo: '660 70 12 62',
  },
  35: {
    url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-nou-barris/',
    telefono: '640 81 41 47',
    telefono_fijo: '640 81 41 47',
  },
  56: {
    url_web: CANONICAL_URL,
    telefono: '602 48 08 29',
    telefono_fijo: '602 48 08 29',
  },
  58: {
    url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-badalona/',
    telefono: '675 11 69 13',
    telefono_fijo: '675 11 69 13',
  },
  59: {
    url_web: 'https://www.propdental.es/clinicas-dentales/clinica-dental-hospitalet/',
    telefono: '618 25 55 31',
    telefono_fijo: '618 25 55 31',
  },
});

const HANDLED_REFERENCE_TABLES = new Set([
  'AutomationFlowTemplatesV2',
  'AutomationFlows',
  'CampaignRequests',
  'Campaigns',
  'ExternalCampaignAssignments',
  'GoogleAdsInsightsDaily',
  'GroupAssetClinicAssignments',
  'IntakeConfigs',
  'WhatsappTemplates',
]);

function plain(row) {
  return row && typeof row.get === 'function' ? row.get({ plain: true }) : row;
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function externalCampaignKey(campaign) {
  const provider = String(campaign?.provider || '').trim().toLowerCase();
  const account = String(campaign?.account_id || campaign?.customer_id || '').replace(/\D/g, '');
  const campaignId = String(campaign?.external_campaign_id || campaign?.campaign_id || '').trim();
  return provider && account && campaignId ? `${provider}:${account}:${campaignId}` : null;
}

function mergeExternalTargets(sourcePayload, targetPayload) {
  const target = jsonObject(targetPayload);
  const sourceTargets = Array.isArray(sourcePayload?.external_targets) ? sourcePayload.external_targets : [];
  const targetTargets = Array.isArray(target.external_targets) ? target.external_targets : [];
  const campaigns = new Map();

  for (const item of [...targetTargets, ...sourceTargets]) {
    for (const campaign of (Array.isArray(item?.campaigns) ? item.campaigns : [])) {
      const key = externalCampaignKey(campaign);
      if (key && !campaigns.has(key)) campaigns.set(key, campaign);
    }
  }

  const baseTarget = targetTargets.find((item) => String(item?.kind || '').toLowerCase() === 'generic')
    || sourceTargets.find((item) => String(item?.kind || '').toLowerCase() === 'generic')
    || { kind: 'generic', treatment_id: null, treatment_name: null };

  return {
    ...target,
    scope: {
      ...jsonObject(target.scope),
      group_id: GROUP_ID,
      clinic_id: TARGET_CLINIC_ID,
      clinic_ids: [TARGET_CLINIC_ID],
      assignment_scope: 'clinic',
    },
    destination: {
      default_url: CANONICAL_URL,
      specific_url: CANONICAL_URL,
      subtree_path: null,
      effective_url: CANONICAL_URL,
      measurement_scope: 'sitewide',
      subtree_match_mode: 'starts_with',
    },
    target_destinations: [{
      kind: 'generic',
      uses_web: true,
      treatment_id: null,
      treatment_name: null,
      confirmed_url: CANONICAL_URL,
    }],
    external_targets: [{
      ...baseTarget,
      kind: 'generic',
      treatment_id: null,
      treatment_name: null,
      campaigns: Array.from(campaigns.values()),
    }],
  };
}

async function queryRows(sql, replacements = {}, transaction = null) {
  const [rows] = await db.sequelize.query(sql, { replacements, transaction });
  return rows;
}

async function directReferenceCounts(transaction = null) {
  const columns = await queryRows(`
    SELECT TABLE_NAME, COLUMN_NAME
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = :database
       AND LOWER(COLUMN_NAME) IN ('clinic_id', 'clinica_id', 'clinicaid', 'id_clinica')
       AND DATA_TYPE IN ('int', 'bigint', 'smallint', 'mediumint', 'tinyint', 'varchar', 'char')
     ORDER BY TABLE_NAME, COLUMN_NAME
  `, { database: process.env.DB_NAME }, transaction);
  const result = [];
  for (const column of columns) {
    const tableName = String(column.TABLE_NAME).replace(/`/g, '``');
    const columnName = String(column.COLUMN_NAME).replace(/`/g, '``');
    const rows = await queryRows(
      `SELECT COUNT(*) AS count FROM \`${tableName}\` WHERE CAST(\`${columnName}\` AS CHAR) = :sourceId`,
      { sourceId: String(SOURCE_CLINIC_ID) },
      transaction,
    );
    const count = Number(rows[0]?.count || 0);
    if (count && tableName !== 'Clinicas') result.push({ table: tableName, column: columnName, count });
  }
  return result;
}

async function reviewQueueSnapshot(transaction = null) {
  const [list] = await queryRows(`
    SELECT l.id, l.status, l.clinica_id, l.clinic_ids,
           JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.dispatch.status')) AS dispatch_status,
           JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.dispatch.next_allowed_at')) AS next_allowed_at,
           COUNT(i.id) AS items,
           SUM(i.clinica_id = :targetId) AS target_items,
           SUM(i.clinica_id = :sourceId) AS source_items,
           SUM(i.dispatch_status IN ('sent','delivered','read','replied')) AS progressed_items,
           SUM(COALESCE(i.dispatch_status, '') NOT IN ('sent','delivered','read','replied','failed','excluded','cancelled')) AS remaining_items
      FROM MarketingPatientLists l
 LEFT JOIN MarketingPatientListItems i ON i.list_id = l.id
     WHERE l.id = :listId
     GROUP BY l.id
  `, {
    targetId: TARGET_CLINIC_ID,
    sourceId: SOURCE_CLINIC_ID,
    listId: ACTIVE_REVIEW_LIST_ID,
  }, transaction);
  const [job] = await queryRows(`
    SELECT id, type, status, next_run_at, payload
      FROM JobRequests
     WHERE id = :jobId
  `, { jobId: ACTIVE_REVIEW_JOB_ID }, transaction);
  const activeSourceJobs = await queryRows(`
    SELECT id, type, status, payload
      FROM JobRequests
     WHERE status IN ('pending','queued','running','waiting')
       AND (
         REPLACE(CAST(payload AS CHAR), ' ', '') LIKE '%"clinic_id":55%'
         OR REPLACE(CAST(payload AS CHAR), ' ', '') LIKE '%"clinica_id":55%'
         OR REPLACE(CAST(payload AS CHAR), ' ', '') LIKE '%"clinicId":55%'
         OR REPLACE(CAST(payload AS CHAR), ' ', '') LIKE '%"clinicIds":[55%'
       )
  `, {}, transaction);
  return { list: list || null, job: job || null, activeSourceJobs };
}

async function whatsappTemplateReferenceCount(templateIds, transaction = null) {
  if (!templateIds.length) return 0;
  const idPattern = templateIds.join('|');
  const checks = [
    ['AutomationFlowTemplatesV2', 'nodes', 'clinic_id <> 55 OR clinic_id IS NULL'],
    ['AutomationFlows', 'acciones', 'clinica_id <> 55 OR clinica_id IS NULL'],
    ['AutomationFlows', 'pasos', 'clinica_id <> 55 OR clinica_id IS NULL'],
    ['MarketingPatientLists', 'criteria', '1=1'],
    ['JobRequests', 'payload', "status IN ('pending','queued','running','waiting')"],
  ];
  let count = 0;
  for (const [table, column, where] of checks) {
    const rows = await queryRows(`
      SELECT COUNT(*) AS count
        FROM \`${table}\`
       WHERE (${where})
         AND CAST(\`${column}\` AS CHAR) REGEXP '"whatsapp_template_id"[[:space:]]*:[[:space:]]*(${idPattern})([^0-9]|$)'
    `, {}, transaction);
    count += Number(rows[0]?.count || 0);
  }
  return count;
}

async function loadState(transaction = null, lock = false) {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const clinics = await queryRows(
    `SELECT * FROM Clinicas WHERE id_clinica IN (:sourceId, :targetId) ORDER BY id_clinica${lockClause}`,
    { sourceId: SOURCE_CLINIC_ID, targetId: TARGET_CLINIC_ID },
    transaction,
  );
  const requests = await queryRows(
    `SELECT * FROM CampaignRequests WHERE id IN (:sourceOnboarding, :sourceStrategy, :targetOnboarding, :targetStrategy) ORDER BY id${lockClause}`,
    {
      sourceOnboarding: SOURCE_ONBOARDING_REQUEST_ID,
      sourceStrategy: SOURCE_STRATEGY_REQUEST_ID,
      targetOnboarding: TARGET_ONBOARDING_REQUEST_ID,
      targetStrategy: TARGET_STRATEGY_REQUEST_ID,
    },
    transaction,
  );
  const campaigns = await queryRows(
    `SELECT * FROM Campaigns WHERE id IN (:sourceCampaign, :targetCampaign) ORDER BY id${lockClause}`,
    { sourceCampaign: SOURCE_CAMPAIGN_ID, targetCampaign: TARGET_CAMPAIGN_ID },
    transaction,
  );
  const sourceTemplates = await queryRows(
    `SELECT id FROM WhatsappTemplates WHERE clinic_id = :sourceId ORDER BY id${lockClause}`,
    { sourceId: SOURCE_CLINIC_ID },
    transaction,
  );
  return { clinics, requests, campaigns, sourceTemplates };
}

function assertExpectedState(state, references, queue) {
  const source = state.clinics.find((clinic) => Number(clinic.id_clinica) === SOURCE_CLINIC_ID);
  const target = state.clinics.find((clinic) => Number(clinic.id_clinica) === TARGET_CLINIC_ID);
  if (!target || Number(target.grupoClinicaId) !== GROUP_ID) {
    throw new Error('Target clinic 56 is missing or no longer belongs to group 5');
  }
  if (!source) {
    if (target.nombre_clinica === CANONICAL_NAME && target.url_web === CANONICAL_URL) return 'already_consolidated';
    throw new Error('Source clinic 55 is missing but target 56 is not canonical');
  }
  if (Number(source.grupoClinicaId) !== GROUP_ID || !/^Propdental Sant Marti$/i.test(String(source.nombre_clinica || ''))) {
    throw new Error('Source clinic 55 no longer matches the expected Propdental duplicate');
  }
  if (!/^Propdental Glòries$/i.test(String(target.nombre_clinica || '')) && target.nombre_clinica !== CANONICAL_NAME) {
    throw new Error('Target clinic 56 has an unexpected name');
  }

  const unexpected = references.filter((reference) => !HANDLED_REFERENCE_TABLES.has(reference.table));
  if (unexpected.length) {
    throw new Error(`Unhandled clinic 55 references: ${JSON.stringify(unexpected)}`);
  }
  if (!queue.list || Number(queue.list.clinica_id) !== TARGET_CLINIC_ID || Number(queue.list.source_items || 0) !== 0) {
    throw new Error('Review queue 134 no longer belongs exclusively to clinic 56');
  }
  if (!queue.job || Number(queue.job.id) !== ACTIVE_REVIEW_JOB_ID || Number(queue.job.payload?.list_id) !== ACTIVE_REVIEW_LIST_ID) {
    throw new Error('Review dispatch job 17361 changed unexpectedly');
  }
  if (queue.activeSourceJobs.length) {
    throw new Error(`Active jobs still reference clinic 55: ${queue.activeSourceJobs.map((job) => job.id).join(', ')}`);
  }
  return 'ready';
}

async function applyConsolidation(transaction, state, queueBefore) {
  const requestById = new Map(state.requests.map((request) => [Number(request.id), request]));
  const sourceStrategy = requestById.get(SOURCE_STRATEGY_REQUEST_ID);
  const targetStrategy = requestById.get(TARGET_STRATEGY_REQUEST_ID);
  if (!sourceStrategy || !targetStrategy) throw new Error('Expected strategy requests 16 and 18 are missing');

  const mergedTargetPayload = mergeExternalTargets(
    jsonObject(sourceStrategy.solicitud),
    jsonObject(targetStrategy.solicitud),
  );
  const mergedCampaignCount = mergedTargetPayload.external_targets
    .flatMap((target) => target.campaigns || [])
    .length;
  if (mergedCampaignCount !== 8) {
    throw new Error(`Expected 8 unique external campaigns after merge, got ${mergedCampaignCount}`);
  }

  const now = new Date();
  const completedSourcePayload = {
    ...jsonObject(sourceStrategy.solicitud),
    scope: {
      ...jsonObject(jsonObject(sourceStrategy.solicitud).scope),
      group_id: GROUP_ID,
      clinic_id: TARGET_CLINIC_ID,
      clinic_ids: [TARGET_CLINIC_ID],
      assignment_scope: 'clinic',
    },
    status: 'completed',
    completed_at: now.toISOString(),
    merged_into: {
      clinic_id: TARGET_CLINIC_ID,
      campaign_id: TARGET_CAMPAIGN_ID,
      campaign_request_id: TARGET_STRATEGY_REQUEST_ID,
      reason: 'Consolidación de la identidad histórica Sant Martí/Glòries',
    },
  };

  const sourceOnboarding = requestById.get(SOURCE_ONBOARDING_REQUEST_ID);
  const sourceOnboardingPayload = jsonObject(sourceOnboarding?.solicitud);
  if (!sourceOnboarding) throw new Error('Expected onboarding request 15 is missing');
  sourceOnboardingPayload.scope = {
    ...jsonObject(sourceOnboardingPayload.scope),
    group_id: GROUP_ID,
    clinic_id: TARGET_CLINIC_ID,
    assignment_scope: 'clinic',
  };
  sourceOnboardingPayload.merged_into_clinic_id = TARGET_CLINIC_ID;

  await db.sequelize.query(`
    UPDATE CampaignRequests
       SET clinica_id = :targetId,
           solicitud = :payload,
           updated_at = :now
     WHERE id = :requestId
  `, {
    replacements: { targetId: TARGET_CLINIC_ID, payload: JSON.stringify(mergedTargetPayload), now, requestId: TARGET_STRATEGY_REQUEST_ID },
    transaction,
  });
  await db.sequelize.query(`
    UPDATE CampaignRequests
       SET clinica_id = :targetId,
           estado = 'finalizada',
           solicitud = :payload,
           updated_at = :now
     WHERE id = :requestId
  `, {
    replacements: { targetId: TARGET_CLINIC_ID, payload: JSON.stringify(completedSourcePayload), now, requestId: SOURCE_STRATEGY_REQUEST_ID },
    transaction,
  });
  await db.sequelize.query(`
    UPDATE CampaignRequests
       SET clinica_id = :targetId,
           solicitud = :payload,
           updated_at = :now
     WHERE id = :requestId
  `, {
    replacements: { targetId: TARGET_CLINIC_ID, payload: JSON.stringify(sourceOnboardingPayload), now, requestId: SOURCE_ONBOARDING_REQUEST_ID },
    transaction,
  });
  await db.sequelize.query(`
    UPDATE Campaigns
       SET clinica_id = :targetId,
           activa = 0,
           fecha_fin = COALESCE(fecha_fin, :now),
           updated_at = :now
     WHERE id = :campaignId
  `, {
    replacements: { targetId: TARGET_CLINIC_ID, now, campaignId: SOURCE_CAMPAIGN_ID },
    transaction,
  });

  const assignments = await queryRows(`
    SELECT id, clinica_id, version
      FROM ExternalCampaignAssignments
     WHERE clinica_id = :sourceId
     FOR UPDATE
  `, { sourceId: SOURCE_CLINIC_ID }, transaction);
  if (assignments.length !== 4) throw new Error(`Expected 4 source campaign assignments, got ${assignments.length}`);
  for (const assignment of assignments) {
    const fromVersion = Number(assignment.version || 1);
    const toVersion = fromVersion + 1;
    await db.sequelize.query(`
      UPDATE ExternalCampaignAssignments
         SET clinica_id = :targetId,
             version = :toVersion,
             match_kind = 'manual',
             match_explanation = 'Identidad Sant Martí/Glòries consolidada en la clínica canónica 56',
             updated_at = :now
       WHERE id = :id
         AND version = :fromVersion
    `, {
      replacements: { targetId: TARGET_CLINIC_ID, toVersion, now, id: assignment.id, fromVersion },
      transaction,
    });
    await db.sequelize.query(`
      INSERT INTO ExternalCampaignAssignmentAudits
        (assignment_id, event_type, actor_type, actor_user_id, from_version, to_version, reason, changes, created_at)
      VALUES
        (:id, 'association_updated', 'system', NULL, :fromVersion, :toVersion,
         'Consolidación de clínica Propdental Sant Martí 55 en 56', :changes, :now)
    `, {
      replacements: {
        id: assignment.id,
        fromVersion,
        toVersion,
        changes: JSON.stringify({ clinica_id: { before: SOURCE_CLINIC_ID, after: TARGET_CLINIC_ID } }),
        now,
      },
      transaction,
    });
  }

  const [insightsUpdate] = await db.sequelize.query(`
    UPDATE GoogleAdsInsightsDaily
       SET clinicaId = :targetId
     WHERE clinicaId = :sourceId
  `, { replacements: { sourceId: SOURCE_CLINIC_ID, targetId: TARGET_CLINIC_ID }, transaction });
  if (Number(insightsUpdate?.affectedRows ?? insightsUpdate) !== 664) {
    throw new Error(`Expected to move 664 Google Ads insight rows, got ${JSON.stringify(insightsUpdate)}`);
  }

  const sourceTemplateIds = state.sourceTemplates.map((row) => Number(row.id)).filter(Boolean);
  const externalTemplateRefs = await whatsappTemplateReferenceCount(sourceTemplateIds, transaction);
  if (externalTemplateRefs !== 0) {
    throw new Error(`Source WhatsApp templates still have ${externalTemplateRefs} references outside clinic 55`);
  }

  await db.sequelize.query('DELETE FROM AutomationFlowTemplatesV2 WHERE clinic_id = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });
  await db.sequelize.query('DELETE FROM AutomationFlows WHERE clinica_id = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });
  await db.sequelize.query('DELETE FROM GroupAssetClinicAssignments WHERE clinicaId = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });
  await db.sequelize.query('DELETE FROM IntakeConfigs WHERE clinic_id = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });
  await db.sequelize.query('DELETE FROM WhatsappTemplates WHERE clinic_id = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });

  for (const [clinicIdRaw, values] of Object.entries(CLINIC_CONTACTS)) {
    const clinicId = Number(clinicIdRaw);
    await db.sequelize.query(`
      UPDATE Clinicas
         SET url_web = :urlWeb,
             telefono = :phone,
             telefono_fijo = :fixedPhone
       WHERE id_clinica = :clinicId
         AND grupoClinicaId = :groupId
    `, {
      replacements: {
        urlWeb: values.url_web,
        phone: values.telefono,
        fixedPhone: values.telefono_fijo,
        clinicId,
        groupId: GROUP_ID,
      },
      transaction,
    });
  }

  const targetClinic = state.clinics.find((clinic) => Number(clinic.id_clinica) === TARGET_CLINIC_ID);
  const targetConfig = jsonObject(targetClinic.configuracion);
  targetConfig.disciplinas = Array.isArray(targetConfig.disciplinas) && targetConfig.disciplinas.length
    ? targetConfig.disciplinas
    : ['dental'];
  targetConfig.marketing_aliases = Array.from(new Set([
    ...(Array.isArray(targetConfig.marketing_aliases) ? targetConfig.marketing_aliases : []),
    'Sant Martí', 'Sant Marti', 'Glòries', 'Glories', 'Encants',
  ]));
  await db.sequelize.query(`
    UPDATE Clinicas
       SET nombre_clinica = :name,
           url_web = :urlWeb,
           configuracion = :config
     WHERE id_clinica = :targetId
  `, {
    replacements: {
      name: CANONICAL_NAME,
      urlWeb: CANONICAL_URL,
      config: JSON.stringify(targetConfig),
      targetId: TARGET_CLINIC_ID,
    },
    transaction,
  });

  const referencesBeforeDelete = await directReferenceCounts(transaction);
  const remainingSourceReferences = referencesBeforeDelete.filter((reference) => reference.count > 0);
  if (remainingSourceReferences.length) {
    throw new Error(`Clinic 55 still has direct references before delete: ${JSON.stringify(remainingSourceReferences)}`);
  }
  await db.sequelize.query('DELETE FROM Clinicas WHERE id_clinica = :sourceId', {
    replacements: { sourceId: SOURCE_CLINIC_ID }, transaction,
  });

  const queueAfter = await reviewQueueSnapshot(transaction);
  const stableFields = ['id', 'status', 'clinica_id', 'dispatch_status', 'next_allowed_at', 'items', 'target_items', 'source_items'];
  for (const field of stableFields) {
    if (String(queueBefore.list?.[field] ?? '') !== String(queueAfter.list?.[field] ?? '')) {
      throw new Error(`Review queue 134 changed during consolidation (${field})`);
    }
  }
  if (String(queueBefore.job?.status || '') !== String(queueAfter.job?.status || '')
    || String(queueBefore.job?.next_run_at || '') !== String(queueAfter.job?.next_run_at || '')) {
    throw new Error('Review job 17361 changed during consolidation');
  }

  return { mergedCampaignCount, movedAssignments: assignments.length, movedInsights: 664 };
}

async function main() {
  const simulate = process.argv.includes('--simulate');
  const apply = process.argv.includes('--apply') || simulate;
  let transaction = null;
  try {
    if (apply) transaction = await db.sequelize.transaction();
    const state = await loadState(transaction, apply);
    const references = await directReferenceCounts(transaction);
    const queue = await reviewQueueSnapshot(transaction);
    const status = assertExpectedState(state, references, queue);

    const summary = {
      mode: simulate ? 'simulate' : (apply ? 'apply' : 'dry-run'),
      status,
      clinics: state.clinics.map((clinic) => ({
        id: clinic.id_clinica,
        name: clinic.nombre_clinica,
        url_web: clinic.url_web,
      })),
      references,
      sourceWhatsappTemplates: state.sourceTemplates.length,
      reviewQueue: queue,
    };

    if (status === 'already_consolidated') {
      if (transaction) await transaction.rollback();
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (!apply) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    summary.result = await applyConsolidation(transaction, state, queue);
    if (simulate) {
      await transaction.rollback();
      transaction = null;
      summary.status = 'simulation_rolled_back';
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    await transaction.commit();
    transaction = null;
    summary.status = 'consolidated';
    summary.postcheck = {
      clinics: await queryRows('SELECT id_clinica,nombre_clinica,url_web,telefono FROM Clinicas WHERE id_clinica IN (55,56) ORDER BY id_clinica'),
      sourceReferences: await directReferenceCounts(),
      reviewQueue: await reviewQueueSnapshot(),
    };
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  } finally {
    await db.sequelize.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
