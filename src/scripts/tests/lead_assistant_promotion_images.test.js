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
