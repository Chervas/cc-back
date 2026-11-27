'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const runtimeMigration = require('../../../migrations/20261127071000-create-lead-assistant-runtime');
const migration = require('../../../migrations/20261127064000-create-lead-assistant-drafts');
const { create } = require('../../services/leadAssistantDraft.service');

withIsolatedCampaignMysql(async ({ sql, report }) => {
  const Clinica = sql.define('Clinica', {
    id_clinica: { type: D.INTEGER, primaryKey: true }, nombre_clinica: D.STRING, grupoClinicaId: D.INTEGER,
  }, { timestamps: false });
  const LeadAssistantDraft = require('../../../models/leadassistantdraft')(sql, D.DataTypes);
  await Clinica.sync();
  await Clinica.bulkCreate([{ id_clinica: 1, nombre_clinica: 'A' }, { id_clinica: 2, nombre_clinica: 'B' }]);
  await migration.up(sql.getQueryInterface(), D);
  await runtimeMigration.up(sql.getQueryInterface(), D);
  const LeadAssistantPublication = require('../../../models/leadassistantpublication')(sql, D.DataTypes);
  const ClinicaHorario = require('../../../models/clinicahorario')(sql, D.DataTypes);
  const ClinicBusinessLocation = require('../../../models/clinicbusinesslocation')(sql, D.DataTypes);
  await ClinicaHorario.sync(); await ClinicBusinessLocation.sync();
  await ClinicaHorario.create({clinica_id: 2, dia_semana: 4, activo: true, hora_inicio: '09:00', hora_fin: '13:00'});
  const location = await ClinicBusinessLocation.create({clinica_id: 1, google_connection_id: 1, location_id: 'demo',
    is_verified: true, is_active: true, is_suspended: false,
    raw_payload: { regularHours: { periods: [{openDay: 'MONDAY', closeDay: 'MONDAY',
      openTime: {hours: 9, minutes: 30}, closeTime: {hours: 13, minutes: 30}}] }, internal: 'must not leave' }});
  const service = create({ sequelize: sql, Clinica, LeadAssistantDraft, LeadAssistantPublication, ClinicaHorario, ClinicBusinessLocation });
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
  assert.deepEqual(blank.openingHours, {source:'business_profile', hours:[{weekday:1,opens:'09:30',closes:'13:30'}]});
  assert.deepEqual((await service.read(2)).openingHours, {source:'clinic_schedule',hours:[{weekday:4,opens:'09:00',closes:'13:00'}]});
  await location.update({is_suspended:true});
  assert.deepEqual((await service.read(1)).openingHours, {source:null,hours:[]});
  await assert.rejects(service.approve(1, 81, 1), {status:409});
  const fields = {tone:'Cercano',context:'Primera visita 35 €',guardrails:'Consultar a recepción',booking:'Pide confirmación',promotions:''};
  await service.save(1, 81, {version:1, fields});
  await Promise.all([service.approve(1, 81, 2), service.approve(1, 82, 2)]);
  assert.equal(await LeadAssistantPublication.count(), 1);
  assert.equal(await service.approvedVersion(2), null);
  await service.save(1, 83, {version:2, fields:{...fields, context:'Cambio en revisión'}});
  await assert.rejects(service.approve(1, 81, 2), {status:409});
  assert.equal((await LeadAssistantPublication.findOne({where:{clinic_id:1,version:2}})).fields.context, fields.context);
  report.checks.push('Aprobación explícita e inmutable, repetición concurrente, fichas locales aisladas y horario de agenda alternativo.');
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
  await service.approve(1,81,combined.version);
  assert.equal((await LeadAssistantPublication.findOne({where:{clinic_id:1,version:combined.version}})).fields.context,context);
  await assert.rejects(service.save(1, 81, {version:combined.version, fields:{...combined.fields, context:context+'X'}}), {status:400});
  assert.equal((await service.read(1)).version, combined.version);
  report.checks.push('Contexto y promociones de 120.000 caracteres Unicode cada uno coexisten y se recuperan completos.');
  report.checks.push('Borrador UTF-8, aislamiento por clínica, conflicto concurrente, validación y persistencia.');
});
