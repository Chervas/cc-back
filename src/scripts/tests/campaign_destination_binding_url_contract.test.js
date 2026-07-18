'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  _artifactPublicationUrl: artifactPublicationUrl,
  _publicationUrl: publicationUrl,
  sha256,
} = require('../../services/campaignDestinationBindings.service');

function stableHttpsDestination(raw) {
  const parsed = new URL(raw);
  return { valid: parsed.protocol === 'https:', url: parsed.toString() };
}

test('artifact and publication resolve to the same canonical directory URL', () => {
  const dependencies = { stableHttpsDestination };
  const expected = publicationUrl({ host: 'landing.example.test', path: '/hospitalet/implantes/' }, dependencies);
  const artifact = artifactPublicationUrl({ baseUrl: 'https://landing.example.test/hospitalet/implantes' }, dependencies);

  assert.equal(expected, 'https://landing.example.test/hospitalet/implantes/');
  assert.equal(artifact, expected);
  assert.equal(sha256(artifact), sha256(expected));
});

test('root publication remains canonical and does not gain a double slash', () => {
  const dependencies = { stableHttpsDestination };
  assert.equal(
    artifactPublicationUrl({ baseUrl: 'https://landing.example.test' }, dependencies),
    publicationUrl({ host: 'landing.example.test', path: '/' }, dependencies)
  );
});
