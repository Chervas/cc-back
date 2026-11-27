'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261127064000-create-lead-assistant-drafts');
const { create } = require('../../services/leadAssistantDraft.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const Clinica = sql.define('Clinica', {
    id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING,
  }, { timestamps: false });
  const LeadAssistantDraft = require('../../../models/leadassistantdraft')(sql, D.DataTypes);
  await Clinica.sync();
  await Clinica.bulkCreate([{ id_clinica: 1, nombre_clinica: 'A' }, { id_clinica: 2, nombre_clinica: 'B' }]);
  await migration.up(sql.getQueryInterface(), D);
  const service = create({ sequelize: sql, Clinica, LeadAssistantDraft });
  const blank = await service.read(1);
  const next = { version: blank.version, fields: { ...blank.fields, context: 'Contexto ficticio 📝' } };
  const attempts = await Promise.allSettled([service.save(1, 81, next), service.save(1, 82, next)]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(a => a.status === 'rejected').reason.status, 409);
  assert.equal((await service.read(1)).fields.context, next.fields.context);
  assert.equal((await service.read(2)).version, 0);
  await assert.rejects(service.save(1, 81, { ...next, active: true }), {status: 400});
  await assert.rejects(service.save(1, 81, { version: 1, fields: {} }), {status: 400});
  await assert.rejects(service.read(99), {status: 404});
  const draft = await service.read(1);
  assert.equal(draft.promotionCharacterLimit, 120000);
  const suffix = '\nImagen: https://media.example.com/foto.png';
  const promotions = 'á'.repeat(119999 - suffix.length) + '📷' + suffix;
  const large = await service.save(1, 81, { version: draft.version, fields: { ...draft.fields, promotions } });
  assert.equal((await service.read(1)).fields.promotions, promotions);
  await assert.rejects(service.save(1, 81, {version:large.version, fields:{...large.fields, promotions:promotions+'X'}}), {status:400});
  assert.equal((await service.read(1)).version, large.version);
  report.checks.push('120.000 caracteres Unicode y enlace final guardados íntegros. Un carácter de más conserva la versión anterior.');
  assert.equal(draft.contextCharacterLimit, 120000);
  const context = 'C'.repeat(119996) + '📘fin';
  assert.equal(Array.from(context).length,120000);
  const combined = await service.save(1, 81, {version:large.version, fields:{...large.fields, context}});
  const recovered = await service.read(1);
  assert.equal(recovered.fields.context, context);
  assert.equal(recovered.fields.promotions, promotions);
  await assert.rejects(service.save(1, 81, {version:combined.version, fields:{...combined.fields, context:context+'X'}}), {status:400});
  assert.equal((await service.read(1)).version, combined.version);
  report.checks.push('Contexto y promociones de 120.000 caracteres Unicode cada uno coexisten y se recuperan completos.');
  report.checks.push('Borrador UTF-8, aislamiento por clínica, conflicto concurrente, validación y persistencia.');
});
