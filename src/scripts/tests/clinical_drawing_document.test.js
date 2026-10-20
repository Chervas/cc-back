'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateDrawingDocument } = require('../../lib/clinical-drawing-document');
const stroke = () => ({ id: 'owned-stroke', type: 'pen', color: '#4f46e5', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
test('all anatomical templates and PDF pages use normalized geometry and inert text', () => {
  for (const [template, view] of [['facial', 'front'], ['corporal', 'back'], ['capilar', 'crown'], ['image', 'page-2']]) {
    const document = { version: 1, views: { [view]: { strokes: [stroke()], notes: [{ id: 'owned-note', x: 0.5, y: 0.25, text: '<script>inert note</script>' }],
      regions: { frontal: 'Observación clínica' }, photos: [{ id: 'cpa_owned', region: 'frontal', caption: 'Imagen de referencia' }] } } };
    assert.equal(validateDrawingDocument(document, template).views[view].strokes[0].points[1].x, 1);
  }
});
test('drawing identity never coerces IDs or writes object prototype properties', () => {
  for (const id of [[], ['owned'], {}, 123, '__proto__', 'constructor', 'prototype', 'https://external']) {
    assert.throws(() => validateDrawingDocument({ version: 1, views: { front: { strokes: [{ ...stroke(), id }] } } }, 'facial'), { code: 'clinical_drawing_invalid' });
  }
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    const document = JSON.parse('{"version":1,"views":{"front":{"regions":{"' + id + '":"note"}}}}');
    assert.throws(() => validateDrawingDocument(document, 'facial'), { code: 'clinical_drawing_invalid' });
  }
  assert.equal({}.note, undefined);
});
test('drawing rejects unknown views, invalid coordinates, duplicate IDs and oversized input', () => {
  const cases = [
    [{ version: 1, views: { unknown: {} } }, 'facial'],
    [{ version: 1, views: { front: {} } }, '__proto__'],
    [{ version: 1, views: { front: { strokes: [{ ...stroke(), points: [{ x: 1.1, y: 0 }] }] } } }, 'facial'],
    [{ version: 1, views: { front: { strokes: [stroke(), stroke()] } } }, 'facial'],
    [{ version: 1, views: { front: { notes: [{ id: 'n', x: 0, y: 0, text: '\0' }] } } }, 'facial'],
    [{ version: 1, views: { front: { strokes: [{ ...stroke(), width: 100 }] } } }, 'facial'],
  ];
  for (const [document, template] of cases) assert.throws(() => validateDrawingDocument(document, template), { code: 'clinical_drawing_invalid' });
});
