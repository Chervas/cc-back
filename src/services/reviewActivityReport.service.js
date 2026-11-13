'use strict';

const calendar = require('../lib/availability-calendar');
const { buildReviewResponseHeatmaps } = require('../lib/review-response-heatmaps');
const TIMEZONE = 'Europe/Madrid';
const PERIODS = ['2d', '7d', '30d', '90d', 'month', 'year'];
const PERIOD_METRICS = ['requests_sent', 'ratings', 'google_reviews_total', 'google_reviews_attributed', 'converted_requests', 'opt_outs', 'google_reviews_missing'];
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

function previousReportRange(range) {
  const days = Math.round((Date.parse(range.to + 'T12:00:00Z') - Date.parse(range.from + 'T12:00:00Z')) / 86400000) + 1;
  const from = addDays(range.from, -days), to = addDays(range.from, -1);
  return { period: range.period, from, to, start: calendar.localDateTimeToUtc(from, '00:00:00', TIMEZONE), end: range.start };
}
function compareReviewPeriods(rows, range) {
  const previous = previousReportRange(range);
  const totals = r => {
    const result = Object.fromEntries(PERIOD_METRICS.map(key => [key, 0]));
    for (const row of rows) {
      const at = row.at_utc && new Date(row.at_utc);
      const day = at && Number.isFinite(+at) ? calendar.formatDateLocal(at, TIMEZONE) : null;
      if (day && day >= r.from && day <= r.to && Object.hasOwn(result, row.metric)) result[row.metric] += Number(row.total) || 0;
    }
    // Conversion uses the sent cohort and its stored matches, never unrelated reviews published in that window.
    result.conversion = result.requests_sent ? result.converted_requests / result.requests_sent * 100 : null;
    return result;
  };
  const current = totals(range), before = totals(previous);
  return { range: { from: previous.from, to: previous.to }, metrics: Object.fromEntries(Object.entries(current).map(([key, value]) => [key,
    { current: value, previous: before[key], change_percent: value == null || before[key] == null || (before[key] === 0 && value !== 0)
      ? null : before[key] === 0 ? 0 : (value - before[key]) / before[key] * 100 }])) };
}

function aggregateReport(rows, range, quality = {}) {
  const days = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) days.push(day);
  const byDay = new Map(days.map(day => [day, Object.fromEntries(METRICS.map(key => [key, 0]))]));
  const heatmapRows = { responses: [], google_reviews: [] };
  const totals = Object.fromEntries(METRICS.map(key => [key, 0]));
  const entities = new Map(Object.entries(quality.clinicNames || {}).map(([id, name]) => [Number(id), { clinic_id: Number(id), clinic_name: name,
    days: new Map(days.map(day => [day, Object.fromEntries(METRICS.map(key => [key, 0]))])) }]));
  for (const row of rows) {
    const at = new Date(row.at_utc), count = Number(row.total);
    if (!row.at_utc || !Number.isFinite(+at) || !Number.isFinite(count) || count < 0) continue;
    const day = calendar.formatDateLocal(at, TIMEZONE), bucket = byDay.get(day);
    if (!bucket) continue;
    if (Object.hasOwn(bucket, row.metric)) { bucket[row.metric] += count; totals[row.metric] += count; }
    if (row.clinic_id != null && Object.hasOwn(bucket, row.metric)) {
      const id = Number(row.clinic_id);
      if (!entities.has(id)) entities.set(id, { clinic_id: id, clinic_name: id ? `Clínica ${id}` : 'Fichas compartidas',
        days: new Map(days.map(day => [day, Object.fromEntries(METRICS.map(key => [key, 0]))])) });
      entities.get(id).days.get(day)[row.metric] += count;
    }
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
    by_clinic: [...entities.values()].map(entity => ({ clinic_id: entity.clinic_id, clinic_name: entity.clinic_name,
      series: METRICS.map(key => ({ key, data: days.map(day => ({ x: day, y: entity.days.get(day)[key] })) })) })),
    missing: { total: Number(quality.missing_total || 0), detected_in_period: totals.google_reviews_missing,
      without_date: Number(quality.missing_without_date || 0) },
    heatmaps: Object.fromEntries(Object.entries(heatmapRows).map(([key, data]) => [key, buildReviewResponseHeatmaps(data)])),
    quality: { missing_without_date: Number(quality.missing_without_date || 0),
      reviews_with_observation_date: Number(quality.reviews_with_observation_date || 0),
      attribution: 'stored_match_receipts', removal_dates: 'first_confirmed_current_absence', season: 'clock_change' },
  };
}

const reportCaches=new WeakMap();let reportGeneration=0;
async function providerHistoryForReport(db,options){
  if(!options.userId||!options.locationIds?.length)return null;
  const {Op}=require('sequelize'),H=require('./businessProfileHistoryScope.service');
  const rows=await db.ClinicBusinessLocation.findAll({where:{id:{[Op.in]:options.locationIds},is_active:true},raw:true});
  const projections=[],clinicIds=[...new Set(options.clinicIds.map(Number))],candidates=new Map(),locationOwners={};
  const clinicMappings=async clinicId=>{
    if(typeof options.resolveEffectiveMappingIdsForClinic==='function')return options.resolveEffectiveMappingIdsForClinic(clinicId);
    if(clinicIds.length===1&&typeof options.resolveEffectiveMappingIds==='function')return options.resolveEffectiveMappingIds();
    throw Object.assign(Error('scope_denied'),{code:'scope_denied',status:403,httpStatus:403});
  };
  for(const row of rows){
    let clinicId=clinicIds.includes(Number(row.clinica_id))?Number(row.clinica_id):null;
    if(clinicId==null)for(const candidate of clinicIds){
      if(!candidates.has(candidate))candidates.set(candidate,await clinicMappings(candidate));
      if(candidates.get(candidate).includes(Number(row.id))){clinicId=candidate;break;}
    }
    if(clinicId==null)throw Object.assign(Error('scope_denied'),{code:'scope_denied',status:403,httpStatus:403});
    const projection=await H.createHistoryProjection({models:db,clinicId:Number(clinicId),userId:Number(options.userId),locations:[row],resolveEffectiveMappingIds:()=>clinicMappings(clinicId)});
    projections.push(projection);
    const owners=(options.locationOwners?.[row.id]||[]).map(Number).filter(id=>clinicIds.includes(id));
    for(const id of projection.mappingIds)locationOwners[id]=owners.length?owners:[clinicId];
  }
  if(!projections.some(p=>p.lineages.some(l=>l.generationId)))return null;
  return {mappingIds:[...new Set(projections.flatMap(p=>p.mappingIds))],lineages:projections.flatMap(p=>p.lineages),locationOwners,fingerprint:projections.map(p=>p.fingerprint),assert:async()=>{for(const p of projections)await p.assert();}};
}
async function readReport(db,options={}) {
  const providerHistory=await providerHistoryForReport(db,options);
  const identity=db.sequelize||db;
  let entry=reportCaches.get(identity);
  if(!entry){entry={generation:reportGeneration,cache:require('../lib/report-read-cache').createReportReadCache()};reportCaches.set(identity,entry);}
  if(entry.generation!==reportGeneration){entry.cache.clear();entry.generation=reportGeneration;}
  const range=reportRange(options.period||'30d',options.now||new Date());
  const key=JSON.stringify([[...(options.clinicIds||[])].sort((a,b)=>a-b),[...(options.locationIds||[])].sort((a,b)=>a-b),Object.entries(options.clinicNames||{}).sort((a,b)=>Number(a[0])-Number(b[0])),Object.entries(options.locationOwners||{}).sort((a,b)=>Number(a[0])-Number(b[0])).map(([id,owners])=>[id,[...owners].map(Number).sort((a,b)=>a-b)]),range.from,range.to,...(providerHistory?[providerHistory.fingerprint]:[])]);
  const result=await entry.cache.read(key,async()=>{const value=await readUncachedReport(db,{...options,providerHistory});await providerHistory?.assert();return value;});
  await providerHistory?.assert();
  return {...result.value,generated_at:result.generated_at,aggregate_cache:{status:result.status}};
}
function invalidate(){reportGeneration++;}

async function readUncachedReport(db, { clinicIds = [], locationIds = [], clinicNames = {}, locationOwners = {}, period = '30d', now = new Date(),providerHistory=null } = {}) {
  const range = reportRange(period, now);
  clinicIds = [...new Set(clinicIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  locationIds = [...new Set(locationIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  if (!clinicIds.length) return { ...aggregateReport([], range), score_trends: [] };
  const previous = previousReportRange(range);
  const replacements = { clinicIds, locationIds,providerLocationIds:providerHistory?.mappingIds||locationIds, start: previous.start, split: range.start, end: range.end };
  const options = { replacements, type: db.Sequelize.QueryTypes.SELECT };
  const testExclusion = `NOT EXISTS (SELECT 1 FROM MarketingPatientContactEvents t
    WHERE t.list_id=i.list_id AND t.item_id=i.id AND t.event_type IN ('mass_campaign_test_sent','mass_campaign_test_failed'))`;
  // Let each branch start from its selective events/list predicate. Materializing
  // all scoped item IDs first scanned the entire recipient inventory twice.
  const requestsCte = `WITH requests AS (
    SELECT i.id,i.list_id,i.sent_at,i.paciente_id,i.phone,COALESCE(i.clinica_id,l.clinica_id) scoped_clinic_id
    FROM MarketingPatientLists l JOIN MarketingPatientListItems i ON i.list_id=l.id
    WHERE (i.clinica_id IN (:clinicIds) OR (i.clinica_id IS NULL AND l.clinica_id IN (:clinicIds)))
      AND l.objective_id='mass_sends'
      AND (JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.review_request')) IN ('true','1')
        OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria,'$.template_usage'))='solicitud_resena') AND ${testExclusion}
  )`;
  const requestRowsPromise = db.sequelize.query(`${requestsCte}
    SELECT 'requests_sent' metric,DATE_FORMAT(sent_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) total,scoped_clinic_id clinic_id FROM requests
      WHERE sent_at >= :start AND sent_at < :end GROUP BY at_utc,scoped_clinic_id
    UNION ALL
    SELECT 'google_links_sent',DATE_FORMAT(e.occurred_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(DISTINCT e.id),i.scoped_clinic_id
      FROM MarketingPatientContactEvents e JOIN requests i ON i.id=e.item_id AND i.list_id=e.list_id
      WHERE e.event_type='review_rating_followup_sent' AND e.occurred_at >= :start AND e.occurred_at < :end
        AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.kind'))='review_google_link_followup'
        AND JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.status'))='sent'
      GROUP BY at_utc,i.scoped_clinic_id
    UNION ALL
    SELECT 'responses',DATE_FORMAT(e.occurred_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*),e.scoped_clinic_id FROM (
      SELECT e.occurred_at,i.scoped_clinic_id,ROW_NUMBER() OVER (PARTITION BY e.list_id,e.item_id,e.occurred_at >= :split ORDER BY e.occurred_at DESC,e.id DESC) reply_rank
      FROM MarketingPatientContactEvents e JOIN requests i ON i.id=e.item_id AND i.list_id=e.list_id
      WHERE e.event_type IN ('review_rating_received','review_request_rating') AND e.occurred_at >= :start AND e.occurred_at < :end
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.rating')) AS UNSIGNED) BETWEEN 1 AND 5
    ) e WHERE reply_rank=1 GROUP BY at_utc,e.scoped_clinic_id`, options);

  const periodRowsPromise = db.sequelize.query(`${requestsCte}
    SELECT 'ratings' metric,DATE_FORMAT(occurred_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) total FROM (
      SELECT e.occurred_at,ROW_NUMBER() OVER (PARTITION BY i.scoped_clinic_id,
        COALESCE(CONCAT('p:',i.paciente_id),CONCAT('ph:',i.phone),CONCAT('i:',i.id)),e.occurred_at>= :split
        ORDER BY e.occurred_at DESC,e.id DESC) rn
      FROM MarketingPatientContactEvents e JOIN requests i ON i.id=e.item_id AND i.list_id=e.list_id
      WHERE e.event_type IN ('review_rating_received','review_request_rating')
        AND e.occurred_at>= :start AND e.occurred_at< :end
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload,'$.rating')) AS UNSIGNED) BETWEEN 1 AND 5
    ) ratings WHERE rn=1 GROUP BY at_utc
    UNION ALL SELECT 'converted_requests',DATE_FORMAT(i.sent_at,'%Y-%m-%dT%H:00:00Z'),COUNT(*) FROM requests i
      WHERE i.sent_at >= :start AND i.sent_at < :end AND EXISTS (
        SELECT 1 FROM MarketingPatientContactEvents m WHERE m.list_id=i.list_id AND m.item_id=i.id
          AND m.event_type='google_review_matched'
          AND JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.review_name')) IS NOT NULL
          AND JSON_UNQUOTE(JSON_EXTRACT(m.payload,'$.review_name')) NOT IN ('','null'))
      GROUP BY DATE_FORMAT(i.sent_at,'%Y-%m-%dT%H:00:00Z')
    UNION ALL SELECT 'opt_outs',DATE_FORMAT(opted_out_at,'%Y-%m-%dT%H:00:00Z'),COUNT(*)
      FROM MarketingContactOptOuts WHERE clinica_id IN (:clinicIds) AND channel='whatsapp'
        AND opted_out_at>= :start AND opted_out_at< :end GROUP BY DATE_FORMAT(opted_out_at,'%Y-%m-%dT%H:00:00Z')`, options);

  const locationScope = locationIds.length ? 'r.business_location_id IN (:providerLocationIds)' : 'r.clinica_id IN (:clinicIds)';
  const matchScope = locationIds.length ? 'm.location_id IN (:locationIds)' : 'm.clinic_id IN (:clinicIds)';
  const ownershipCases = Object.entries({...locationOwners,...(providerHistory?.locationOwners||{})}).filter(([id, owners]) => Number.isSafeInteger(Number(id)) && Number(id)>0)
    .map(([id, owners]) => `WHEN ${Number(id)} THEN ${owners.length === 1 && clinicIds.includes(Number(owners[0])) ? Number(owners[0]) : 0}`).join(' ');
  const ownerExpression = ownershipCases ? `CASE r.business_location_id ${ownershipCases} ELSE r.clinica_id END` : 'r.clinica_id';
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
    SELECT r.id,r.business_location_id,r.clinica_id,r.review_name,r.create_time,r.first_seen_at,r.created_at,r.google_missing_at,
      ROW_NUMBER() OVER (PARTITION BY business_location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
      ORDER BY google_missing_at IS NULL DESC,last_seen_at DESC,id DESC) rank_id FROM BusinessProfileReviews r WHERE ${locationScope}
  ), inventory AS (
    SELECT COALESCE(r.create_time,r.first_seen_at,r.created_at) published_at,r.google_missing_at missing_at,
      IF(m.id IS NULL,0,1) attributed,IF(r.create_time IS NULL,1,0) observation_date,0 missing_without_date,${ownerExpression} clinic_id,m.clinic_id attributed_clinic_id
    FROM ranked_reviews r LEFT JOIN ranked_matches m ON m.rank_id=1 AND m.location_id=r.business_location_id
      AND BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)
    WHERE r.rank_id=1
    UNION ALL
    SELECT m.occurred_at,NULL,1,0,1,m.clinic_id,m.clinic_id FROM ranked_matches m WHERE m.rank_id=1 AND ${matchScope}
      AND NOT EXISTS (SELECT 1 FROM BusinessProfileReviews r WHERE r.business_location_id=m.location_id
        AND BINARY SUBSTRING_INDEX(r.review_name,'/reviews/',-1)=BINARY SUBSTRING_INDEX(m.review_name,'/reviews/',-1))
  )`;
  const reviewRowsPromise = db.sequelize.query(`${inventoryCte}
    SELECT 'google_reviews_total' metric,DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*) total,clinic_id FROM inventory
      WHERE published_at >= :start AND published_at < :end GROUP BY at_utc,clinic_id
    UNION ALL SELECT 'google_reviews_attributed',DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*),attributed_clinic_id FROM inventory
      WHERE attributed=1 AND published_at >= :start AND published_at < :end GROUP BY at_utc,attributed_clinic_id
    UNION ALL SELECT 'google_reviews_unattributed',DATE_FORMAT(published_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*),clinic_id FROM inventory
      WHERE attributed=0 AND published_at >= :start AND published_at < :end GROUP BY at_utc,clinic_id
    UNION ALL SELECT 'google_reviews_missing',DATE_FORMAT(missing_at,'%Y-%m-%dT%H:00:00Z') at_utc,COUNT(*),clinic_id FROM inventory
      WHERE missing_at >= :start AND missing_at < :end GROUP BY at_utc,clinic_id`, options);
  const qualityPromise = db.sequelize.query(`${inventoryCte} SELECT COALESCE(SUM(missing_at IS NOT NULL OR missing_without_date=1),0) missing_total,
    COALESCE(SUM(missing_without_date),0) missing_without_date,
    COALESCE(SUM(observation_date=1 AND published_at >= :split AND published_at < :end),0) reviews_with_observation_date FROM inventory`, options);
  const scoreTrendsPromise = require('./reviewScoreTrend.service').readScoreTrends(db, { locationIds, range, previous,historyProjection:providerHistory });
  const [requestRows,reviewRows,[quality],periodRows,scoreTrends]=await Promise.all([
    requestRowsPromise,reviewRowsPromise,qualityPromise,periodRowsPromise,scoreTrendsPromise]);
  const rows = [...requestRows, ...reviewRows, ...periodRows];
  return { ...aggregateReport(rows, range, { ...quality, clinicNames }), comparison: compareReviewPeriods(rows, range), score_trends: scoreTrends };
}

module.exports = { invalidate, readReport, reportRange, previousReportRange, compareReviewPeriods, aggregateReport, METRICS, PERIODS };
