'use strict';

// This compares the reviews published in two windows, not historical snapshots
// of Google's overall score. Edited/deleted reviews follow the current inventory.
function projectScoreTrends(rows, locationIds) {
  return [...new Set(locationIds)].map(locationId => {
    const row = rows.find(r => Number(r.business_location_id) === locationId) || {};
    const currentCount = Number(row.current_count) || 0, previousCount = Number(row.previous_count) || 0;
    const current = currentCount ? Number(row.current_sum) / currentCount : null;
    const previous = previousCount ? Number(row.previous_sum) / previousCount : null;
    return { business_location_id: locationId, current, previous, current_count: currentCount, previous_count: previousCount,
      change_points: current == null || previous == null ? null : Math.round((current - previous) * 100) / 100 };
  });
}

async function readScoreTrends(db, { locationIds = [], range, previous }) {
  const ids = [...new Set(locationIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return [];
  const rows = await db.sequelize.query(`WITH ranked AS (
    SELECT business_location_id,star_rating,create_time,google_missing_at,
      ROW_NUMBER() OVER (PARTITION BY business_location_id,BINARY SUBSTRING_INDEX(review_name,'/reviews/',-1)
        ORDER BY google_missing_at IS NULL DESC,last_seen_at DESC,id DESC) review_rank
    FROM BusinessProfileReviews WHERE business_location_id IN (:locationIds)
  ) SELECT business_location_id,
    SUM(create_time >= :split) current_count,SUM(IF(create_time >= :split,star_rating,0)) current_sum,
    SUM(create_time < :split) previous_count,SUM(IF(create_time < :split,star_rating,0)) previous_sum
    FROM ranked WHERE review_rank=1 AND google_missing_at IS NULL AND star_rating BETWEEN 1 AND 5
      AND create_time >= :start AND create_time < :end GROUP BY business_location_id`, {
    replacements: { locationIds: ids, start: previous.start, split: range.start, end: range.end }, type: db.Sequelize.QueryTypes.SELECT,
  });
  return projectScoreTrends(rows, ids);
}

module.exports = { readScoreTrends, projectScoreTrends };
