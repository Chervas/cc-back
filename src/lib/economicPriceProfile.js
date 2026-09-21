'use strict';

// Explicit prices only. Legacy catalog amounts are deliberately unclassified:
// neither the clinic specialty nor a missing tax rate proves an exemption.
const SEMANTICS = 'gross_tax_included';
const copy = value => JSON.parse(JSON.stringify(value));
function invalid(code, message) { return Object.assign(new Error(message), { status: 422, statusCode: 422, code }); }
function normalizeProfile(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || raw.schema_version !== 1 || raw.price_semantics !== SEMANTICS) {
    throw invalid('price_profile_invalid', 'Indica si el precio final incluye impuestos y completa su desglose.');
  }
  const rate = raw.tax_percent;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100 || Math.round(rate * 100) / 100 !== rate) {
    throw invalid('price_profile_tax_invalid', 'El porcentaje de IVA debe ser un número entre 0 y 100, con un máximo de dos decimales.');
  }
  const reason = typeof raw.exemption_reason === 'string' ? raw.exemption_reason.trim() : '';
  if ((raw.exemption_reason != null && typeof raw.exemption_reason !== 'string') || reason.length > 500 || (rate === 0 && !reason) || (rate > 0 && reason)) {
    throw invalid('price_profile_exemption_invalid', 'Los conceptos exentos necesitan un motivo. No añadas una exención a un concepto con IVA.');
  }
  return { schema_version: 1, price_semantics: SEMANTICS, tax_percent: rate, exemption_reason: reason || null };
}
function profileFromTreatment(treatment) {
  let config = treatment?.clinical_config || {};
  if (typeof config === 'string') { try { config = JSON.parse(config); } catch { throw invalid('price_profile_invalid', 'La configuración del tratamiento no es válida.'); } }
  return normalizeProfile(config.price_profile);
}
function commonProfile(profiles) {
  if (!profiles.length || profiles.some(profile => !profile)) return null;
  const normalized = profiles.map(normalizeProfile);
  return normalized.every(profile => JSON.stringify(profile) === JSON.stringify(normalized[0])) ? normalized[0] : null;
}
function reference(line) {
  if (line.program_id) return { kind: 'program', id: String(line.program_id), version: Number(line.program_version) };
  const id = Number(line.treatment_id ?? line.catalogoId);
  return Number.isSafeInteger(id) && id > 0 ? { kind: 'treatment', id } : null;
}
// MySQL JSON reorders object keys. Identity must not depend on that order.
function sameReference(a, b) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id
    && (a.kind === 'treatment' || (a.kind === 'program' && a.version === b.version));
}
function normalizeSnapshot(snapshot, expectedReference) {
  if (!snapshot || snapshot.schema_version !== 1 || !sameReference(snapshot.source, expectedReference)) {
    throw invalid('budget_price_snapshot_invalid', 'La configuración fiscal guardada no corresponde a este concepto.');
  }
  const profile = normalizeProfile(snapshot.profile);
  if (!profile) throw invalid('budget_price_snapshot_invalid', 'Falta la configuración fiscal guardada del concepto.');
  return { schema_version: 1, source: copy(expectedReference), profile };
}

// Must run AFTER program resolution: program_snapshot here is the server's
// resolved/frozen composition, never raw request JSON. Treatment resolution is
// one bounded, clinic-scoped bulk read, not an N+1 lookup per budget line.
async function resolveBudgetPriceProfiles(lines, { previousLines = [], resolveTreatments }) {
  if (!Array.isArray(lines) || lines.length > 500) throw invalid('budget_lines_limit', 'El presupuesto admite un máximo de 500 conceptos.');
  const previous = new Map(previousLines.map(line => [line.key, line]));
  const keys = new Set();
  const pending = lines.map(raw => {
    const line = { ...raw };
    for (const key of ['price_snapshot', 'price_profile', 'price_semantics', 'tax_percent', 'vat_percent', 'exemption_reason', 'tax_amount', 'taxable_base']) delete line[key];
    const key = String(raw.key || raw.id || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (key && keys.has(key)) throw invalid('budget_duplicate_line_key', 'Cada concepto necesita una clave diferente.');
    if (key) keys.add(key);
    const source = reference(line), prior = previous.get(key);
    // An existing unclassified line stays unclassified too. Editing a note or
    // discount must not apply today's catalog tax policy to a previous offer.
    const preserved = prior && sameReference(source, reference(prior));
    if (preserved && prior.price_snapshot) line.price_snapshot = normalizeSnapshot(prior.price_snapshot, source);
    return { line, source, preserved };
  });
  const ids = [...new Set(pending.filter(row => !row.preserved && row.source?.kind === 'treatment').map(row => row.source.id))];
  const treatments = ids.length ? await resolveTreatments(ids) : new Map();
  for (const row of pending) {
    if (row.preserved || !row.source) continue;
    let profile;
    if (row.source.kind === 'program') {
      profile = normalizeProfile(row.line.program_snapshot?.price_profile);
    } else {
      const treatment = treatments.get(row.source.id);
      if (!treatment) throw invalid('budget_treatment_unavailable', 'Un tratamiento seleccionado ya no está disponible en esta clínica. Vuelve a seleccionarlo.');
      let config = treatment.clinical_config || {};
      if (typeof config === 'string') config = JSON.parse(config);
      if (config.fiscal_mapping_pending === true) throw invalid('imported_treatment_fiscal_review_pending', 'Completa la revisión del precio importado antes de presupuestar este tratamiento.');
      profile = profileFromTreatment(treatment);
    }
    if (profile) row.line.price_snapshot = { schema_version: 1, source: row.source, profile };
  }
  return pending.map(row => row.line);
}
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw invalid('price_amount_invalid', 'El importe debe ser un número positivo.');
  const amount = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(amount) || amount > 1e12) throw invalid('price_amount_invalid', 'El importe supera el máximo permitido.');
  return amount;
}
function breakdown(gross, rawProfile) {
  const profile = normalizeProfile(rawProfile);
  if (!profile) throw invalid('price_profile_required', 'Falta indicar el desglose fiscal.');
  const total = cents(gross), base = Math.round(total * 100 / (100 + profile.tax_percent));
  return { price_semantics: SEMANTICS, tax_percent: profile.tax_percent, exemption_reason: profile.exemption_reason,
    taxable_base: base / 100, tax_amount: (total - base) / 100, total: total / 100 };
}
function budgetBreakdown(lines, finalTotal) {
  const amounts = lines.map(line => cents(line.total));
  const subtotal = amounts.reduce((sum, amount) => sum + amount, 0), target = cents(finalTotal);
  if (!Number.isSafeInteger(subtotal) || subtotal > 1e12) throw invalid('price_amount_invalid', 'El importe supera el máximo permitido.');
  if (target > subtotal) throw invalid('budget_tax_total_invalid', 'El total del presupuesto no coincide con sus conceptos.');
  // Allocate the actual rounded global discount, including residual cents,
  // before splitting VAT. Independent rounded percentages lose cents.
  const exact = amounts.map(amount => subtotal ? amount / subtotal * target : 0);
  const allocated = exact.map(Math.floor);
  const order = exact.map((amount, index) => ({ index, remainder: amount - allocated[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let remaining = target - allocated.reduce((sum, amount) => sum + amount, 0);
  for (const row of order) { if (remaining <= 0) break; allocated[row.index]++; remaining--; }
  let known = 0;
  const result = lines.map((line, index) => {
    if (!line.price_snapshot) return { key: line.key, profile_status: 'unclassified', gross_after_global_discount: allocated[index] / 100,
      taxable_base: null, tax_amount: null };
    const snapshot = normalizeSnapshot(line.price_snapshot, reference(line));
    known++;
    return { key: line.key, profile_status: 'configured', gross_after_global_discount: allocated[index] / 100,
      ...breakdown(allocated[index] / 100, snapshot.profile) };
  });
  const taxCents = result.reduce((sum, line) => sum + (line.tax_amount == null ? 0 : cents(line.tax_amount)), 0);
  return { tax_base: (target - taxCents) / 100, taxes: taxCents / 100, total: target / 100,
    tax_breakdown_status: known === lines.length && known ? 'complete' : known ? 'partial' : 'unclassified', lines: result };
}
module.exports = { SEMANTICS, normalizeProfile, profileFromTreatment, commonProfile, normalizeSnapshot,
  resolveBudgetPriceProfiles, breakdown, budgetBreakdown };
