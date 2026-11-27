'use strict';

const E = require('./metaMarketingEnrollment.contract');
const bindings = require('./metaMarketingEnrollmentBinding.service');
const { assetSetDigest } = require('./metaMarketingEffectiveCredential.service');
const { destinationsFor } = require('./metaMarketingInstagramExtension.service');
const { graphId } = require('../../services/integrations-broker/src/meta-marketing-contract');

async function currentEnrollment(db, enrollmentId, transaction, expectedConnection) {
  const raw = await db.MetaMarketingEnrollmentRequest.findByPk(enrollmentId, {
    transaction, raw: true, logging: false,
  });
  if (!raw || raw.state !== 'active' || (expectedConnection && raw.connection_ref !== expectedConnection)) return null;
  const row = E.request(raw);
  try {
    const committed = await bindings.createBindings({ models: db }).committed(row.enrollment_id, transaction);
    return { row, committed };
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
}

async function resolveRoute(db, recipient, transaction) {
  if (transaction) return resolveRecipient(db, recipient, transaction);
  // The enrollment and asset bindings must be checked under the same locks in background jobs as in intake.
  return db.sequelize.transaction(t => resolveRecipient(db, recipient, t));
}

async function resolveRecipient(db, { channel, accountId }, transaction, knownEnrollment) {
  if (!['instagram', 'messenger'].includes(channel) || !graphId(accountId)) return null;
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
  const snapshot = knownEnrollment || await currentEnrollment(
    db, source.enrollment_id, transaction, source.connection_ref,
  );
  if (!snapshot || source.enrollment_id !== snapshot.row.enrollment_id
    || source.connection_ref !== snapshot.row.connection_ref) return null;
  const { row, committed } = snapshot;
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
      !Number.isFinite(+source.confirmed_at) || +source.confirmed_at <= 0 || +source.confirmed_at > Date.now() ||
      source.scope_key !== row.scope_key ||
      !/^[a-f0-9]{64}$/.test(source.selected_candidate_digest) ||
      (await db.ClinicMetaAsset.findOne({
        ...o,
        where: { assetType: kind, metaAssetId: accountId, isActive: true },
      })) ||
      (await db.MetaMarketingBrokerRevocation.findOne({ ...o, where: { asset_ref: assetRef } }))
    )
      return null;
    if (!snapshot.instagramDestinations) {
      snapshot.instagramDestinations = await destinationsFor({
        models: db, row, committed, transaction,
        settings: () => [], selfService: () => true,
      });
    }
    const targets = snapshot.instagramDestinations;
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
  } else {
    const mapping = await db.ClinicMetaAsset.findByPk(source.mapping_id, {
      ...o,
      attributes: ['id', 'clinicaId', 'grupoClinicaId', 'assignmentScope'],
    });
    pageId = channel === 'instagram' ? source.parent_page_id : accountId;
    clinicId = await assignedClinic(mapping, kind);
    if (channel === 'instagram' && !row.selected.some(a =>
      a.kind === 'instagram_business' && a.id === accountId && a.parentPageId === pageId)) return null;
  }
  if (
    !row.clinicIds.includes(clinicId) ||
    !row.selected.some((a) => a.kind === 'facebook_page' && a.id === pageId)
  )
    return null;
  if (channel === 'instagram') {
    // A group can assign the Instagram account and its parent Page to different clinics.
    // Use the same recipient checks for the parent, including its physical uniqueness.
    const pageRoute = await resolveRecipient(db, { channel: 'messenger', accountId: pageId }, transaction, snapshot);
    if (!pageRoute || pageRoute.clinicId !== clinicId) return null;
  }
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
// These are CRM routing facts. Reading them never grants a Meta permission or activates an inbox.
async function routesForEnrollment(db, enrollmentId, transaction) {
  const snapshot = await currentEnrollment(db, enrollmentId, transaction);
  if (!snapshot) return { status: 'enrollment_unavailable', routes: [], review: [] };
  const { row } = snapshot;
  const recipients = new Map();
  function add(channel, accountId) {
    recipients.set(channel + ':' + accountId, { channel, accountId });
  }
  for (const asset of row.selected) {
    if (asset.kind === 'facebook_page') add('messenger', asset.id);
    if (asset.kind === 'instagram_business') add('instagram', asset.id);
  }
  const extensions = await db.MetaMarketingInstagramExtension.findAll({
    transaction, raw: true, logging: false,
    attributes: ['selected_instagram_id'],
    where: { enrollment_id: enrollmentId, status: 'active' },
    order: [['selected_instagram_id', 'ASC']],
  });
  for (const extension of extensions) add('instagram', extension.selected_instagram_id);
  const routes = [];
  const review = [];
  for (const recipient of recipients.values()) {
    const route = await resolveRecipient(db, recipient, transaction, snapshot);
    if (route) routes.push(route);
    else review.push(recipient);
  }
  return { status: review.length ? 'assignment_review' : 'resolved', routes, review };
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
module.exports = { resolveRoute, sameRoute, routesForEnrollment };
