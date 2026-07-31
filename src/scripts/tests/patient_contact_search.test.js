'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../../../models');
const {
  buildFastPatientSearchWhere,
  classifyContactSearchQuery,
  normalizeOperationalSource,
} = require('../../services/patientContact.service');

const { Op } = db.Sequelize;

function collectLikePatterns(value, patterns = []) {
  if (!value || typeof value !== 'object') return patterns;
  for (const key of Reflect.ownKeys(value)) {
    if (key === Op.like) patterns.push(value[key]);
    else collectLikePatterns(value[key], patterns);
  }
  return patterns;
}

test('clasifica teléfonos, emails y nombres sin confundir nombres numéricos cortos', () => {
  assert.equal(classifyContactSearchQuery('+34 654 695 552'), 'phone');
  assert.equal(classifyContactSearchQuery('0033 612345678'), 'phone');
  assert.equal(classifyContactSearchQuery('ana@example.com'), 'email');
  assert.equal(classifyContactSearchQuery('María 2'), 'name');
});

test('la búsqueda telefónica usa candidatos exactos indexables', () => {
  const search = buildFastPatientSearchWhere('654 695 552');
  assert.equal(search.queryType, 'phone');
  const candidates = search.where.telefono_movil[Op.in];
  assert.ok(Array.isArray(candidates));
  assert.ok(candidates.includes('34654695552'));
  assert.ok(candidates.includes('654695552'));
  assert.equal(collectLikePatterns(search.where).length, 0);
});

test('la búsqueda nominal solo construye prefijos y nunca comodines iniciales', () => {
  const search = buildFastPatientSearchWhere('María López');
  assert.equal(search.queryType, 'name');
  const patterns = collectLikePatterns(search.where);
  assert.ok(patterns.length >= 4);
  for (const pattern of patterns) {
    assert.equal(pattern.startsWith('%'), false);
    assert.equal(pattern.endsWith('%'), true);
  }
});

test('el origen de auditoría falla a un valor canónico', () => {
  assert.equal(normalizeOperationalSource('header_search'), 'header_search');
  assert.equal(normalizeOperationalSource('QUICK CHAT'), 'quick_chat');
  assert.equal(normalizeOperationalSource('untrusted-source'), 'patient_modal');
});
