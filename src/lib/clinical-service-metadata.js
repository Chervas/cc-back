'use strict';

const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
};
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
function voucherBudgetLine(voucher, lines = []) {
  return voucher.budget_line_key ? lines.find(line => line.key === voucher.budget_line_key) : null;
}
/** Only explicit treatment references from the scoped stored purchase. */
function voucherTreatmentIds(voucher, lines = []) {
  const line = voucherBudgetLine(voucher, lines);
  const snapshot = object(voucher.program_snapshot) || object(line?.program_snapshot);
  const ids = [voucher.treatment_id, line?.treatment_id,
    ...(Array.isArray(snapshot?.appointments) ? snapshot.appointments.flatMap(appointment =>
      Array.isArray(appointment?.treatment_ids) ? appointment.treatment_ids : []) : [])];
  return [...new Set(ids.filter(positive).map(Number))];
}
function voucherMedicalAreas(voucher, lines = [], areasByTreatment = new Map()) {
  const line = voucherBudgetLine(voucher, lines);
  // A program's commercial line commonly carries the generic default; its
  // component treatments provide the actual medical disciplines instead.
  const explicit = typeof line?.area_code === 'string' && line.area_code.trim() && line.area_code !== 'general'
    ? [line.area_code] : [];
  return [...new Set(explicit.length ? explicit : voucherTreatmentIds(voucher, lines)
    .flatMap(id => areasByTreatment.get(id) || []))];
}
module.exports = { voucherTreatmentIds, voucherMedicalAreas };
