'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { catalog, resolveForTurn } = require('../../services/leadAssistantPromotionImages.service');
const { buildDraftRequest } = require('../../services/leadAssistantDialogue.service');
const offers = [
  'C02-03 · Contorno',
  'Imagen: https://media.example.com/eyes/foto.png?v=2',
  '[Ver creatividad](https://media.example.com/eyes/foto.png?v=2)',
  '[Más información](https://clinic.example.com/landing)',
  'C02-04 · Otra oferta',
  '![Cartel de noviembre](https://media.example.com/creative/123)',
  'Imagen: https://localhost/foto.jpg',
  'Imagen: https://127.0.0.1/a.png',
  'Imagen: https://user:secret@media.example.com/x.jpg',
].join('\n');
test('recognises approved photo links under their own promotion and does not expose URLs to the model', () => {
  const indexed = catalog(offers);
  assert.equal(indexed.size, 2);
  const first = indexed.get('C02-03'),
    second = indexed.get('C02-04');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].id, second[0].id);
  const turn = buildDraftRequest({
    clinicName: 'Centro Nube',
    tone: 'Breve',
    approvedFacts: [],
    commercialHistory: [],
    userText: '¿Me enseñas el cartel?',
    availableSlots: [],
    matchedPromotion: { title: 'Contorno', description: 'Primera visita', images: first },
  });
  assert.deepEqual(turn.outputFormat.imageId.enum, ['none', first[0].id]);
  assert(!turn.inputText.includes('https://'));
  assert(!turn.inputText.includes(second[0].id));
});
test('selecting an image reads the one publication used by the active conversation', async () => {
  const indexed = catalog(offers);
  const db = {
    LeadAssistantSession: {
      findOne: async ({ where }) => {
        assert.deepEqual(where, {
          conversation_id: 11,
          clinic_id: 7,
          template_id: 2,
          publication_version: 4,
          state: 'active',
        });
        return { publication_version: 4 };
      },
    },
    Message: {
      findOne: async ({ where }) => {
        assert.deepEqual(where, { id: 34, conversation_id: 11, direction: 'inbound' });
        return {
          metadata: {
            leadAssistantTurn: {
              promotionKey: 'C02-03',
              publicationVersion: 4,
              templateId: 2,
              executionId: 19,
            },
          },
        };
      },
    },
    LeadAssistantPublication: {
      findOne: async ({ where }) => {
        assert.deepEqual(where, { clinic_id: 7, version: 4 });
        return { fields: { promotions: offers } };
      },
    },
  };
  const pick = {
    key: 'C02-03',
    messageId: 34,
    executionId: 19,
    id: indexed.get('C02-03')[0].id,
    version: 4,
    templateId: 2,
  };
  const thread = { id: 11, clinic_id: 7 };
  assert.deepEqual(await resolveForTurn(db, thread, pick), indexed.get('C02-03')[0]);
  assert.equal(await resolveForTurn(db, thread, { ...pick, key: 'C02-04' }), null);
  assert.equal(
    await resolveForTurn(db, thread, { ...pick, id: 'https://stranger.example.com/picture.png' }),
    null
  );
  db.LeadAssistantSession.findOne = async () => null;
  assert.equal(await resolveForTurn(db, thread, pick), null);
});

test('an article link, unmarked references and a promotion still under review never authorise an image', () => {
  const inputs =
    'C01-02 · Oferta\nFuente: https://modmarketing.net/entregas/centro/promociones-noviembre/\n' +
    '[Referencia](https://example.com/referencia.png)\nC02-03 · Oferta en revisión\nImagen: https://example.com/creative.png';
  assert.equal(catalog(inputs).size, 0);
});

test('passes the complete matched offer, including its last price, while isolating other offers', () => {
  const { commercialOffer } = require('../../services/leadAssistantTurn.service');
  const source = [
    '# Promoción de invierno',
    'C02-03 · Contorno de ojos',
    '### Argumentario',
    'Texto aprobado sobre la sesión. '.repeat(1600),
    'Precio 127 € si se adquiere en la sede de prueba. Fuente: https://media.example.com/condicion',
    'C02-04 · Otra oferta',
    'Precio 999 € en otra sede.',
  ].join('\n');
  const matched = commercialOffer({ promotions: source }, { text: 'INFO C02-03' });
  const request = buildDraftRequest({
    clinicName: 'Centro ficticio',
    tone: 'Breve',
    approvedFacts: [],
    commercialHistory: [],
    userText: '¿Cuánto cuesta?',
    availableSlots: [],
    matchedPromotion: matched,
  });
  assert.match(request.inputText, /127 € si se adquiere en la sede de prueba/);
  assert.doesNotMatch(request.inputText, /https:|999 €|Otra oferta/);
});

test('expiry applies to the price and photo using the local clinic date', () => {
  const { commercialOffer } = require('../../services/leadAssistantTurn.service');
  const promotions =
    'C02-03 · Contorno\nVigencia: 2026-11-01 a 2026-11-30\nImagen: https://media.example.com/imagen.jpg';
  const context = { text: 'INFO C02-03' };
  for (const date of ['2026-10-30T15:00:00Z', '2026-11-30T23:22:00Z']) {
    const options = { now: new Date(date), timezone: 'Europe/Madrid' };
    assert.equal(commercialOffer({ promotions }, context, null, options), null);
    assert.equal(catalog(promotions, options).size, 0);
  }
  assert(
    commercialOffer({ promotions }, context, null, {
      now: new Date('2026-11-30T15:22:00Z'),
      timezone: 'Europe/Madrid',
    })
  );
  assert.equal(
    commercialOffer({ promotions: 'Borrador pendiente de aprobación\n' + promotions }, context),
    null
  );
});

test('published Markdown table keeps each offer, price and image separate from the glossary', () => {
  const text = [
    '# Promociones activas · Centro de pruebas', '## Vigencia', 'Durante el mes anunciado.', '## Catálogo',
    '| Tratamiento | Precio y condiciones | Archivo visual |', '| --- | --- | --- |',
    '| **Curso 20** | 20 € | [Portada](https://media.example.com/curso.jpg) |',
    '| **Curso 30** | 30 € | [Portada](https://media.example.com/otro.jpg) |',
    '## Glosario', '| Concepto | Descripción |', '| --- | --- |', '| Curso | No es una oferta |',
  ].join('\n');
  const { commercialOffer } = require('../../services/leadAssistantTurn.service');
  const offer = commercialOffer({promotions:text},{text:'INFO',post:{caption:'Curso 20'}});
  assert.equal(offer.images.length,1);
  assert.equal(offer.images[0].url,'https://media.example.com/curso.jpg');
  assert.match(offer.description,/20 €/);
  assert.doesNotMatch(offer.description,/30 €|otro.jpg|Glosario/);
  assert.equal(commercialOffer({promotions:text},{text:'INFO'}),null);
});
