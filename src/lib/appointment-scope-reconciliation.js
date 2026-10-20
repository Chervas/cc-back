'use strict';

const { Op } = require('sequelize');
const { hash } = require('./appointment-single-notice-publication');
const { scoped, policyFor } = require('./appointment-single-notice-flow');
const { automationScopeKey } = require('./appointment-template-scope');

const plain = row => row.toJSON ? row.toJSON() : row;
const conflict = () => Object.assign(Error('La familia ha cambiado o requiere revisión.'), {
  statusCode: 409, code: 'appointment_scope_reconciliation_conflict',
});
const content = row => Object.fromEntries(['public_id', 'template_key', 'engine_version', 'name', 'description',
  'trigger_type', 'trigger_config', 'is_system', 'clinic_id', 'group_id', 'entry_node_id', 'nodes'].map(key => [key, row[key]]));
const snapshotHash = row => hash({ ...content(plain(row)), id: row.id, version: row.version,
  is_active: !!row.is_active, published_at: new Date(row.published_at).toISOString() });

// Explicit administrator repair, never a selector fallback to an older active
// version. The caller must review both snapshots before restoring local intent.
async function reconcileClinicScope({ db, actorId, ref, body }) {
  if (!Number.isSafeInteger(body?.source_id) || !Number.isSafeInteger(body?.expected_latest_id)
    || !/^[a-f0-9]{64}$/.test(body.source_hash || '') || !/^[a-f0-9]{64}$/.test(body.latest_hash || '')
    || ![undefined, false, true].includes(body.apply)) throw Object.assign(Error('invalid_reconciliation_manifest'), { statusCode: 400 });
  return db.sequelize.transaction(async transaction => {
    const Model = db.AutomationFlowTemplateV2;
    const original = await Model.findByPk(body.source_id, { transaction });
    if (!original || original.public_id !== ref || !original.clinic_id) throw conflict();
    // Lock the global version sequence too: template_key/version is unique even
    // for historic keys accidentally shared by different clinic scopes.
    const all = await Model.findAll({ where: { template_key: original.template_key },
      order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
    const rows = all.filter(row => row.public_id === ref && automationScopeKey(row) === automationScopeKey(original));
    const source = rows.find(row => row.id === body.source_id);
    const alias = rows.find(row => row.id === body.expected_latest_id);
    const latest = rows.filter(row => row.published_at).sort((a, b) => b.version - a.version || b.id - a.id)[0];
    if (!source?.published_at || !alias?.published_at || !latest || rows.some(row => !row.published_at)) throw conflict();
    if (latest.id !== alias.id) {
      // A retry can only acknowledge this exact immutable repair, not publish
      // again or restore a later manual stop.
      if (latest.is_active && !source.is_active && !alias.is_active && latest.version > alias.version
        && hash(content(plain(latest))) === hash(content(plain(source)))
        && snapshotHash({ ...plain(source), is_active: true }) === body.source_hash
        && snapshotHash(alias) === body.latest_hash
        && rows.filter(row => row.is_active).length === 1) return { row: latest, skipped: true };
      throw conflict();
    }
    const clinic = await db.Clinica.findByPk(source.clinic_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!source.is_active || alias.is_active || source.version >= alias.version || rows.filter(row => row.is_active).length !== 1
      || source.is_system || alias.is_system || !scoped(source) || !policyFor(source)
      || !['appointment_created', 'appointment_rescheduled'].includes(source.trigger_type)
      || alias.trigger_type !== source.trigger_type || !source.group_id || alias.group_id != null
      || Number(clinic?.grupoClinicaId) !== Number(source.group_id)
      || snapshotHash(source) !== body.source_hash || snapshotHash(alias) !== body.latest_hash) throw conflict();
    if (body.apply !== true) return { source_id: source.id, superseded_id: alias.id, dry_run: true };
    const created = await Model.create({ ...content(plain(source)), version: Math.max(...all.map(row => row.version)) + 1,
      is_active: true, created_by: actorId, published_by: actorId, published_at: new Date() }, { transaction });
    await Model.update({ is_active: false }, { where: { id: { [Op.in]: rows.map(row => row.id) } }, transaction });
    return { row: created, skipped: false, source_id: source.id, superseded_id: alias.id };
  });
}

module.exports = { reconcileClinicScope, snapshotHash };
