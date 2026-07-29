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
  assert.deepEqual(faq.schema_config, { enabled: true, profile: 'auto', include_sources: false });
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
  const schemaConfigured = validateWebContentEntry({
    type: 'article',
    locale: 'es-ES',
    title: 'Artículo con schema',
    content: {
      title: 'Implantes dentales',
      excerpt: 'Guía clara.',
      sections: [{ heading: 'Preparación', paragraphs: ['Primer párrafo.'] }],
    },
    schema_config: { enabled: true, profile: 'Article', include_sources: true },
  });
  assert.deepEqual(schemaConfigured.schema_config, { enabled: true, profile: 'Article', include_sources: true });
  const articleImageId = '4f94b3a8-3120-48b1-9cb2-98609e93a8bd';
  const articleWithImage = validateWebContentEntry({
    type: 'article',
    locale: 'es-ES',
    title: 'Artículo con imagen',
    content: {
      title: 'Implantes dentales',
      excerpt: 'Guía clara.',
      sections: [{ heading: 'Preparación', paragraphs: ['Primer párrafo.'] }],
      image_asset_id: articleImageId,
      alt_text: 'Paciente sonriendo tras revisar su tratamiento dental',
    },
  });
  assert.equal(articleWithImage.content.image_asset_id, articleImageId);
  assert.equal(articleWithImage.content.alt_text, 'Paciente sonriendo tras revisar su tratamiento dental');
  const imageFields = contentFieldValues({ title: 'Artículo interno', content: articleWithImage.content });
  assert.equal(imageFields.image_asset_id, articleImageId);
  assert.equal(imageFields.alt_text, articleWithImage.content.alt_text);
  assert.match(articleWithImage.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(schemaConfigured.hash, validateWebContentEntry({
    type: 'article',
    locale: 'es-ES',
    title: 'Artículo con schema',
    content: {
      title: 'Implantes dentales',
      excerpt: 'Guía clara.',
      sections: [{ heading: 'Preparación', paragraphs: ['Primer párrafo.'] }],
    },
    schema_config: { enabled: false, profile: 'Article', include_sources: true },
  }).hash);
  assert.throws(
    () => validateWebContentEntry({
      type: 'faq',
      title: 'FAQ mal perfilada',
      content: { question: 'Pregunta', answer: 'Respuesta' },
      schema_config: { enabled: true, profile: 'Article' },
    }),
    (error) => error instanceof WebContentValidationError && error.code === 'invalid_content_schema_profile'
  );
  assert.throws(
    () => validateWebContentEntry({
      type: 'article',
      title: 'Artículo con URL manual',
      content: {
        title: 'Implantes dentales',
        excerpt: 'Guía clara.',
        sections: [{ heading: 'Preparación', paragraphs: ['Primer párrafo.'] }],
        image_public_url: 'https://example.com/image.webp',
      },
    }),
    (error) => error instanceof WebContentValidationError && error.code === 'invalid_content_field'
  );
  assert.throws(
    () => validateWebContentEntry({
      type: 'article',
      title: 'Artículo sin alt',
      content: {
        title: 'Implantes dentales',
        excerpt: 'Guía clara.',
        sections: [{ heading: 'Preparación', paragraphs: ['Primer párrafo.'] }],
        image_asset_id: articleImageId,
      },
    }),
    (error) => error instanceof WebContentValidationError && error.code === 'content_image_alt_required'
  );
  assert.throws(
    () => validateWebContentEntry({
      type: 'faq',
      title: 'FAQ con imagen',
      content: {
        question: 'Pregunta',
        answer: 'Respuesta',
        image_asset_id: articleImageId,
        alt_text: 'Imagen no admitida',
      },
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
