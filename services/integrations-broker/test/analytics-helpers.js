'use strict';
// Fictitious provider wire response, including independent expected headers.
const families = { daily: null, channel: 'sessionDefaultChannelGroup', source_medium: 'sessionSourceMedium', device: 'deviceCategory',
  country: 'country', city: 'city', language: 'language', gender: 'userGender', age: 'userAgeBracket' };
function analyticsReport(family, { offset = 0, count = 1, total = count, start = '2026-09-01' } = {}) {
  const dimensionHeaders = [{ name: 'date' }, ...(families[family] ? [{ name: families[family] }] : [])];
  return { dimensionHeaders, metricHeaders: [
    { name: 'sessions', type: 'TYPE_INTEGER' }, { name: 'activeUsers', type: 'TYPE_INTEGER' }, { name: 'newUsers', type: 'TYPE_INTEGER' },
    { name: 'keyEvents', type: 'TYPE_FLOAT' }, { name: 'totalRevenue', type: 'TYPE_CURRENCY' }], rowCount: total,
    rows: Array.from({ length: count }, (_, i) => ({ dimensionValues: [{ value: start.replaceAll('-', '') },
      ...(families[family] ? [{ value: 'FICTITIOUS_DIMENSION_' + (offset + i) }] : [])],
      metricValues: ['3', '2', '1', '1.5', '-12.50'].map(value => ({ value })) })),
    metadata: { currencyCode: 'EUR', timeZone: 'Europe/Madrid', dataLossFromOtherRow: false, subjectToThresholding: false },
  };
}
module.exports = { analyticsReport, families };
