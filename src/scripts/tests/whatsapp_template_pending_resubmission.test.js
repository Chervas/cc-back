#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluatePendingTemplateAutoResubmit,
  buildPendingTemplateResubmitDedupeScope,
  shouldKeepRemoteTemplateActive,
} = require('../../lib/whatsapp-template-pending-resubmission');

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-07-15T06:30:00.000Z');

function pendingWabaTemplate(overrides = {}) {
  return {
    id: 1036,
    waba_id: '455445070989662',
    clinic_id: null,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v8',
    language: 'es',
    category: 'UTILITY',
    status: 'PENDING',
    catalog_template_id: 39,
    origin: 'external',
    is_active: true,
    components: [{
      type: 'BODY',
      text: 'Hola {{1}}, te enviamos indicaciones para llegar a la clínica.',
    }],
    meta_template_id: '1396277975650530',
    pending_since_at: new Date(NOW.getTime() - HOUR_MS - 1),
    auto_resubmit_attempt_count: 0,
    auto_resubmit_attempted_at: null,
    resubmitted_from_template_id: null,
    superseded_by_template_id: null,
    ...overrides,
  };
}

function activeCatalog(overrides = {}) {
  return {
    id: 39,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: 'Hola {{1}}, te enviamos indicaciones para llegar a la clínica.',
    }],
    is_active: true,
    ...overrides,
  };
}

function evaluate(row, overrides = {}) {
  return evaluatePendingTemplateAutoResubmit({
    row,
    catalog: activeCatalog(),
    now: NOW,
    approvedSiblingExists: false,
    pendingThresholdMs: HOUR_MS,
    featureEnabled: true,
    ...overrides,
  });
}

test('solo es elegible tras superar estrictamente 60 minutos en PENDING o IN_REVIEW', () => {
  const olderThanThreshold = evaluate(pendingWabaTemplate());
  assert.equal(olderThanThreshold.eligible, true);

  const exactlyAtThreshold = evaluate(pendingWabaTemplate({
    pending_since_at: new Date(NOW.getTime() - HOUR_MS),
  }));
  assert.equal(exactlyAtThreshold.eligible, false);
  assert.equal(exactlyAtThreshold.reason, 'pending_threshold_not_met');

  const belowThreshold = evaluate(pendingWabaTemplate({
    pending_since_at: new Date(NOW.getTime() - HOUR_MS + 1),
  }));
  assert.equal(belowThreshold.eligible, false);
  assert.equal(belowThreshold.reason, 'pending_threshold_not_met');

  const inReview = evaluate(pendingWabaTemplate({ status: 'IN_REVIEW' }));
  assert.equal(inReview.eligible, true);
});

test('el interruptor y una fecha pendiente ausente o inválida impiden el reenvío', () => {
  const disabled = evaluate(pendingWabaTemplate(), { featureEnabled: false });
  assert.equal(disabled.eligible, false);
  assert.equal(disabled.reason, 'feature_disabled');

  for (const pendingSince of [null, '', 'not-a-date']) {
    const decision = evaluate(pendingWabaTemplate({ pending_since_at: pendingSince }));
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, 'pending_threshold_not_met');
  }
});

test('excluye APPROVED, filas sin catálogo, catálogos inactivos, filas inactivas y overrides', () => {
  const cases = [
    {
      label: 'estado aprobado',
      row: pendingWabaTemplate({ status: 'APPROVED' }),
      expectedReason: 'not_pending',
    },
    {
      label: 'sin vínculo de catálogo',
      row: pendingWabaTemplate({ catalog_template_id: null }),
      expectedReason: 'not_catalog',
    },
    {
      label: 'catálogo inexistente',
      row: pendingWabaTemplate(),
      catalog: null,
      expectedReason: 'not_catalog',
    },
    {
      label: 'catálogo inactivo',
      row: pendingWabaTemplate(),
      catalog: activeCatalog({ is_active: false }),
      expectedReason: 'catalog_inactive',
    },
    {
      label: 'fila inactiva',
      row: pendingWabaTemplate({ is_active: false }),
      expectedReason: 'inactive',
    },
    {
      label: 'override de clínica',
      row: pendingWabaTemplate({ clinic_id: 35 }),
      expectedReason: 'clinic_override',
    },
    {
      label: 'sin identidad remota',
      row: pendingWabaTemplate({ meta_template_id: null }),
      expectedReason: 'missing_remote_identity',
    },
    {
      label: 'contrato de catálogo obsoleto',
      row: pendingWabaTemplate({
        components: [{ type: 'BODY', text: 'Contenido anterior.' }],
      }),
      expectedReason: 'catalog_contract_stale',
    },
  ];

  for (const fixture of cases) {
    const decision = evaluate(fixture.row, {
      ...(Object.hasOwn(fixture, 'catalog') ? { catalog: fixture.catalog } : {}),
    });
    assert.equal(decision.eligible, false, fixture.label);
    assert.equal(decision.reason, fixture.expectedReason, fixture.label);
  }
});

test('un APPROVED hermano, una sustitución previa o un intento consumido excluyen la fila', () => {
  const approvedSibling = evaluate(pendingWabaTemplate(), { approvedSiblingExists: true });
  assert.equal(approvedSibling.eligible, false);
  assert.equal(approvedSibling.reason, 'approved_sibling_exists');

  const superseded = evaluate(pendingWabaTemplate({ superseded_by_template_id: 1078 }));
  assert.equal(superseded.eligible, false);
  assert.equal(superseded.reason, 'superseded');

  const replacement = evaluate(pendingWabaTemplate({
    id: 1078,
    name: 'clinicaclick_recordatorio_mismo_dia_primera_visita_acceso_dificil_v11',
    auto_resubmit_attempt_count: 1,
    auto_resubmit_attempted_at: NOW,
    resubmitted_from_template_id: 1036,
  }));
  assert.equal(replacement.eligible, false);
  assert.equal(replacement.reason, 'attempt_already_consumed');
});

test('el scope de dedupe es estable por fila y separa candidatos distintos', () => {
  const source = pendingWabaTemplate();
  const first = buildPendingTemplateResubmitDedupeScope(source);
  const sameImmutableIdentity = buildPendingTemplateResubmitDedupeScope({
    ...source,
    status: 'IN_REVIEW',
    pending_since_at: new Date('2026-07-15T01:00:00.000Z'),
  });
  const otherSource = buildPendingTemplateResubmitDedupeScope(pendingWabaTemplate({ id: 1037 }));

  assert.equal(typeof first, 'string');
  assert.ok(first.length > 0);
  assert.equal(first, sameImmutableIdentity);
  assert.notEqual(first, otherSource);
  assert.match(first, /1036/);
  assert.doesNotMatch(first, /token|secret|access/i);
});

test('sync nunca reactiva una plantilla superseded aunque siga presente remotamente', () => {
  assert.equal(shouldKeepRemoteTemplateActive({
    existing: pendingWabaTemplate({ is_active: false, superseded_by_template_id: 1078 }),
    catalogIsActive: true,
    isStaleReviewTemplate: false,
  }), false);

  assert.equal(shouldKeepRemoteTemplateActive({
    existing: pendingWabaTemplate({ superseded_by_template_id: null }),
    catalogIsActive: true,
    isStaleReviewTemplate: false,
  }), true);

  assert.equal(shouldKeepRemoteTemplateActive({
    existing: null,
    catalogIsActive: false,
    isStaleReviewTemplate: false,
  }), false);

  assert.equal(shouldKeepRemoteTemplateActive({
    existing: null,
    catalogIsActive: true,
    isStaleReviewTemplate: true,
  }), false);
});
