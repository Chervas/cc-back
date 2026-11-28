'use strict';

const { creativeFromSnapshot } = require('./adSharing.service');
const graphId = value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value);

function adLink(id, account) {
  const params = new URLSearchParams();
  if (account) params.set('act', account);
  params.set('selected_ad_ids', id);
  return 'https://adsmanager.facebook.com/adsmanager/manage/ads?' + params;
}

function preview(row, now) {
  const account = String(row.ad_account_id).replace(/^act_/, '');
  if (!graphId(account) || !graphId(row.entity_id)) return null;
  const ad = { name: row.name, url: adLink(row.entity_id, account) };
  const reference = row.creative_payload?.reference;
  if (!reference || reference.account_id !== account || reference.ad_id !== row.entity_id ||
      reference.provider !== 'meta_ads' || reference.group_id !== row.parent_id) return ad;
  const creative = creativeFromSnapshot(row.creative_payload, reference, now);
  // Render each verified variant separately. The webhook does not identify which one a viewer saw.
  const fields = item => ({ headline: item.headline || null, body: item.body || null,
    image: item.imageUrl || item.thumbnailUrl || null });
  if (creative?.alternatives?.length) {
    ad.variants = creative.alternatives.map(fields).filter(v => v.headline || v.body || v.image);
  } else if (creative) {
    Object.assign(ad, fields(creative));
  }
  return ad;
}

async function forComments(db, clinicId, comments, now) {
  const ids = [...new Set(comments.map(m => m.metadata.social.ad?.id).filter(graphId))];
  const results = new Map(ids.map(id => [id, { url: adLink(id) }]));
  if (!ids.length) return results;
  const [rows] = await db.sequelize.query(`SELECT a.entity_id, a.name, a.ad_account_id, a.parent_id, a.creative_payload
    FROM SocialAdsEntities a WHERE a.level='ad' AND a.entity_id IN (:ids)
    AND EXISTS (SELECT 1 FROM ClinicMetaAssets m INNER JOIN Clinicas c ON c.id_clinica=:clinicId
      WHERE m.assetType='ad_account' AND m.isActive=1
      AND m.metaAssetId IN (a.ad_account_id, CONCAT('act_',REPLACE(a.ad_account_id,'act_','')),REPLACE(a.ad_account_id,'act_',''))
      AND ((m.assignmentScope='clinic' AND m.clinicaId=c.id_clinica)
        OR (m.assignmentScope='group' AND m.grupoClinicaId=c.grupoClinicaId)))
    AND EXISTS (SELECT 1 FROM SocialAdsInsightsDaily i WHERE i.level='ad' AND i.entity_id=a.entity_id
      AND i.ad_account_id=a.ad_account_id AND i.clinica_id=:clinicId AND i.publisher_platform='instagram')`,
    { replacements: { ids, clinicId }, logging: false });
  for (const row of rows) {
    const ad = preview(row, now);
    if (ad) results.set(row.entity_id, ad);
  }
  return results;
}

module.exports = { forComments, preview };
