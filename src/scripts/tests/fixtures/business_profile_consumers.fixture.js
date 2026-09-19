'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataTypes: D } = require('sequelize');
module.exports = async ({ sql, models, report, writerClient, sessions, actor, policy, registerOwnedLoopbackServer, resetRemote, setAfter, writes }) => {
  for (const [name, file] of [['ClinicBusinessLocation', 'clinicbusinesslocation'], ['BusinessProfileReview', 'businessprofilereview'],
    ['PublicMediaAsset', 'publicmediaasset'], ['GroupAssetClinicAssignment', 'groupassetclinicassignment'],
    ['BusinessProfileBrokerBinding', 'businessprofilebrokerbinding'], ['BusinessProfileBrokerRevocation', 'businessprofilebrokerrevocation']]) {
    models[name] = require('../../../../models/' + file)(sql, D); await models[name].sync();
  }
  const pk = () => ({ type: D.INTEGER, primaryKey: true });
  models.Clinica = sql.define('Clinica', { id_clinica: pk(), grupoClinicaId: D.INTEGER, configuracion: D.JSON }, { timestamps: false });
  const group = { id_grupo: pk() };
  for (const [prefix, field] of [['business_profile', 'location'], ['analytics', 'property'], ['search_console', 'asset']]) {
    group[prefix + '_assignment_mode'] = D.STRING; group[prefix + '_primary_' + field + '_id'] = D.INTEGER;
  }
  models.GrupoClinica = sql.define('GrupoClinica', group, { timestamps: false });
  models.UsuarioClinica = sql.define('UsuarioClinica', { id: { ...pk(), autoIncrement: true }, id_usuario: D.INTEGER,
    id_clinica: D.INTEGER, rol_clinica: D.STRING, estado_invitacion: D.STRING }, { timestamps: false });
  for (const name of ['Clinica', 'GrupoClinica', 'UsuarioClinica']) await models[name].sync();
  await models.Clinica.bulkCreate([{ id_clinica: 71 }, { id_clinica: 72, grupoClinicaId: 15 }, { id_clinica: 73, grupoClinicaId: 15 }]);
  await models.GrupoClinica.create({ id_grupo: 15, business_profile_assignment_mode: 'group', business_profile_primary_location_id: 51 });
  for (const id of [71, 72, 73]) await models.UsuarioClinica.create({ id_usuario: actor.userId, id_clinica: id, rol_clinica: 'agencia', estado_invitacion: 'aceptada' });
  const location = { id: 51, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456', is_active: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456',
    raw_payload: { accountName: 'accounts/123', regularHours: { periods: [{ openDay: 'MONDAY' }] }, marker: 'preserve' } };
  await models.ClinicBusinessLocation.create(location);
  await models.BusinessProfileBrokerBinding.create({ external_location_id: '456', connection_ref: 'connection:test',
    asset_ref: 'gbp:123:456', clinica_id: 71, google_connection_id: 81 });
  await models.BusinessProfileReview.create({ id: 91, clinica_id: 71, business_location_id: 51,
    review_name: 'accounts/123/locations/456/reviews/business_1', raw_payload: { marker: 'preserve' } });
  const url = 'https://media.clinicaclick.com/marketing/clinic-72/2026/09/' + randomUUID() + '.jpg';
  await models.PublicMediaAsset.create({ id: 111, scope_type: 'clinic', clinica_id: 72, owner_type: 'google_business_profile_media',
    purpose: 'marketing_image', bucket: 'fictitious', region: 'eu-west-3', object_key: 'fictitious', public_url: url,
    content_type: 'image/jpeg', sha256: 'a'.repeat(64), metadata: { non_clinical_asserted: true } });
  policy.connections[0].googleBusinessProfileWrites.locations[0].publicMediaClinicIds = [72]; resetRemote();
  const broker = require('../../../services/businessProfileBroker.service').createBusinessProfileBroker({ client: {}, writerClient,
    enabled: () => true, writesEnabled: () => true,
    loadLocation: (id, options) => models.ClinicBusinessLocation.findByPk(id, { ...options, raw: true, logging: false }),
    loadManagedBinding: (id, options) => models.BusinessProfileBrokerBinding.findByPk(id, { ...options, raw: true, logging: false }) });
  const requestSessions = { ...sessions, bearer: value => value, async verify(token) {
    assert.equal(token, 'FICTITIOUS_SESSION'); return { userId: actor.userId, sessionVersion: 1, jti: actor.sessionRef, exp: actor.expiresAt / 1000 };
  } };
  const module = require('../../../services/businessProfileMutations.service');
  const consumer = module.createBusinessProfileMutations({ models, broker, sessions: requestSessions, enabled: () => true, namespace: () => 'staging' });
  const original = { ...module }; Object.assign(module, consumer);
  const local = require('../../../services/businessProfileLocal.service');
  const request = { headers: { authorization: 'FICTITIOUS_SESSION' }, userData: { userId: actor.userId } };
  const resolved = { clinicId: 72, locations: [location], timeZone: 'Europe/Madrid' };
  try {
    const reply = { operationId: randomUUID(), comment: 'Respuesta pública de prueba' };
    report.consumerStage = 'reply';
    const updated = await local.updateReviewReply({ ...resolved, locations: [{ id: 999 }, location] }, 91, reply, { request });
    assert.equal(updated.review.reply_comment, reply.comment); assert.equal(updated.mutation.state, 'applied');
    assert(!('raw_payload' in updated.review));
    const row = await models.BusinessProfileMutation.findByPk(reply.operationId);
    assert.equal(row.mapping_id, 51); assert.equal(row.requested_clinic_id, 72);
    const event = await models.PlatformAuditEvent.findOne({ where: { correlation_id: reply.operationId, stage: 'completed' } });
    assert.equal(JSON.parse(event.body).clinicCount, 3);
    report.consumerStage = 'photo';
    const photo = await local.publishPhoto({ ...resolved, locations: [{ ...location, raw_payload: {} }] }, { operationId: randomUUID(), publicMediaAssetId: 111 }, { request });
    assert.equal(photo.success, true); assert.equal(photo.mutation.kind, 'photo');
    report.consumerStage = 'hours';
    const hours = await local.updateSpecialHours({ ...resolved, locations: [{ ...location, location_id: 'accounts/123/locations/456' }] }, { operationId: randomUUID(), timeZone: 'Europe/Madrid',
      periods: [{ id: 'winter', label: 'Cierre', kind: 'closed', startDate: '2026-12-25', endDate: '2026-12-25' }] }, { request });
    assert.equal(hours.success, true); assert.equal(hours.plan.periods[0].label, 'Cierre');
    assert.equal(hours.plan.sourceClinicId, 72); assert.equal(hours.specialHours.specialHourPeriods[0].closed, true);
    const current = await models.ClinicBusinessLocation.findByPk(51); assert.equal(current.raw_payload.marker, 'preserve');
    assert.equal(current.raw_payload.clinicaclick_media_items.length, 1);
    report.consumerStage = 'delete';
    const deletion = await local.deleteReviewReply(resolved, 91, { operationId: randomUUID() }, { request });
    assert.equal(deletion.review.has_reply, false); assert.equal(deletion.review.reply_comment, null);
    const count = writes(); const historic = await consumer.recover({ clinicId: 72, operationId: reply.operationId, request });
    assert.equal(historic.review.has_reply, false); assert.equal(writes(), count);
    report.checks.push('actual four businessProfileLocal writers use broker, share a SQL transaction with v25 audit, preserve unrelated cache and return current state for historical receipts; second-location review and shared-clinic photo work');

    await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_clinica: 73 } });
    await assert.rejects(local.updateReviewReply({ ...resolved, clinicId: 71 }, 91, { ...reply, operationId: randomUUID() }, { request }), { code: 'scope_denied' });
    assert.equal(writes(), count);
    await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_clinica: 73 } });
    setAfter(async command => { if (command.operation.endsWith('review.reply.update.v1')) {
      setAfter(null); await models.UsuarioClinica.update({ estado_invitacion: 'cancelada' }, { where: { id_clinica: 73 } });
    } });
    const revoked = { ...reply, operationId: randomUUID() };
    await assert.rejects(local.updateReviewReply(resolved, 91, revoked, { request }), { code: 'scope_denied' });
    assert.equal((await models.BusinessProfileReview.findByPk(91)).has_reply, false);
    assert(!(await consumer.pending({ clinicId: 72, request })).items.some(item => item.operationId === revoked.operationId));
    await models.UsuarioClinica.update({ estado_invitacion: 'aceptada' }, { where: { id_clinica: 73 } });
    assert((await consumer.pending({ clinicId: 72, request })).items.some(item => item.operationId === revoked.operationId));
    const recovered = await consumer.recover({ clinicId: 72, operationId: revoked.operationId, request });
    assert.equal(recovered.review.has_reply, true); assert.equal(writes(), count + 1);
    await assert.rejects(consumer.recover({ clinicId: 71, operationId: revoked.operationId, request }), { code: 'business_profile_mutation_not_found' });
    await assert.rejects(local.publishPhoto({ ...resolved, clinicId: 71 }, { operationId: randomUUID(), publicMediaAssetId: 111 }, { request }), /public_media_asset_not_available/);
    report.checks.push('real SQL group/clinic membership is rechecked for the specific mapping before and after dispatch; lost permission hides pending intent and prevents cache commit; restored permission permits status-only recovery');
    await models.Clinica.create({ id_clinica: 74, grupoClinicaId: 16 });
    await models.ClinicBusinessLocation.create({ ...location, id: 52, location_id: 'accounts/999/locations/456' });
    await models.GrupoClinica.create({ id_grupo: 16, business_profile_assignment_mode: 'group', business_profile_primary_location_id: 52 });
    const beforeAlias = writes();
    await assert.rejects(local.updateReviewReply(resolved, 91, { ...reply, operationId: randomUUID() }, { request }), { code: 'scope_denied' });
    assert.equal(writes(), beforeAlias);
    await models.UsuarioClinica.create({ id_usuario: actor.userId, id_clinica: 74, rol_clinica: 'agencia', estado_invitacion: 'aceptada' });
    assert.equal((await local.updateReviewReply(resolved, 91, { ...reply, operationId: randomUUID() }, { request })).success, true);
    report.checks.push('a second local mapping under another Google account cannot conceal additional affected clinics; all alias scopes need current write permission');
    // Mount the actual router. Only authentication and the read-page inventory
    // are fixtures; all write authorization, SQL, journal and broker are real.
    const authFile = require.resolve('../../../routes/auth.middleware');
    const hoursFile = require.resolve('../../../services/googleSpecialHoursAutomation.service');
    const originalAuth = require.cache[authFile], originalHours = require.cache[hoursFile];
    require.cache[authFile] = { id: authFile, filename: authFile, loaded: true, exports: (req, res, next) => {
      if (req.headers.authorization !== 'FICTITIOUS_SESSION') return res.sendStatus(401);
      req.userData = { userId: actor.userId }; next();
    } };
    require.cache[hoursFile] = { id: hoursFile, filename: hoursFile, loaded: true, exports: {} };
    const originalResolve = local.resolveEffectiveLocations;
    local.resolveEffectiveLocations = async clinicId => ({ ...resolved, clinicId, locations: [await models.ClinicBusinessLocation.findByPk(51)] });
    const express = require('express'), http = require('node:http');
    const app = express(); app.use(express.json()); app.use('/api/local', require('../../../routes/local.routes'));
    const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    registerOwnedLoopbackServer(server);
    const send = (method, suffix, body, authorized = true) => new Promise((resolve, reject) => {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: '/api/local/clinica/72/' + suffix,
        headers: { ...(authorized ? { Authorization: 'FICTITIOUS_SESSION' } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, res => {
        const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => {
          const text = Buffer.concat(parts).toString(); resolve({ status: res.statusCode, body: text.startsWith('{') ? JSON.parse(text) : text });
        });
      }); req.on('error', reject); req.end(bytes);
    });
    try {
      assert.equal((await send('GET', 'mutations/pending', undefined, false)).status, 401);
      const command = { ...reply, operationId: randomUUID() }, beforeRoute = writes();
      setAfter(() => { setAfter(null); throw Object.assign(Error('PRIVATE_PROVIDER_DETAIL'), { code: 'broker_unavailable' }); });
      const lost = await send('PUT', 'reviews/91/reply', command); assert.equal(lost.status, 503);
      assert.equal(lost.body.error, 'broker_unavailable'); assert(!JSON.stringify(lost).includes('PRIVATE_PROVIDER_DETAIL'));
      const duplicate = await send('PUT', 'reviews/91/reply', command);
      assert.equal(duplicate.status, 202); assert.equal(duplicate.body.success, false);
      assert.equal(duplicate.body.mutation.operationId, command.operationId); assert.equal(writes(), beforeRoute + 1);
      assert((await send('GET', 'mutations/pending')).body.items.some(row => row.operationId === command.operationId));
      const reconciled = await send('POST', 'mutations/' + command.operationId + '/recover', {});
      assert.equal(reconciled.status, 200); assert.equal(reconciled.body.success, true); assert.equal(writes(), beforeRoute + 1);
      const deleted = await send('DELETE', 'reviews/91/reply', { operationId: randomUUID() });
      assert.equal(deleted.status, 200); assert.equal(deleted.body.review.has_reply, false);
      report.checks.push('actual Express/HTTP routes require authentication, persist client UUID, return 202 for an uncertain duplicate and recover via status-only POST; DELETE receives its JSON intent and errors omit provider details');
    } finally {
      await new Promise(resolve => server.close(resolve)); local.resolveEffectiveLocations = originalResolve;
      if (originalAuth) require.cache[authFile] = originalAuth; else delete require.cache[authFile];
      if (originalHours) require.cache[hoursFile] = originalHours; else delete require.cache[hoursFile];
    }
  } finally { Object.assign(module, original); setAfter(null); }
};
