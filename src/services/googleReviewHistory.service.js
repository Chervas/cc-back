'use strict';

// The immutable match receipt credits historical conversion even if Google's
// complete feed later loses the review. Public reputation uses visible rows only.
const MATCHES = `
  SELECT e.id, e.created_at, e.payload,
    COALESCE(i.clinica_id,l.clinica_id) clinic_id,
    CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.business_location_id')) AS UNSIGNED) location_id,
    JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) review_name
  FROM MarketingPatientContactEvents e
  JOIN MarketingPatientLists l ON l.id=e.list_id
  JOIN MarketingPatientListItems i ON i.id=e.item_id
  WHERE e.event_type='google_review_matched' AND l.objective_id='mass_sends'
    AND COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds)
    AND (JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
      OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage'))='solicitud_resena')
    AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) NOT IN ('','null')
    AND NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents te
      WHERE te.list_id=i.list_id AND te.item_id=i.id
      AND te.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))`;

async function countHistoricalMatches(db, clinicIds) {
  if (!clinicIds.length) return 0;
  const rows = await db.sequelize.query(`WITH matches AS (${MATCHES})
    SELECT COUNT(DISTINCT BINARY CONCAT(location_id,'/',SUBSTRING_INDEX(review_name,'/reviews/',-1))) total FROM matches`, {
    replacements: { clinicIds }, type: db.Sequelize.QueryTypes.SELECT,
  });
  return Number(rows[0]?.total || 0);
}

async function listMissingReviews(db, { clinicIds, locationIds = [], limit = 10, offset = 0 }) {
  limit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 10));
  offset = Math.min(100000, Math.max(0, Number.parseInt(offset, 10) || 0));
  if (!clinicIds.length) return { items: [], total: 0, limit, offset };
  const scope = locationIds.length ? 'r.business_location_id IN (:locationIds)' : 'r.clinica_id IN (:clinicIds)';
  const cte = `WITH matches AS (${MATCHES}), ranked_matches AS (
    SELECT matches.*, ROW_NUMBER() OVER (PARTITION BY location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
      ORDER BY created_at,id) review_rank FROM matches
  ), missing_reviews AS (
    SELECT CONCAT('review:',r.id) history_id,r.reviewer_name,r.star_rating,r.clinica_id clinic_id,
      COALESCE(r.first_seen_at,r.created_at) first_seen_at,r.last_seen_at,r.google_missing_at,
      'complete_google_sync' detection_source
    FROM BusinessProfileReviews r WHERE ${scope} AND r.google_missing_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM BusinessProfileReviews visible
        WHERE visible.business_location_id=r.business_location_id AND visible.google_missing_at IS NULL
          AND BINARY SUBSTRING_INDEX(visible.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1))
    UNION ALL
    SELECT CONCAT('match:',m.id),JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.reviewer_name')),
      CAST(JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.star_rating')) AS UNSIGNED),m.clinic_id,
      m.created_at,NULL,NULL,'historical_match'
    FROM ranked_matches m WHERE m.review_rank=1 AND NOT EXISTS (
      SELECT 1 FROM BusinessProfileReviews r WHERE r.business_location_id=m.location_id
        AND BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1))
  )`;
  const options = { replacements: { clinicIds, locationIds, limit, offset }, type: db.Sequelize.QueryTypes.SELECT };
  const count = await db.sequelize.query(`${cte} SELECT COUNT(*) total FROM missing_reviews`, options);
  const rows = await db.sequelize.query(`${cte} SELECT * FROM missing_reviews
    ORDER BY google_missing_at DESC,first_seen_at DESC,history_id LIMIT :limit OFFSET :offset`, options);
  return { items: rows.map(row => ({ ...row, star_rating: Number(row.star_rating) || null,
    clinic_id: Number(row.clinic_id) })), total: Number(count[0]?.total || 0), limit, offset };
}

module.exports = { countHistoricalMatches, listMissingReviews };
