'use strict';
const { catalogError } = require('./treatment-catalog-contract');
const { saleMode, assertStandalone } = require('./treatment-commercial-policy');
const { normalizeProfile } = require('./economicPriceProfile');
const object = value => {
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw catalogError('La composición económica guardada no es válida.', 'budget_program_snapshot_invalid', 422); }
};
// Only server-resolved lines enter here. A preserved line is still a NEW offer
// when it is edited/cloned/presented; an accepted purchase/debt is not repriced.
async function assertCommercialLines(lines, { resolveTreatments, selling = true, historicalPurchase = false } = {}) {
  if (historicalPurchase) return;
  if (!Array.isArray(lines) || lines.length > 500) throw catalogError('El presupuesto admite un máximo de 500 conceptos.', 'budget_lines_limit', 422);
  const ids = new Set();
  for (const line of lines) {
    if (line.program_id) {
      for (const appointment of object(line.program_snapshot)?.appointments || []) for (const id of appointment.treatment_ids || []) ids.add(Number(id));
    } else if (line.treatment_id != null || line.catalogoId != null) ids.add(Number(line.treatment_id ?? line.catalogoId));
  }
  if ([...ids].some(id => !Number.isSafeInteger(id) || id <= 0)) throw catalogError('Referencia de tratamiento no válida.', 'budget_treatment_unavailable', 422);
  const treatments = ids.size ? await resolveTreatments([...ids]) : new Map();
  for (const id of ids) if (!treatments.has(id)) throw catalogError('Un tratamiento no está disponible en el ámbito de este presupuesto.', 'budget_treatment_unavailable', 422);
  for (const line of lines) {
    if (!line.program_id) {
      const treatment = treatments.get(Number(line.treatment_id ?? line.catalogoId));
      if (treatment) assertStandalone(treatment);
      continue;
    }
    const snapshot = object(line.program_snapshot);
    if ((snapshot?.appointments || []).some(appointment => (appointment.treatment_ids || []).some(id => saleMode(treatments.get(Number(id))) === 'historical_reference')
      || (appointment.treatments || []).some(treatment => treatment.sale_mode === 'historical_reference'))) throw catalogError('Una referencia histórica no puede incorporarse a una oferta comercial nueva.', 'treatment_historical_reference', 422);
    if (!selling) continue;
    const included = (snapshot?.appointments || []).some(appointment => (appointment.treatment_ids || []).some(id => saleMode(treatments.get(Number(id))) === 'program_component_only')
      || (appointment.treatments || []).some(treatment => treatment.sale_mode === 'program_component_only'));
    if (included && (snapshot?.price_profile_source !== 'program' || !normalizeProfile(snapshot.price_profile))) {
      throw catalogError('Define y guarda la fiscalidad del precio total del programa antes de ofrecerlo, firmarlo o aceptarlo.', 'program_price_profile_required', 422);
    }
  }
}
module.exports = { assertCommercialLines };
