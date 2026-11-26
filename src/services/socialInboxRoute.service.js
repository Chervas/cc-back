'use strict';

const E = require('./metaMarketingEnrollment.contract');
const bindings = require('./metaMarketingEnrollmentBinding.service');
const { assetSetDigest } = require('./metaMarketingEffectiveCredential.service');
const { destinationsFor } = require('./metaMarketingInstagramExtension.service');

async function resolveRoute(db, { channel, accountId }, transaction) {
  const o = { transaction, raw: true, logging: false };
  const kind = channel === 'instagram' ? 'instagram_business' : 'facebook_page';
  const assetRef = 'meta-' + kind + ':' + accountId;
  const direct = await db.MetaMarketingBrokerBinding.findAll({
    ...o,
    where: { asset_ref: assetRef, state: 'active' },
    limit: 2,
  });
  const ext =
    channel === 'instagram'
      ? await db.MetaMarketingInstagramExtension.findAll({
          ...o,
          where: { selected_instagram_id: accountId, status: 'active' },
          limit: 2,
        })
      : [];
  if (direct.length + ext.length !== 1) return null;
  const source = direct[0] || ext[0];
  const raw = await db.MetaMarketingEnrollmentRequest.findByPk(source.enrollment_id, o);
  if (!raw || raw.state !== 'active' || raw.connection_ref !== source.connection_ref) return null;
  const row = E.request(raw);
  let committed;
  try {
    committed = await bindings.createBindings({ models: db }).committed(row.enrollment_id, transaction);
  } catch (err) {
    if (
      [
        'meta_enrollment_assignment_review',
        'meta_enrollment_asset_revoked',
        'meta_enrollment_asset_in_use',
        'meta_enrollment_not_active',
        'meta_enrollment_scope_changed',
        'meta_enrollment_scope_blocked',
        'meta_credential_renewal_required',
      ].includes(err.code)
    )
      return null;
    throw err;
  }
  async function assignedClinic(mapping, assetKind) {
    if (mapping?.assignmentScope === 'clinic') return mapping.clinicaId;
    if (mapping?.assignmentScope !== 'group') return null;
    const prefix = assetKind === 'instagram_business' ? 'instagram' : 'facebook';
    const primary = prefix + '_primary_asset_id',
      mode = prefix + '_assignment_mode';
    const group = await db.GrupoClinica.findByPk(mapping.grupoClinicaId, {
      ...o,
      attributes: [mode, primary],
    });
    if (!group) return null;
    if (group[mode] === 'group' && group[primary] != null) {
      return Number(group[primary]) === Number(mapping.id) && row.clinicIds.length === 1
        ? row.clinicIds[0]
        : null;
    }
    const shares = await db.GroupAssetClinicAssignment.findAll({
      ...o,
      attributes: ['clinicaId'],
      where: {
        grupoClinicaId: mapping.grupoClinicaId,
        assetType: 'meta.' + assetKind,
        assetId: mapping.id,
      },
      limit: 2,
    });
    return shares.length === 1 ? Number(shares[0].clinicaId) : null;
  }
  let clinicId, pageId;
  if (ext.length) {
    if (
      !source.confirmed_at ||
      +source.confirmed_at > Date.now() ||
      source.scope_key !== row.scope_key ||
      !/^[a-f0-9]{64}$/.test(source.selected_candidate_digest) ||
      (await db.ClinicMetaAsset.findOne({
        ...o,
        where: { assetType: kind, metaAssetId: accountId, isActive: true },
      })) ||
      (await db.MetaMarketingBrokerRevocation.findOne({ ...o, where: { asset_ref: assetRef } }))
    )
      return null;
    const targets = await destinationsFor({
      models: db,
      row,
      committed,
      transaction,
      settings: () => [],
      selfService: () => true,
    });
    const match = targets.filter(
      (t) =>
        source.reserved_scope === 'clinic:' + t.clinicId &&
        E.hash(
          JSON.stringify([
            committed.digest,
            t.parentPageId,
            assetSetDigest(row.selected),
            row.meta_user_id,
          ]),
        ) === source.structure_hash,
    );
    if (
      match.length !== 1 ||
      targets.filter((t) => t.parentPageId === match[0].parentPageId).length !== 1
    )
      return null;
    clinicId = match[0].clinicId;
    pageId = match[0].parentPageId;
    if (row.scope_key.startsWith('group:')) {
      const groupId = Number(row.scope_key.slice(6));
      const mapping = await db.ClinicMetaAsset.findOne({
        ...o,
        where: {
          grupoClinicaId: groupId,
          assignmentScope: 'group',
          assetType: 'facebook_page',
          metaAssetId: pageId,
          isActive: true,
        },
      });
      if (!mapping) return null;
      if ((await assignedClinic(mapping, 'facebook_page')) !== clinicId) return null;
    }
  } else {
    const mapping = await db.ClinicMetaAsset.findByPk(source.mapping_id, {
      ...o,
      attributes: ['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope'],
    });
    pageId = channel === 'instagram' ? source.parent_page_id : accountId;
    clinicId = await assignedClinic(mapping, kind);
  }
  if (
    !row.clinicIds.includes(clinicId) ||
    !row.selected.some((a) => a.kind === 'facebook_page' && a.id === pageId)
  )
    return null;
  return {
    clinicId,
    channel,
    accountId,
    pageId,
    appId: row.app_id,
    connectionRef: row.connection_ref,
    enrollmentId: row.enrollment_id,
    tenantRef: 'clinic:' + row.clinicIds[0],
  };
}
function sameRoute(a, b) {
  return (
    !!a &&
    !!b &&
    [
      'clinicId',
      'channel',
      'accountId',
      'pageId',
      'appId',
      'connectionRef',
      'enrollmentId',
      'tenantRef',
    ].every((k) => a[k] === b[k])
  );
}
module.exports = { resolveRoute, sameRoute };
