'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../services/marketingBulkSends.service.js'), 'utf8');

function fixture() {
  const calls = { candidates: 0, treatmentOptions: 0, queries: 0 };
  const missing = { items: [], total: 4, summary: { total: 4, linked: 4, high_confidence: 3, unattributed: 0 } };
  const sandbox = {
    module: { exports: {} }, console, OBJECTIVE_ID: 'mass_sends', REVIEW_REQUEST_CANDIDATE_LIMIT: 100000,
    QueryTypes: { SELECT: 'SELECT' }, Op: { in: Symbol('in') },
    normalizeReviewRequestSource: value => value || 'manual_selection', parseReviewTreatmentIds: () => [],
    parseReviewImportListId: () => null, applyReviewClinicFilter: scope => scope,
    clampInteger: (value, fallback) => Number(value) || fallback, normalizeText: value => String(value || '').trim(),
    buildItemsForReviewRequest: async () => { calls.candidates++; return [{ status: 'ready', name: 'FICTITIOUS' }]; },
    buildReviewTreatmentOptions: async () => { calls.treatmentOptions++; return []; },
    resolveReviewBusinessLocationIdsForClinics: async () => [11],
    db: { sequelize: { query: async query => {
      assert(/^(SELECT|WITH)\b/.test(query.trim()), 'overview is read-only'); calls.queries++; return [];
    } } },
    Clinica: { findAll: async () => [{ id_clinica: 59, nombre_clinica: 'FICTITIOUS CLINIC' }] },
    getReviewAutomationTemplate: async () => null, getLastReviewRequestTemplateForScope: async () => null,
    findApprovedReviewWhatsappTemplate: async () => ({ id: 51 }),
    findApprovedReviewReminderWhatsappTemplate: async () => ({ id: 52 }),
    hasGoogleReviewUrlForScope: async () => true, hasWhatsappConfigForScope: async () => true,
    templateHasImageHeader: () => false, serializeReviewAutomationTemplate: () => null,
    sortReviewRequestItemsByRecentCare: items => items, applyReviewClinicReadinessExclusions: items => items,
    buildTemplateSnapshot: template => template, buildGoogleRatingSummary: () => ({}),
    buildReviewResponseHeatmaps: () => ({}), serializeItem: item => item,
    require: name => {
      assert.equal(name, './googleReviewHistory.service');
      return { countHistoricalMatches: async () => 4, listMissingReviews: async () => missing };
    },
  };
  const functions = [['getReviewRequestSummary', 'buildReviewAutomationTemplateIdentity'],
    ['buildReviewClinicStatuses', 'buildReviewReadinessExclusion']].map(([name, next]) => {
    const start = source.indexOf('async function ' + name + '(');
    const end = source.indexOf('\nfunction ' + next + '(', start);
    assert(start > 0 && end > start); return source.slice(start, end);
  }).join('\n');
  vm.runInNewContext(functions + '\nmodule.exports = { getReviewRequestSummary, buildReviewClinicStatuses };', sandbox);
  return { api: sandbox.module.exports, calls, missing };
}

for (const scopeType of ['clinic', 'group']) {
  test(scopeType + ' overview reuses stored metrics without recipient planning or provider requests', async () => {
    const f = fixture();
    const result = await f.api.getReviewRequestSummary({ scope: scopeType, clinicIds: [59] }, { summary_mode: 'overview' });
    assert.equal(f.calls.candidates, 0); assert.equal(f.calls.treatmentOptions, 0);
    assert(f.calls.queries > 0); assert.equal(result.summary.audience_evaluated, false);
    assert.equal(result.summary.possible_patients, null);
    assert.equal(result.summary.google_review_history.summary.total, 4);
    assert.equal(result.summary.google_reviews_matched, 4);
    assert.equal(result.summary.whatsapp_available, true);
    assert.equal(result.summary.approved_template_available, true);
    if (scopeType === 'group') assert.equal(result.summary.clinic_statuses[0].possible_patients, null);
  });
  test(scopeType + ' full summary keeps recipient evaluation and existing send readiness', async () => {
    const f = fixture();
    const result = await f.api.getReviewRequestSummary({ scope: scopeType, clinicIds: [59] }, {});
    assert.equal(f.calls.candidates, scopeType === 'group' ? 2 : 1);
    assert.equal(f.calls.treatmentOptions, 1);
    assert.equal(result.summary.audience_evaluated, true);
    assert.equal(result.summary.possible_patients, 1);
    assert.equal(result.summary.candidates_preview[0].name, 'FICTITIOUS');
  });
}
