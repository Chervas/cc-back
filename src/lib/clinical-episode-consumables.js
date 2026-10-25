'use strict';
const C = require('./clinical-episode-contract'), S = require('./clinic-supplies-contract');
function command(payload) {
  if (!C.object(payload) || Object.keys(payload).some(key => !['expected_version', 'idempotency_key', 'kind', 'lines', 'reason'].includes(key))) throw C.error(400, 'clinical_consumables_invalid', 'Revisa los consumibles de esta consulta.');
  const expected = S.version(payload.expected_version); S.commandKey(payload.idempotency_key);
  if (!['consume', 'return'].includes(payload.kind) || !Array.isArray(payload.lines) || !payload.lines.length || payload.lines.length > 50) throw C.error(400, 'clinical_consumables_invalid', 'Selecciona entre uno y cincuenta consumibles.');
  const seen = new Set();
  const lines = payload.lines.map(line => {
    if (!C.object(line) || Object.keys(line).some(key => !['product_id', 'quantity', 'expected_product_version'].includes(key))) throw C.error(400, 'clinical_consumables_invalid', 'Revisa las cantidades de consumibles.');
    const id = S.id(line.product_id); if (seen.has(id)) throw C.error(400, 'clinical_consumables_duplicate', 'Selecciona cada producto una sola vez.'); seen.add(id);
    return { product_id: id, units: S.units(line.quantity, false), expected_product_version: S.version(line.expected_product_version) };
  }).sort((a, b) => a.product_id.localeCompare(b.product_id));
  return { expected, kind: payload.kind, lines, reason: S.text(payload.reason || (payload.kind === 'consume' ? 'Consumible utilizado en consulta' : 'Corrección de consumibles de consulta'), 500, true) };
}
function totals(rows) {
  const values = new Map();
  for (const row of rows) {
    const item = values.get(row.product_id) || { product_id: row.product_id, name: row.product_name, unit: row.unit, units: 0 };
    item.units += Math.round(Number(row.quantity) * 1000); values.set(row.product_id, item);
  }
  return [...values.values()].filter(item => item.units > 0).map(({ units, ...item }) => ({ ...item, quantity: S.amount(units) })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
async function snapshots(db, reports, transaction) {
  const result = new Map();
  if (!reports.length || !db.ClinicalEpisodeStockConsumption) return result;
  const { Op, literal } = require('sequelize');
  const rows = await db.ClinicalEpisodeStockConsumption.findAll({ where: { report_id: { [Op.in]: reports.map(row => row.id) } },
    attributes: ['report_id', 'clinic_id', 'patient_id', 'product_id', 'product_name', 'unit', [literal('SUM(`quantity`)'), 'quantity']],
    group: ['report_id', 'clinic_id', 'patient_id', 'product_id', 'product_name', 'unit'], transaction });
  for (const report of reports) result.set(String(report.id), totals(rows.filter(row => String(row.report_id) === String(report.id) && Number(row.clinic_id) === Number(report.clinic_id) && Number(row.patient_id) === Number(report.patient_id))));
  return result;
}
module.exports = { command, totals, snapshots };
