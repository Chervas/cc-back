'use strict';

const calendar = require('../lib/availability-calendar');
const METRIC = 'GOOGLE_REVIEW_RATING';
const SUBTYPE = 'global_v1';
const SCALE = 1000000;

// Persist Google's overall score as observed, never reconstruct history from
// reviews whose stars/deletion state may have changed after publication.
function providerScoreSnapshot(location, payload, observedAt = new Date()) {
  const rating = payload?.averageRating, count = payload?.totalReviewCount;
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 5
    || !Number.isSafeInteger(count) || count < 1 || !Number.isFinite(+observedAt)
    || !Number.isSafeInteger(Number(location?.id)) || Number(location.id) < 1
    || !Number.isSafeInteger(Number(location?.clinica_id)) || Number(location.clinica_id) < 1) return null;
  return { clinica_id: Number(location.clinica_id), business_location_id: Number(location.id),
    metric_type: METRIC, metric_subtype: SUBTYPE,
    date: calendar.formatDateLocal(observedAt, 'Europe/Madrid'), value: Math.round(rating * SCALE) };
}

function projectScoreTrends(rows, locationIds, { range, previous }) {
  const date = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  const score = row => row && Number(row.value) >= SCALE && Number(row.value) <= 5 * SCALE ? Number(row.value) / SCALE : null;
  return [...new Set(locationIds)].map(locationId => {
    const candidates = rows.filter(r => Number(r.business_location_id) === locationId)
      .sort((a, b) => date(b.date).localeCompare(date(a.date)));
    // Missing/stale observations are unknown. Allow a two-day sync delay and
    // expose actual observation dates; stable compares the displayed tenth.
    const at = end => candidates.find(r => date(r.date) <= end
      && (Date.parse(end) - Date.parse(date(r.date))) <= 2 * 86400000 && score(r) != null);
    const currentCandidate = at(range.to), previousRow = at(previous.to);
    const currentRow = currentCandidate && date(currentCandidate.date) >= range.from ? currentCandidate : null;
    const current = score(currentRow), before = score(previousRow);
    const change = current == null || before == null ? null : Math.round(current * 10) - Math.round(before * 10);
    return { business_location_id: locationId, basis: 'google_global_rating', current, previous: before,
      current_observed_on: currentRow ? date(currentRow.date) : null,
      previous_observed_on: previousRow ? date(previousRow.date) : null,
      direction: change == null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'stable' };
  });
}

async function readScoreTrends(db, { locationIds = [], range, previous,historyProjection=null }) {
  const ids = [...new Set(locationIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return [];
  const oldest = new Date(previous.to + 'T12:00:00Z'); oldest.setUTCDate(oldest.getUTCDate() - 2);
  const rows = await db.sequelize.query(`SELECT business_location_id,date,value FROM BusinessProfileDailyMetrics
    WHERE business_location_id IN (:locationIds) AND metric_type=:metric AND metric_subtype=:subtype
      AND date >= :start AND date <= :end`, {
    replacements: { locationIds:historyProjection?.mappingIds||ids, metric: METRIC, subtype: SUBTYPE, start: oldest.toISOString().slice(0, 10), end: range.to },
    type: db.Sequelize.QueryTypes.SELECT,
  });
  const projected=require('./businessProfileHistoryScope.service').deduplicateMetrics(rows.map(r=>({...r,metric_type:METRIC,metric_subtype:SUBTYPE})),historyProjection);
  return projectScoreTrends(projected, ids, { range, previous });
}

module.exports = { readScoreTrends, projectScoreTrends, providerScoreSnapshot };
