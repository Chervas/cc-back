'use strict';

const assert = require('node:assert/strict');
const { Sequelize, DataTypes } = require('sequelize');

function defineModels() {
  const sequelize = new Sequelize('mysql://test:test@127.0.0.1:3306/clinicaclick_contract_test', { logging: false });
  const models = {
    Clinica: sequelize.define('Clinica', { id_clinica: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
    GrupoClinica: sequelize.define('GrupoClinica', { id_grupo: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
    Usuario: sequelize.define('Usuario', { id_usuario: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
    PublicMediaAsset: sequelize.define('PublicMediaAsset', { id: { type: DataTypes.INTEGER, primaryKey: true } }, { timestamps: false }),
  };
  models.WebMediaAsset = require('../../../models/webmediaasset')(sequelize, DataTypes);
  models.WebContentEntry = require('../../../models/webcontententry')(sequelize, DataTypes);
  models.WebContentEntryVersion = require('../../../models/webcontententryversion')(sequelize, DataTypes);
  models.WebMediaAsset.associate(models);
  models.WebContentEntry.associate(models);
  models.WebContentEntryVersion.associate(models);
  return { sequelize, models };
}

async function main() {
  const { sequelize, models } = defineModels();
  try {
    assert.equal(models.WebMediaAsset.tableName, 'WebMediaAssets');
    assert.equal(models.WebContentEntry.tableName, 'WebContentEntries');
    assert.equal(models.WebContentEntryVersion.tableName, 'WebContentEntryVersions');
    assert.equal(models.WebMediaAsset.rawAttributes.id.type.options.length, 36);
    assert.equal(models.WebContentEntry.rawAttributes.id.type.options.length, 36);
    assert.ok(models.WebMediaAsset.associations.publicMediaAsset);
    assert.ok(models.WebContentEntry.associations.versions);

    const content = models.WebContentEntry.build({
      id: '11111111-1111-4111-8111-111111111111',
      scopeType: 'clinic',
      clinicaId: 66,
      type: 'faq',
      locale: 'es-ES',
      title: '¿Cómo funciona?',
      content: { question: '¿Cómo funciona?', answer: 'La clínica te contactará para explicarlo.' },
      sources: [],
      status: 'draft',
      version: 1,
    });
    await content.validate();
    assert.match(content.contentHash, /^[a-f0-9]{64}$/);

    const invalidScope = models.WebContentEntry.build({
      id: '22222222-2222-4222-8222-222222222222',
      scopeType: 'group',
      clinicaId: 66,
      type: 'faq',
      locale: 'es-ES',
      title: 'Inválido',
      content: { question: 'Pregunta', answer: 'Respuesta suficiente.' },
      sources: [],
    });
    await assert.rejects(() => invalidScope.validate(), /alcance group/);

    const media = models.WebMediaAsset.build({
      id: '33333333-3333-4333-8333-333333333333',
      scopeType: 'group',
      grupoClinicaId: 4,
      publicMediaAssetId: 20,
      title: 'Recepción',
      kind: 'image',
      status: 'ready',
      altText: 'Recepción de la clínica',
      decorative: false,
      focalPoints: { desktop: { x: 50, y: 50 } },
      rights: { origin: 'owned' },
      variants: [],
      mediaMetadata: {},
      version: 1,
    });
    await media.validate();
    assert.deepEqual(media.focalPoints.desktop, { x: 50, y: 50 });

    const version = models.WebContentEntryVersion.build({
      id: '44444444-4444-4444-8444-444444444444',
      contentEntryId: content.id,
      version: 1,
      type: content.type,
      locale: content.locale,
      title: content.title,
      content: content.content,
      sources: content.sources,
      status: content.status,
    });
    await version.validate();
    await assert.rejects(
      () => models.WebContentEntryVersion.runHooks('beforeUpdate', version, {}),
      (error) => error.code === 'WEB_CONTENT_ENTRY_VERSION_IMMUTABLE'
    );
  } finally {
    await sequelize.close();
  }
  console.log('web content/media models contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
