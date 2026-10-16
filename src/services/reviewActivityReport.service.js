'use strict';

const calendar = require('../lib/availability-calendar');
const { buildReviewResponseHeatmaps } = require('../lib/review-response-heatmaps');
const TIMEZONE = 'Europe/Madrid';
const PERIODS = ['2d', '7d', '30d', '90d', 'month', 'year'];
const METRICS = ['requests_sent', 'google_links_sent', 'google_reviews_total', 'google_reviews_attributed', 'google_reviews_unattributed', 'google_reviews_missing'];
const addDays = (day, count) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10); };

function reportRange(period = '30d', now = new Date()) {
  if (!PERIODS.includes(period) || !Number.isFinite(+now)) throw Object.assign(Error('Periodo de informe inválido'), { status: 400 });
  const today = calendar.formatDateLocal(now, TIMEZONE);
  const from = period === 'month' ? today.slice(0, 8) + '01' : period === 'year' ? today.slice(0, 4) + '-01-01'
    : addDays(today, 1 - Number.parseInt(period, 10));
  return { period, from, to: today, start: calendar.localDateTimeToUtc(from, '00:00:00', TIMEZONE),
    end: calendar.localDateTimeToUtc(addDays(today, 1), '00:00:00', TIMEZONE) };
}

function aggregateReport(rows, range, quality = {}) {
  const days = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) days.push(day);
  const byDay = new Map(days.map(day => [day, Object.fromEntries(METRICS.map(key => [key, 0]))]));
  const heatmapRows = { responses: [], google_reviews: [] };
  const totals = Object.fromEntries(METRICS.map(key => [key, 0]));
  for (const row of rows) {
    const at = new Date(row.at_utc), count = Number(row.total);
    if (!row.at_utc || !Number.isFinite(+at) || !Number.isFinite(count) || count < 0) continue;
    const day = calendar.formatDateLocal(at, TIMEZONE), bucket = byDay.get(day);
    if (!bucket) continue;
    if (Object.hasOwn(bucket, row.metric)) { bucket[row.metric] += count; totals[row.metric] += count; }
    const heatmap = row.metric === 'responses' ? 'responses' : row.metric === 'google_reviews_total' ? 'google_reviews' : null;
    if (heatmap) {
      const { hour } = calendar.formatPartsInTimeZone(at, TIMEZONE);
      // Clock seasons cover every day, including March/October and both DST transitions.
      const season = calendar.offsetMinutesForTimeZone(at, TIMEZONE) > 60 ? 'summer' : 'winter';
      heatmapRows[heatmap].push({ season, weekday: (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7, hour, total: count });
    }
  }
  return {
    success: true, timezone: TIMEZONE,
    range: { period: range.period, from: range.from, to: range.to }, periods: PERIODS,
    totals, series: METRICS.map(key => ({ key, data: days.map(day => ({ x: day, y: byDay.get(day)[key] })) })),
    missing: { total: Number(quality.missing_total || 0), detected_in_period: totals.google_reviews_missing,
      without_date: Number(quality.missing_without_date || 0) },
    heatmaps: Object.fromEntries(Object.entries(heatmapRows).map(([key, data]) => [key, buildReviewResponseHeatmaps(data)])),
    quality: { missing_without_date: Number(quality.missing_without_date || 0),
      reviews_with_observation_date: Number(quality.reviews_with_observation_date || 0),
      attribution: 'stored_match_receipts', removal_dates: 'first_confirmed_current_absence', season: 'clock_change' },
  };
}

async function readReport(db, { clinicIds = [], locationIds = [], period = '30d', now = new Date() } = {}) {
  const range = reportRange(period, now);
  clinicIds = [...new Set(clinicIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  locationIds = [...new Set(locationIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!clinicIds.length) return aggregateReport([], range);
  const replacements = { clinicIds, locationIds, start: range.start, end: range.end };
  const options = { replacements, type: db.Sequelize.QueryTypes.SELECT };
  const testExclusion = `NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents t
    WHERE t.list_id=i.list_id AND t.item_id=i.id AND t.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))`;
  const requestsCte = `WITH scope_items AS (
    SELECT id FROM MarketingPatientListItems WHERE clinica_id IN (:clinicIds)
    UNION ALL SELECT i.id FROM MarketingPatientLists l JOIN MarketingPatientListItems i ON i.list_id=l.id
      WHERE l.clinica_id IN (:clinicIds) AND i.clinica_id IS NULL
  ), requests AS (
    SELECT i.* FROM scope_items s JOIN MarketingPatientListItems i ON i.id=s.id
    JOIN MarketingPatientLists l ON l.id=i.list_id WHERE l.objective_id='mass_sends'
      AND (JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
        OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage'))='solicitud_resena') AND ${testExclusion}
  )`;
  const requestRows = await db.sequelize.query(`${requestsCte}
    SELECT 'requests_sent' metric,DATE_FORMAT(sent_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) total FROM requests
      WHERE sent_at >= :start AND sent_at < :end GROUP BY at_utc
    UNION ALL
    SELECT 'google_links_sent',DATE_FORMAT(e.occurred_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(DISTINCT e.id)
      FROM MarketingPatientContactEvents e JOIN requests i ON i.id=e.item_id AND i.list_id=e.list_id
      WHERE e.event_type='review_rating_followup_sent' AND e.occurred_at >= :start AND e.occurred_at < :end
        AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.kind'))='review_google_link_followup'
        AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.status'))='sent'
      GROUP BY at_utc
    UNION ALL
    SELECT 'responses',DATE_FORMAT(e.occurred_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) FROM (
      SELECT e.occurred_at,ROW_NUMBER() OVER (PARTITION BY e.list_id,e.item_id ORDER BY e.occurred_at DESC,e.id DESC) reply_rank
      FROM MarketingPatientContactEvents e JOIN requests i ON i.id=e.item_id AND i.list_id=e.list_id
      WHERE e.event_type IN ('review_rating_received','review_request_rating') AND e.occurred_at >= :start AND e.occurred_at < :end
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.rating')) AS UNSIGNED) BETWEEN 1 AND 5
    ) e WHERE reply_rank=1 GROUP BY at_utc`, options);

  const locationScope = locationIds.length ? 'r.business_location_id IN (:locationIds)' : 'r.clinica_id IN (:clinicIds)';
  const matchScope = locationIds.length ? 'm.location_id IN (:locationIds)' : 'm.clinic_id IN (:clinicIds)';
  const inventoryCte = `WITH matches AS (
    SELECT e.id,e.created_at,e.occurred_at,COALESCE(i.clinica_id,l.clinica_id) clinic_id,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.business_location_id')) AS UNSIGNED) location_id,
      JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) review_name
    FROM MarketingPatientContactEvents e JOIN MarketingPatientListItems i ON i.id=e.item_id
    JOIN MarketingPatientLists l ON l.id=e.list_id WHERE e.event_type='google_review_matched'
      AND COALESCE(i.clinica_id,l.clinica_id) IN (:clinicIds) AND ${testExclusion}
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.review_name')) NOT IN ('','null')
  ), ranked_matches AS (
    SELECT matches.*,ROW_NUMBER() OVER (PARTITION BY location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1) ORDER BY created_at,id) rank_id FROM matches
  ), ranked_reviews AS (
    SELECT r.*,ROW_NUMBER() OVER (PARTITION BY business_location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
      ORDER BY google_missing_at IS NULL DESC,last_seen_at DESC,id DESC) rank_id FROM BusinessProfileReviews r WHERE ${locationScope}
  ), inventory AS (
    SELECT COALESCE(r.create_time,r.first_seen_at,r.created_at) published_at,r.google_missing_at missing_at,
      IF(m.id IS NULL,0,1) attributed,IF(r.create_time IS NULL,1,0) observation_date,0 missing_without_date
    FROM ranked_reviews r LEFT JOIN ranked_matches m ON m.rank_id=1 AND m.location_id=r.business_location_id
      AND BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)
    WHERE r.rank_id=1
    UNION ALL
    SELECT m.occurred_at,NULL,1,0,1 FROM ranked_matches m WHERE m.rank_id=1 AND ${matchScope}
      AND NOT EXISTS (SELECT 1 FROM BusinessProfileReviews r WHERE r.business_location_id=m.location_id
        AND BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1))
  )`;
  const reviewRows = await db.sequelize.query(`${inventoryCte}
    SELECT 'google_reviews_total' metric,DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) total FROM inventory
      WHERE published_at >= :start AND published_at < :end GROUP BY at_utc
    UNION ALL SELECT 'google_reviews_attributed',DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) FROM inventory
      WHERE attributed=1 AND published_at >= :start AND published_at < :end GROUP BY at_utc
    UNION ALL SELECT 'google_reviews_unattributed',DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) FROM inventory
      WHERE attributed=0 AND published_at >= :start AND published_at < :end GROUP BY at_utc
    UNION ALL SELECT 'google_reviews_missing',DATE_FORMAT(missing_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) FROM inventory
      WHERE missing_at >= :start AND missing_at < :end GROUP BY at_utc`, options);
  const [quality] = await db.sequelize.query(`${inventoryCte} SELECT COALESCE(SUM(missing_at IS NOT NULL OR missing_without_date=1),0) missing_total,
    COALESCE(SUM(missing_without_date),0) missing_without_date,
    COALESCE(SUM(observation_date=1 AND published_at >= :start AND published_at < :end),0) reviews_with_observation_date FROM inventory`, options);
  return aggregateReport([...requestRows, ...reviewRows], range, quality);
}

module.exports = { readReport, reportRange, aggregateReport, METRICS, PERIODS };
