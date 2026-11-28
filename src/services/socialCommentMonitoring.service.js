'use strict';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const stuckKey = 'instagram.comment_processing_delayed';
const gapKey = 'instagram.ad_comments_unmatched';

async function pendingComments(query, now) {
  return query(`SELECT route->>'$.clinicId' AS clinic, COUNT(*) AS total
    FROM SocialInboxReceipts WHERE state IN ('pending','notify','review')
    AND updatedAt BETWEEN :start AND :cutoff AND event->>'$.channel'='instagram'
    AND event->>'$.type'='comment' AND event->>'$.source'='new' AND event->>'$.echo'='false'
    GROUP BY clinic`, { start: new Date(now - 7 * DAY), cutoff: new Date(now - 15 * 60000) });
}

// Only compare complete reporting days in which the clinic had an Instagram route.
async function monitoredClinics(query) {
  // Scope operational statistics from local assignments. No permission check or provider token is needed.
  const rows = await query(`SELECT routes.clinic, MAX(routes.since) AS since FROM (
    SELECT CASE WHEN m.assignmentScope='clinic' THEN m.clinicaId
      WHEN g.instagram_assignment_mode='group' AND g.instagram_primary_asset_id=m.id AND JSON_LENGTH(e.clinic_ids)=1
        THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(e.clinic_ids,'$[0]')) AS UNSIGNED)
      ELSE shares.clinic END AS clinic, e.activated_at AS since
    FROM MetaMarketingBrokerBindings b JOIN MetaMarketingEnrollmentRequests e
      ON e.enrollment_id=b.enrollment_id AND e.state='active'
    JOIN ClinicMetaAssets m ON m.id=b.mapping_id AND m.assetType='instagram_business' AND m.isActive=1
    LEFT JOIN GruposClinicas g ON m.assignmentScope='group' AND g.id_grupo=m.grupoClinicaId
    LEFT JOIN (SELECT assetId,grupoClinicaId,MIN(clinicaId) AS clinic FROM GroupAssetClinicAssignments
      WHERE assetType='meta.instagram_business' GROUP BY assetId,grupoClinicaId HAVING COUNT(DISTINCT clinicaId)=1) shares
      ON m.assignmentScope='group' AND shares.assetId=m.id AND shares.grupoClinicaId=m.grupoClinicaId
    WHERE b.state='active' AND b.parent_page_id IS NOT NULL
    UNION ALL SELECT CAST(SUBSTRING(x.reserved_scope,8) AS UNSIGNED), GREATEST(e.activated_at,x.confirmed_at)
      FROM MetaMarketingInstagramExtensions x JOIN MetaMarketingEnrollmentRequests e
        ON e.enrollment_id=x.enrollment_id AND e.state='active'
      WHERE x.status='active' AND x.reserved_scope REGEXP '^clinic:[1-9][0-9]*$'
    ) routes WHERE routes.clinic IS NOT NULL AND routes.since IS NOT NULL GROUP BY routes.clinic`, {});
  return new Map(rows.map(row => {
    const start = new Date(row.since);
    start.setUTCHours(24, 0, 0, 0);
    return [Number(row.clinic), +start];
  }));
}

async function unmatchedAds(query, scopes, now) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const clinics = [...scopes.keys()].filter(id => scopes.get(id) < +end);
  if (!clinics.length) return [];
  const start = new Date(+end - 2 * DAY);
  const rows = await query(`SELECT owned.clinic, actions.entity_id AS ad, actions.date AS day,
      MAX(actions.value) AS total FROM
      (SELECT ad_account_id,entity_id,date, MIN(clinica_id) AS clinic FROM SocialAdsInsightsDaily
       WHERE clinica_id IN (:clinics) AND date >= :start AND date < :end AND level='ad'
       AND publisher_platform='instagram' AND impressions>0 GROUP BY ad_account_id,entity_id,date
       HAVING COUNT(DISTINCT clinica_id)=1) owned
      JOIN SocialAdsActionsDaily actions ON actions.ad_account_id=owned.ad_account_id
       AND actions.entity_id=owned.entity_id AND actions.date=owned.date AND actions.level='ad'
       AND actions.publisher_platform='instagram'
       WHERE actions.action_type IN ('comment','onsite_conversion.post_net_comment') AND actions.value>0
       GROUP BY owned.clinic, actions.entity_id, actions.date`, { clinics, start, end });
  const expected = new Map();
  for (const row of rows) {
    if (!Number.isSafeInteger(Number(row.clinic)) || Date.parse(String(row.day)) < scopes.get(Number(row.clinic))) continue;
    const key = row.clinic + '/' + row.ad;
    const item = expected.get(key) || { clinic: Number(row.clinic), ad: row.ad, total: 0 };
    item.total += Number(row.total);
    expected.set(key, item);
  }
  if (!expected.size) return [];
  // Include an adjacent day on either side for Ads account timezones and delivery delay.
  // Unattributed webhooks cannot prove a match to any particular ad.
  const receipts = await query(`SELECT route->>'$.clinicId' AS clinic, event->>'$.ad.id' AS ad, COUNT(*) AS total
    FROM SocialInboxReceipts WHERE state IN ('persisted','notify','pending','review')
    AND updatedAt >= :earliest AND event->>'$.at' >= :fromIso AND event->>'$.at' < :toIso
    AND event->>'$.channel'='instagram' AND event->>'$.type'='comment'
    AND event->>'$.source'='new' AND event->>'$.echo'='false' AND event->>'$.ad.id' IS NOT NULL
    GROUP BY clinic, ad`, { earliest: new Date(+start - DAY), fromIso: new Date(+start-DAY).toISOString(),
    toIso: new Date(+end+DAY).toISOString() });
  for (const row of receipts) {
    const item = expected.get(row.clinic + '/' + row.ad);
    if (item) item.total -= Number(row.total);
  }
  return [...expected.values()].filter(item => item.total > 0);
}

function createMonitor() {
  let lastAdsCheck = -Infinity;
  let checkingAds = false;
  return async function check(db, queue, now = Date.now()) {
    const query = (sql, replacements) => db.sequelize.query(sql, { replacements,
      type: db.Sequelize.QueryTypes.SELECT, logging: false });
    const results = [];
    const pending = await pendingComments(query, now);
    if (pending.length) {
      const summary = pending.map(row => (row.clinic ? 'Clínica ' + row.clinic : 'Cuenta sin asignar') + ' (' + row.total + ')');
      results.push(await queue({ eventKey: stuckKey, allowedChannels: ['panel'], payload: {
        severity: 'warning', title: 'Comentarios de Instagram pendientes de procesar',
        detail: summary.slice(0,20).join(', '), action: 'Revisar los recibos pendientes y los permisos de recepción de estas cuentas.' } }));
    }
    if (checkingAds || now - lastAdsCheck < HOUR) return results;
    checkingAds = true;
    try {
      const gaps = await unmatchedAds(query, await monitoredClinics(query), now);
      if (gaps.length) results.push(await queue({ eventKey: gapKey, allowedChannels: ['panel'], payload: {
        severity: 'warning', title: 'Comentarios de anuncios de Instagram por cotejar',
        detail: gaps.slice(0,20).map(item => 'Clínica ' + item.clinic + ', anuncio ' + item.ad + ' (' + item.total + ')').join(' · '),
        action: 'Contrastar el anuncio en Meta. El comentario puede haber llegado a QuickChat sin identificador de anuncio.' } }));
      lastAdsCheck = now;
    } finally { checkingAds = false; }
    return results;
  };
}

module.exports = { check: createMonitor(), unmatchedAds, pendingComments };
