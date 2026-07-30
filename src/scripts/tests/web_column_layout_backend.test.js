'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateWebDocument } = require('../../lib/webDocument');
const { buildValidWebDocument } = require('./fixtures/webDocumentV1.fixture');

test('column height and order props are accepted only on column sections', () => {
  const valid = buildValidWebDocument();
  valid.nodes.section_hero = {
    ...valid.nodes.section_hero,
    props: {
      ...valid.nodes.section_hero.props,
      structure_role: 'column',
      column_heights: {
        desktop: 320,
        tablet: 240,
      },
      column_orders: {
        desktop: 2,
        mobile: -1,
      },
    },
  };

  assert.equal(validateWebDocument(valid).valid, true);

  const invalid = buildValidWebDocument();
  invalid.nodes.section_hero = {
    ...invalid.nodes.section_hero,
    props: {
      ...invalid.nodes.section_hero.props,
      structure_role: 'row',
      column_heights: {
        desktop: 320,
      },
      column_orders: {
        desktop: 2,
      },
    },
  };

  const result = validateWebDocument(invalid);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === 'columnHeights'));
  assert.ok(result.errors.some((error) => error.keyword === 'columnOrders'));
});
