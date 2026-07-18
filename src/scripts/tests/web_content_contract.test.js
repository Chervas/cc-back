'use strict';

const assert = require('node:assert/strict');
const {
  WebContentValidationError,
  assertWebContentSnapshot,
  contentFieldValues,
  projectSafeMediaVariants,
  validateWebContentEntry,
  validateWebMediaPresentation,
} = require('../../lib/webContent');

function main() {
  const faq = validateWebContentEntry({
    type: 'faq',
    locale: 'es-ES',
    title: '¿La primera visita tiene coste?',
    content: {
      question: '¿La primera visita tiene coste?',
      answer: 'La clínica te informará de las condiciones antes de confirmar la cita.',
    },
    sources: [{
      label: 'Condiciones de la clínica',
      url: 'https://example.com/condiciones',
    }],
  });
  assert.match(faq.hash, /^[a-f0-9]{64}$/);
  assert.equal(faq.content.answer.includes('<'), false);
  const faqFields = contentFieldValues({ title: 'Nombre interno FAQ', content: faq.content });
  assert.equal(faqFields.title, 'Nombre interno FAQ');
  assert.equal(faqFields.question, faq.content.question);
  assert.equal(faqFields.answer, faq.content.answer);
  assert.equal(faqFields.description, faq.content.answer);

  const propositionFields = contentFieldValues({
    title: 'Nombre interno de propuesta',
    content: { headline: 'Titular visible', summary: 'Resumen visible' },
  });
  assert.equal(propositionFields.title, 'Nombre interno de propuesta');
  assert.equal(propositionFields.headline, 'Titular visible');
  assert.equal(propositionFields.summary, 'Resumen visible');

  const benefitFields = contentFieldValues({
    title: 'Nombre interno de beneficio',
    content: { title: 'Beneficio visible', description: 'Descripción visible' },
  });
  assert.equal(benefitFields.title, 'Nombre interno de beneficio');
  assert.equal(benefitFields.content_title, 'Beneficio visible');
  assert.equal(benefitFields.description, 'Descripción visible');

  assert.throws(
    () => validateWebContentEntry({
      type: 'faq',
      title: 'Inseguro',
      content: { question: 'Pregunta', answer: '<img src=x onerror=alert(1)>' },
    }),
    (error) => error instanceof WebContentValidationError && error.code === 'content_markup_forbidden'
  );
  assert.throws(
    () => validateWebContentEntry({
      type: 'faq',
      title: 'Fuente con secreto',
      content: { question: 'Pregunta', answer: 'Respuesta' },
      sources: [{ label: 'Privada', url: 'https://example.com/doc?access_token=secret#patient' }],
    }),
    (error) => error.code === 'invalid_https_url'
  );
  assert.throws(
    () => validateWebContentEntry({
      type: 'faq',
      title: 'Con campo libre',
      content: { question: 'Pregunta', answer: 'Respuesta', raw_html: '<b>Respuesta</b>' },
    }),
    (error) => error instanceof WebContentValidationError && error.code === 'invalid_content_field'
  );

  const media = validateWebMediaPresentation({
    title: 'Equipo de recepción',
    alt_text: 'Equipo de recepción de la clínica',
    decorative: false,
    focal_points: { desktop: { x: 50, y: 40 }, mobile: { x: 70, y: 45 } },
    rights: { origin: 'owned', credit: 'Clínica' },
  });
  assert.deepEqual(media.focal_points.mobile, { x: 70, y: 45 });
  assert.throws(
    () => validateWebMediaPresentation({
      title: 'Sin alt',
      decorative: false,
      rights: { origin: 'owned' },
    }),
    (error) => error.code === 'informative_media_alt_required'
  );
  assert.throws(
    () => validateWebMediaPresentation({
      title: 'Stock sin licencia',
      alt_text: 'Clínica',
      decorative: false,
      rights: { origin: 'stock' },
    }),
    (error) => error.code === 'media_license_required'
  );
  assert.deepEqual(projectSafeMediaVariants([
    { key: 'image', url: 'https://media.example.com/image.webp', content_type: 'image/webp' },
    { key: 'video', url: 'https://media.example.com/video.mp4', content_type: 'video/mp4' },
  ]), [{
    key: 'image',
    url: 'https://media.example.com/image.webp',
    content_type: 'image/webp',
    width: null,
    height: null,
  }]);

  assertWebContentSnapshot({
    schema_version: 1,
    content_entries: {},
    media_assets: {},
    live_bindings: [],
  });
  assert.throws(
    () => assertWebContentSnapshot({
      schema_version: 1,
      content_entries: {},
      media_assets: { a: { hmac_key: 'never' } },
      live_bindings: [],
    }),
    (error) => error.code === 'content_snapshot_sensitive_field'
  );

  console.log('web content contract: ok');
}

main();
