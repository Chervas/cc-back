'use strict';
const crypto = require('node:crypto'), { Op, literal } = require('sequelize');
const C = require('../lib/clinical-episode-contract'), S = require('../lib/clinic-supplies-contract'), U = require('../lib/clinical-episode-consumables');
function createService({ db, canAccess = input => require('../lib/access-policy').canUserAccessFeature(input), isGlobalAdmin } = {}) {
  const supplies = require('./clinicSupplies.service').createClinicSuppliesService({ db, canAccess, isGlobalAdmin });
  const episodes = require('./clinicalEpisodes.service').createClinicalEpisodeService({ db, canAccess });
  async function context(input, transaction, writing = false) {
    if (!input.actorId) throw C.error(401, 'unauthenticated', 'Inicia sesión para continuar.');
    const actorId = C.integer(input.actorId, 'actor_id'), clinicId = C.integer(input.clinicId, 'clinic_id');
    const features = ['patients.view', 'patients.sensitive.view', writing ? 'clinical.reports.manage' : 'clinical.reports.view'];
    if ((await Promise.all(features.map(featureKey => canAccess({ actorId, clinicId, featureKey })))).some(value => !value)) throw C.error(403, 'clinical_consumables_forbidden', 'No tienes permiso para estos consumibles clínicos.');
    if (typeof input.id !== 'string' || input.id.length > 80) throw C.error(404, 'clinical_episode_not_found', 'Episodio no encontrado.');
    let row = await db.AppointmentClinicalReport.findOne({ where: { public_id: input.id, clinic_id: clinicId }, transaction });
    if (!row) throw C.error(404, 'clinical_episode_not_found', 'Episodio no encontrado.');
    const patient = await db.Paciente.findOne({ where: { id_paciente: row.patient_id }, transaction, ...(writing ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!patient || Number(patient.clinica_id) !== clinicId && !await db.PacienteClinica.findOne({ where: { paciente_id: row.patient_id, clinica_id: clinicId }, transaction })) throw C.error(404, 'clinical_episode_patient_not_found', 'Paciente no encontrado en esta clínica.');
    if (writing) row = await db.AppointmentClinicalReport.findOne({ where: { id: row.id, clinic_id: clinicId }, transaction, lock: transaction.LOCK.UPDATE });
    return { row, actorId, clinicId };
  }
  const base = ctx => ({ report_id: ctx.row.id, clinic_id: ctx.clinicId, patient_id: ctx.row.patient_id });
  function movement(row) { return { id: row.id, product_id: row.product_id, name: row.product_name, unit: row.unit,
    kind: Number(row.quantity) > 0 ? 'consume' : 'return', quantity: Math.abs(Number(row.quantity)), reason: row.reason,
    actor_id: Number(row.actor_id), episode_version: Number(row.episode_version), created_at: row.created_at }; }
  async function view(ctx, query = {}, transaction) {
    const limit = query.limit == null ? 30 : C.integer(query.limit, 'limit'); if (limit > 100) throw C.error(400, 'clinical_consumables_limit', 'Solicita como máximo cien movimientos.');
    const cursor = C.decodeCursor(query.cursor), scope = C.hash([ctx.clinicId, Number(ctx.row.patient_id), ctx.row.public_id]);
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_consumables_cursor', 'La página no corresponde a este episodio.');
    const filter = base(ctx);
    if (cursor) filter[Op.or] = [{ episode_version: { [Op.lt]: C.integer(cursor.version) } }, { episode_version: C.integer(cursor.version), id: { [Op.lt]: S.id(cursor.id) } }];
    const [rows, grouped] = await Promise.all([
      db.ClinicalEpisodeStockConsumption.findAll({ where: filter, order: [['episode_version', 'DESC'], ['id', 'DESC']], limit: limit + 1, transaction }),
      db.ClinicalEpisodeStockConsumption.findAll({ where: base(ctx), attributes: ['product_id', 'product_name', 'unit', [literal('SUM(`quantity`)'), 'quantity']], group: ['product_id', 'product_name', 'unit'], transaction }),
    ]);
    const items = U.totals(grouped), page = rows.slice(0, limit), last = page.at(-1);
    let manage = false;
    if (ctx.row.status === 'draft' && await canAccess({ actorId: ctx.actorId, clinicId: ctx.clinicId, featureKey: 'clinical.reports.manage' })) {
      try { manage = (await supplies.readContext({ actorId: ctx.actorId, clinicId: ctx.clinicId })).capabilities.manage; } catch { manage = false; }
    }
    if (manage && items.length) {
      const products = await db.ClinicStockProduct.findAll({ where: { clinic_id: ctx.clinicId, id: { [Op.in]: items.map(item => item.product_id) } }, transaction });
      for (const item of items) {
        const product = products.find(product => product.id === item.product_id);
        if (product) Object.assign(item, { product_version: Number(product.version), active: !!product.active, stock_quantity: Number(product.quantity) });
      }
    }
    return { items, movements: page.map(movement), next_cursor: rows.length > limit ? C.encodeCursor({ scope, version: Number(last.episode_version), id: last.id }) : null, capabilities: { manage: !!manage } };
  }
  async function read(input) { return view(await context(input), input.query); }
  async function products(input) {
    const ctx = await context(input); await supplies.readContext(input);
    const query = input.query || {}, q = C.text(query.q || '', 'search', 160) || '', limit = query.limit == null ? 50 : C.integer(query.limit, 'limit');
    if (limit > 100) throw C.error(400, 'clinical_consumables_limit', 'Solicita como máximo cien productos.');
    const cursor = C.decodeCursor(query.cursor), scope = C.hash([ctx.clinicId, ctx.row.public_id, q]);
    if (cursor && cursor.scope !== scope) throw C.error(400, 'clinical_consumables_cursor', 'La página no corresponde a esta búsqueda.');
    const where = { clinic_id: ctx.clinicId, active: true, ...(q ? { name: { [Op.like]: '%' + q.replace(/[\\%_]/g, '\\$&') + '%' } } : {}), ...(cursor ? { id: { [Op.gt]: S.id(cursor.id) } } : {}) };
    const rows = await db.ClinicStockProduct.findAll({ where, order: [['id', 'ASC']], limit: limit + 1 });
    return { items: rows.slice(0, limit).map(row => ({ id: row.id, name: row.name, unit: row.unit, quantity: Number(row.quantity), version: Number(row.version), active: !!row.active })), next_cursor: rows.length > limit ? C.encodeCursor({ scope, id: rows[limit - 1].id }) : null };
  }
  async function save(input) {
    const parsed = U.command(input.payload); let ctx;
    const result = await supplies.episodeCommand(input,
      async (_stockContext, transaction) => { ctx = await context(input, transaction, true); },
      async (stockContext, transaction) => {
        if (ctx.row.status !== 'draft') throw C.error(409, 'clinical_report_final', 'Reabre el episodio antes de corregir sus consumibles.');
        if (Number(ctx.row.version_number) !== parsed.expected) throw C.error(409, 'clinical_report_version_conflict', 'El episodio ha cambiado. Conserva tu edición y revisa la versión actual.');
        const history = await db.ClinicalEpisodeStockConsumption.findAll({ where: base(ctx), transaction });
        const used = new Map(U.totals(history).map(item => [item.product_id, Math.round(item.quantity * 1000)]));
        for (const line of parsed.lines) {
          if (parsed.kind === 'return' && line.units > (used.get(line.product_id) || 0)) throw C.error(409, 'clinical_consumables_return_exceeds_used', 'No puedes devolver más cantidad que la registrada en esta consulta.');
          const delta = parsed.kind === 'consume' ? -line.units : line.units;
          const { product, movement } = await supplies.episodeStock(stockContext, transaction, { productId: line.product_id, expectedVersion: line.expected_product_version,
            delta, kind: parsed.kind === 'consume' ? 'episode_use' : 'episode_return', reason: parsed.reason, allowInactive: parsed.kind === 'return' });
          await db.ClinicalEpisodeStockConsumption.create({ id: crypto.randomUUID(), ...base(ctx), product_id: product.id, movement_id: movement.id,
            product_name: product.name, unit: product.unit, quantity: S.amount(-delta), episode_version: parsed.expected + 1, reason: parsed.reason, actor_id: ctx.actorId }, { transaction });
        }
        const episode = (await episodes.saveInTransaction({ id: ctx.row.public_id, clinicId: ctx.clinicId, actorId: ctx.actorId,
          payload: { expected_version: parsed.expected, idempotency_key: 'consumables-' + C.hash(input.payload.idempotency_key) }, transaction })).item;
        // The logistics journal stores only an opaque clinical receipt, never
        // the patient's narrative, diagnoses or private notes.
        return { episode_id: ctx.row.public_id, applied_episode_version: episode.version };
      });
    return { episode: (await episodes.get({ id: input.id, clinicId: input.clinicId })).item, consumables: await read(input), replayed: result.replayed };
  }
  return { read, products, save };
}
let singleton;
module.exports = { createService, ...Object.fromEntries(['read', 'products', 'save'].map(name => [name, input => { singleton ||= createService({ db: require('../../models') }); return singleton[name](input); }])) };
