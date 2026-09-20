'use strict';
exports.snapshot = (month = '2026-09', extras = {}) => ({
  version: 1, source: 'google_cloud_billing_report', projectId: 'clinicaclick', month,
  collectedAt: '2026-09-20T11:00:00Z', currency: 'EUR', precision: 'report_cents', invoice: false,
  period: { from: month + '-01', toExclusive: month + '-20' },
  gross: '1.53', credits: '-1.53', net: '0',
  services: [{ service: 'Translate', gross: '1.53', credits: '-1.53', net: '0' }], ...extras,
});
