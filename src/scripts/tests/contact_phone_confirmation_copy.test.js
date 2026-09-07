'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JOBS_AUTO_START = 'false';

const migration = require('../../../migrations/20260907115000-update-contact-phone-confirmation-copy')._test;
const rollout = require('../../services/whatsappLanguageRollout.service')._test;

test('el seguimiento confirma el teléfono, no la cita, en todos los idiomas', () => {
  const spanish = migration.COPY_BY_CATALOG_ID[25];
  const catalan = migration.COPY_BY_CATALOG_ID[88];
  const english = migration.COPY_BY_CATALOG_ID[89];

  assert.match(spanish.catalog, /¿Nos confirmas que lo es\?/);
  assert.match(spanish.catalog, /recordarte tu cita el día de antes/);
  assert.doesNotMatch(spanish.catalog, /confirmas tu cita/);
  assert.match(catalan.catalog, /Ens confirmes que ho és\?/);
  assert.doesNotMatch(catalan.catalog, /confirmes la cita/);
  assert.match(english.catalog, /Could you confirm that it is\?/);
  assert.doesNotMatch(english.catalog, /confirm your appointment/);
});

test('la migración actualiza el texto manual base y las variantes por idioma', () => {
  const result = migration.updateSendNodeConfig({
    fallback_catalog_template_id: 25,
    manual_message_text: 'texto anterior',
    language_routing: {
      variants: {
        ca: { fallback_catalog_template_id: 88, manual_message_text: 'text anterior' },
        en: { fallback_catalog_template_id: 89, manual_message_text: 'previous text' },
      },
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.config.manual_message_text, migration.COPY_BY_CATALOG_ID[25].manual);
  assert.equal(
    result.config.language_routing.variants.ca.manual_message_text,
    migration.COPY_BY_CATALOG_ID[88].manual,
  );
  assert.equal(
    result.config.language_routing.variants.en.manual_message_text,
    migration.COPY_BY_CATALOG_ID[89].manual,
  );
});

test('el rollout lingüístico reconoce la nueva copia española', () => {
  const spanish = migration.COPY_BY_CATALOG_ID[25].manual;
  assert.equal(rollout.translateManualMessage(spanish, 'ca'), migration.COPY_BY_CATALOG_ID[88].manual);
  assert.equal(rollout.translateManualMessage(spanish, 'en'), migration.COPY_BY_CATALOG_ID[89].manual);
});
