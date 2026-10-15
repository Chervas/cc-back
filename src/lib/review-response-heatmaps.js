'use strict';

function buildReviewResponseHeatmaps(rows = []) {
  const empty = label => ({ label, total: 0, series: ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(name => ({
    name, data: Array.from({ length: 24 }, (_, hour) => ({ x: `${String(hour).padStart(2, '0')}:00`, y: 0 })),
  })) });
  const maps = { all: empty('Todo el año'), winter: empty('Invierno'), summer: empty('Verano') };
  for (const row of rows || []) {
    const day = Number(row.weekday), hour = Number(row.hour), count = Number(row.total);
    if (!Number.isInteger(day) || day < 0 || day > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23
      || !Number.isFinite(count) || count < 0) continue;
    for (const key of ['all', ...(['winter', 'summer'].includes(row.season) ? [row.season] : [])]) {
      maps[key].series[day].data[hour].y += count;
      maps[key].total += count;
    }
  }
  return maps;
}

module.exports = { buildReviewResponseHeatmaps };
