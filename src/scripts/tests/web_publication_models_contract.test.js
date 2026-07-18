'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const modelFactories = {
  WebDomain: require('../../../models/webdomain'),
  WebWordpressInstallation: require('../../../models/webwordpressinstallation'),
  WebPublication: require('../../../models/webpublication'),
  WebPublicationDeployment: require('../../../models/webpublicationdeployment'),
};

function dataTypes() {
  const scalar = (key) => ({ key });
  const INTEGER = Object.assign(scalar('INTEGER'), { UNSIGNED: scalar('INTEGER.UNSIGNED') });
  return {
    STRING: (size) => ({ key: 'STRING', size }),
    INTEGER,
    ENUM: (...values) => ({ key: 'ENUM', values }),
    JSON: scalar('JSON'),
    DATE: scalar('DATE'),
    TEXT: scalar('TEXT'),
  };
}

function build(factory) {
  const capture = {};
  const sequelize = {
    define(name, attributes, options) {
      capture.name = name;
      capture.attributes = attributes;
      capture.options = options;
      return { name, associate(fnModels) { return capture.associate?.(fnModels); } };
    },
  };
  const result = factory(sequelize, dataTypes());
  return { capture, result };
}

test('modelos fijan tablas, scope y claves únicas del contrato', () => {
  const domain = build(modelFactories.WebDomain).capture;
  assert.equal(domain.options.tableName, 'WebDomains');
  assert.deepEqual(domain.attributes.scopeType.type.values, ['clinic', 'group']);
  assert.ok(domain.options.indexes.some((index) => index.unique && index.fields.includes('host')));

  const wordpress = build(modelFactories.WebWordpressInstallation).capture;
  assert.equal(wordpress.options.tableName, 'WebWordpressInstallations');
  assert.equal(wordpress.attributes.tokenHash.field, 'token_hash');
  assert.ok(wordpress.options.indexes.some((index) => index.unique && index.fields.includes('token_hash')));

  const publication = build(modelFactories.WebPublication).capture;
  assert.equal(publication.options.tableName, 'WebPublications');
  assert.deepEqual(publication.attributes.channel.type.values, ['clinicaclick_hosted', 'wordpress', 'custom_domain']);
  assert.ok(publication.options.indexes.some((index) => index.unique && index.fields.join(',') === 'host,path'));

  const deployment = build(modelFactories.WebPublicationDeployment).capture;
  assert.equal(deployment.options.updatedAt, false);
  assert.ok(deployment.options.hooks.beforeUpdate);
  assert.ok(deployment.options.indexes.some((index) => index.unique && index.fields.join(',') === 'publication_id,sequence'));
});

test('deployment no permite mutar identidad o secuencia', () => {
  const deployment = build(modelFactories.WebPublicationDeployment).capture;
  const instance = { changed: () => ['sequence'] };
  assert.throws(() => deployment.options.hooks.beforeUpdate(instance), /append-only/);
  assert.doesNotThrow(() => deployment.options.hooks.beforeUpdate({ changed: () => ['status', 'completedAt'] }));
  assert.throws(
    () => deployment.options.hooks.beforeBulkUpdate({ fields: ['sequence'] }),
    /append-only/
  );
  assert.doesNotThrow(
    () => deployment.options.hooks.beforeBulkUpdate({ fields: ['status', 'completedAt'] })
  );
  assert.throws(() => deployment.options.hooks.beforeBulkDestroy({}), /append-only/);
});
