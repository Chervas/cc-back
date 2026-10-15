'use strict';

// The immutable match receipt credits historical conversion even if Google's
// complete feed later loses the review. Public reputation uses visible rows only.
const REVIEW_LINKS = `
  SELECT e.id, e.created_at, e.payload,
    COALESCE(i.clinica_id,l.clinica_id) clinic_id,
    CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.business_location_id')) AS UNSIGNED) location_id,
    JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) review_name
  FROM MarketingPatientContactEvents e
  JOIN MarketingPatientLists l ON l.id=e.list_id
  JOIN MarketingPatientListItems i ON i.id=e.item_id
  WHERE e.event_type='google_review_matched'
    AND COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds)
    AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) NOT IN ('','null')
    AND NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents te
      WHERE te.list_id=i.list_id AND te.item_id=i.id
      AND te.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))`;

const MATCHES = `${REVIEW_LINKS} AND l.objective_id='mass_sends'
  AND (JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
    OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage'))='solicitud_resena')`;

const FILTERS = {
  all: '1=1',
  linked: 'attributed_to_clinicaclick=1',
  high_confidence: 'attributed_to_clinicaclick=1 AND match_confidence>=0.8',
  unattributed: 'attributed_to_clinicaclick=0',
};

async function countHistoricalMatches(db, clinicIds) {
  if (!clinicIds.length) return 0;
  const rows = await db.sequelize.query(`WITH matches AS (${MATCHES})
    SELECT COUNT(DISTINCT BINARY CONCAT(location_id,'/',SUBSTRING_INDEX(review_name,'/reviews/',-1))) total FROM matches`, {
    replacements: { clinicIds }, type: db.Sequelize.QueryTypes.SELECT,
  });
  return Number(rows[0]?.total || 0);
}

async function listMissingReviews(db, { clinicIds, locationIds = [], limit = 10, offset = 0, attribution = 'all' }) {
  if (!Object.hasOwn(FILTERS, attribution)) {
    const error = new Error('Invalid review attribution filter');
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }
  limit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
  offset = Math.min(100000, Math.max(0, Number.parseInt(offset, 10) || 0));
  const emptySummary = { total: 0, linked: 0, high_confidence: 0, unattributed: 0 };
  if (!clinicIds.length) return { items: [], total: 0, limit, offset, attribution, summary: emptySummary };
  const scope = locationIds.length ? 'r.business_location_id IN (:locationIds)' : 'r.clinica_id IN (:clinicIds)';
  const matchScope = locationIds.length ? 'm.location_id IN (:locationIds)' : 'm.clinic_id IN (:clinicIds)';
  const cte = `WITH matches AS (${REVIEW_LINKS}), ranked_matches AS (
    SELECT matches.*, ROW_NUMBER() OVER (PARTITION BY location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
      ORDER BY created_at,id) review_rank FROM matches
  ), observed_missing AS (
    SELECT CONCAT('review:',r.id) history_id,r.reviewer_name,r.star_rating,r.clinica_id clinic_id,
      COALESCE(r.first_seen_at,r.created_at) first_seen_at,r.last_seen_at,r.google_missing_at,
      'complete_google_sync' detection_source,IF(m.id IS NULL,0,1) attributed_to_clinicaclick,
      IF(m.id IS NULL,NULL,COALESCE(r.match_confidence,JSON_EXTRACT(m.payload,'$.confidence'))) confidence_value
    FROM BusinessProfileReviews r LEFT JOIN ranked_matches m
      ON m.review_rank=1 AND m.location_id=r.business_location_id
        AND BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)
    WHERE ${scope} AND r.google_missing_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM BusinessProfileReviews visible
        WHERE visible.business_location_id=r.business_location_id AND visible.google_missing_at IS NULL
          AND BINARY SUBSTRING_INDEX(visible.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1))
    UNION ALL
    SELECT CONCAT('match:',m.id),JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.reviewer_name')),
      CAST(JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.star_rating')) AS UNSIGNED),m.clinic_id,
      m.created_at,NULL,NULL,'historical_match',1,JSON_EXTRACT(m.payload,'$.confidence')
    FROM ranked_matches m WHERE m.review_rank=1 AND ${matchScope} AND NOT EXISTS (
      SELECT 1 FROM BusinessProfileReviews r WHERE r.business_location_id=m.location_id
        AND BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1))
  ), missing_reviews AS (
    SELECT observed_missing.*,CASE WHEN JSON_UNQUOTE(confidence_value) REGEXP '^[0-9]+([.][0-9]+)?$'
      AND CAST(JSON_UNQUOTE(confidence_value) AS DECIMAL(8,4)) BETWEEN 0 AND 1
      THEN CAST(JSON_UNQUOTE(confidence_value) AS DECIMAL(8,4)) ELSE NULL END match_confidence
    FROM observed_missing
  )`;
  const options = { replacements: { clinicIds, locationIds, limit, offset }, type: db.Sequelize.QueryTypes.SELECT };
  const [counts] = await db.sequelize.query(`${cte} SELECT COUNT(*) total,
    COALESCE(SUM(attributed_to_clinicaclick=1),0) linked,
    COALESCE(SUM(attributed_to_clinicaclick=1 AND match_confidence>=0.8),0) high_confidence,
    COALESCE(SUM(attributed_to_clinicaclick=0),0) unattributed,
    COALESCE(SUM(${FILTERS[attribution]}),0) filtered_total FROM missing_reviews`, options);
  const rows = await db.sequelize.query(`${cte} SELECT history_id,reviewer_name,star_rating,clinic_id,
    first_seen_at,last_seen_at,google_missing_at,detection_source,attributed_to_clinicaclick,match_confidence
    FROM missing_reviews WHERE ${FILTERS[attribution]}
    ORDER BY google_missing_at DESC,first_seen_at DESC,history_id LIMIT :limit OFFSET :offset`, options);
  return { items: rows.map(row => ({ ...row, star_rating: Number(row.star_rating) || null,
    clinic_id: Number(row.clinic_id), attributed_to_clinicaclick: Number(row.attributed_to_clinicaclick) === 1,
    match_confidence: row.match_confidence == null ? null : Number(row.match_confidence),
  })), total: Number(counts.filtered_total || 0), limit, offset, attribution,
    summary: Object.fromEntries(Object.keys(emptySummary).map(key => [key, Number(counts[key] || 0)])) };
}

module.exports = { countHistoricalMatches, listMissingReviews };
