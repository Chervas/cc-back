'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const report = require('../../services/reviewActivityReport.service');

for (const period of report.PERIODS) test('bounded Madrid calendar range: ' + period, () => {
  const range = report.reportRange(period, new Date('2026-10-15T22:30:00Z'));
  assert.equal(range.to, '2026-10-16');
  assert.equal(range.end.toISOString(), '2026-10-16T22:00:00.000Z');
  const result = report.aggregateReport([], range);
  assert.equal(result.series.length, 6);
  assert(result.series[0].data.length >= 2 && result.series[0].data.length <= 366);
  assert(Object.values(result.totals).every(value => value === 0));
});
test('invalid period rejects rather than expanding the query', () => {
  for (const value of ['', 'all', '1 OR 1=1', ['7d']]) assert.throws(() => report.reportRange(value), { status: 400 });
});
test('local midnight, empty days, missing-date qualification and totals stay server-side', () => {
  const result = report.aggregateReport([
    { metric: 'requests_sent', at_utc: '2026-10-14T22:00:00Z', total: 2 },
    { metric: 'requests_sent', at_utc: '2026-10-15T21:00:00Z', total: 3 },
    { metric: 'google_reviews_total', at_utc: '2026-10-15T22:00:00Z', total: 1 },
    { metric: 'google_reviews_missing', at_utc: null, total: 4 },
    { metric: 'requests_sent', at_utc: 'bad', total: 5 },
    { metric: 'requests_sent', at_utc: '2026-10-16T12:00:00Z', total: -1 },
    { metric: 'requests_sent', at_utc: '2026-09-01T12:00:00Z', total: 100 },
  ], report.reportRange('2d', new Date('2026-10-16T12:00:00Z')), { missing_without_date: 4 });
  assert.deepEqual(result.series[0].data, [{ x: '2026-10-15', y: 5 }, { x: '2026-10-16', y: 0 }]);
  assert.equal(result.quality.missing_without_date, 4);
  assert.equal(result.totals.google_reviews_missing, 0);
  for (const series of result.series) assert.equal(series.data.reduce((sum, point) => sum + point.y, 0), result.totals[series.key]);
  assert.equal(result.heatmaps.google_reviews.all.series[4].data[0].y, 1);
});
for (const [date, expectedHours] of [['2026-03-29', [1, 3]], ['2026-10-25', [2, 2]]]) test('DST boundary ' + date, () => {
  const result = report.aggregateReport([0, 1].flatMap(hour => ['google_reviews_total', 'responses'].map(metric => ({
    metric, at_utc: `${date}T0${hour}:00:00Z`, total: 1,
  }))), report.reportRange('2d', new Date(date + 'T12:00:00Z')));
  for (const source of ['google_reviews', 'responses']) {
    const maps = result.heatmaps[source];
    assert.equal(maps.all.total, 2); assert.equal(maps.winter.total, 1); assert.equal(maps.summer.total, 1);
    for (const hour of new Set(expectedHours)) assert.equal(maps.all.series[6].data[hour].y, expectedHours.filter(value => value === hour).length);
  }
});
test('empty scope never touches SQL or a provider', async () => {
  const result = await report.readReport({}, { clinicIds: [], locationIds: [11] });
  assert.equal(result.totals.requests_sent, 0);
});
