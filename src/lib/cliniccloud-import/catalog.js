'use strict';

const { norm, hash } = require('./adapter');
const CONFIG = {
  'Tratamientos individuales': ['C', 'D', 'G', 'H'],
  'Programas y mantenimientos': ['D', 'E', 'F', 'G'],
  'Capilar · sesiones y bonos': ['C', 'D', 'G', 'H'],
  'Capilar · programas': ['D', 'E', 'F', 'G'],
  'Facial · tratamientos': ['C', 'D', 'G', 'H'],
  'Cirugía plástica · tarifa': ['D', 'E', 'F', 'G'],
  'Obesidad · tarifa': ['C', 'D', 'G', 'H'],
};
function grossPrice(value) {
  const text = String(value || '').trim();
  if (/^GRATUIT[AO]$/i.test(text)) return { mode: 'fixed', gross_amount: 0, includes_tax: true, currency: 'EUR' };
  if (/^INCLUID[AO]$/i.test(text)) return { mode: 'included', gross_amount: null, includes_tax: true, currency: 'EUR' };
  const match = /^(Desde\s+)?(\d+(?:\.\d{3})*(?:,\d{1,2})?|\d+\.\d{1,2})\s*€?$/.exec(text);
  if (!match) return { mode: 'unresolved', gross_amount: null, includes_tax: true, currency: 'EUR', raw: text };
  const decimal = match[2].includes(',') ? match[2].replace(/\./g, '').replace(',', '.') : /\.\d{3}$/.test(match[2]) ? match[2].replace(/\./g, '') : match[2];
  return { mode: match[1] ? 'from' : 'fixed', gross_amount: Number(decimal), includes_tax: true, currency: 'EUR' };
}
function durationInfo(value) {
  const text = String(value || '').trim();
  const simple = /^(\+)?(\d+)\s*min$/i.exec(text);
  if (simple) return { mode: simple[1] ? 'additional' : 'fixed', minutes: Number(simple[2]) };
  const repeated = /^(\d+)\s*[×x]\s*(\d+)\s*min$/i.exec(text);
  if (repeated) return { mode: 'multiple_appointments', count: Number(repeated[1]), minutes: Number(repeated[2]) };
  return { mode: /jornada/i.test(text) ? 'surgical_days' : /\d\s*[-–]\s*\d/.test(text) ? 'range' : 'unresolved', minutes: null, raw: text };
}
function kindOf(row) {
  const category = norm(row.category), name = norm(row.name), detail = norm(row.detail);
  if (category === 'ORTOPEDIA' || category === 'PROTESIS' || category === 'PLUMAS MOUNJARO') return 'product';
  if (category === 'HOSPITALIZACION' || category === 'HONORARIOS' || (category === 'QUIROFANO' && name.startsWith('GASTOS'))) return 'fee';
  if (/\bBONO\s+\d+/.test(name)) return 'voucher';
  if (/programas/i.test(row.sheet) || /PROGRAMA/.test(category) || /PROGRAMA|SEGUIMIENTO.*\d+ SESIONES/.test(name) || /PROGRAMA COMPLETO/.test(detail) || durationInfo(row.duration).mode === 'multiple_appointments') return 'program';
  if (durationInfo(row.duration).mode === 'additional') return 'addon';
  return 'treatment';
}
function staffTokens(value) { return norm(value).replace(/\b(DR|DRA|DOCTOR|DOCTORA|AUX|AUXILIAR|NUTRICION|PSICOLOGIA)\b\.?/g, '').trim().split(/\s+/).filter(Boolean); }
function buildCatalogPlan({ sheets, workbookHash, local = { installations: [], professionals: [], treatments: [] }, resourceMap = {} }) {
  const rows = [];
  for (const sheet of sheets) {
    if (!CONFIG[sheet.name]) continue; // combinations and notes are not catalog rows
    const [duration, price, cabin, professional] = CONFIG[sheet.name];
    let category = '';
    for (const source of sheet.rows) {
      if (source.source_row === 1) continue;
      const c = source.cells;
      category = c.A || category;
      if (!c.B || !c[price]) continue;
      const row = { sheet: sheet.name, source_row: source.source_row, category, name: c.B, detail: duration === 'D' ? c.C || '' : '', duration: c[duration] || '', price: c[price], cabin: c[cabin] || '', professional: c[professional] || '', raw_cells: c };
      row.kind = kindOf(row); row.clinic_id = sheet.name.startsWith('Capilar') ? 66 : 72;
      row.provenance = { file_sha256: workbookHash, sheet: row.sheet, source_row: row.source_row, row_sha256: hash(c) };
      row.source_catalog_key = hash([row.sheet, row.category, row.name]);
      row.proposed_code = `BS26-${row.source_catalog_key.slice(0, 20)}`;
      row.display_name = norm(category) === norm(row.name) ? row.name : `${category} · ${row.name}`;
      row.source_price = grossPrice(row.price); row.duration_info = durationInfo(row.duration);
      row.issues = []; row.warnings = [];
      const notes = `${norm(category)} ${norm(row.name)}`;
      let cabins = [...new Set((row.cabin.match(/\d+/g) || []).map((number) => `C${Number(number)}`))];
      if (/PLEXR/.test(notes)) { cabins = ['C7']; row.warnings.push('USER_CONFIRMED_PLEXR_C7'); }
      if (row.sheet === 'Obesidad · tarifa' && ['GASTRECTOMIA TUBULAR', 'BYPASS GASTRICO'].includes(norm(row.name))) { cabins = ['Hospital']; row.warnings.push('USER_CONFIRMED_EXTERNAL_HOSPITAL'); }
      row.cabin_keys = cabins;
      const surgicalHair = row.sheet === 'Capilar · sesiones y bonos' && /INJERTO/.test(norm(category));
      row.required_professionals = surgicalHair ? ['Dr. Loza', 'Aux. Ainhoa'] : row.professional && !/GARRIDO/.test(norm(row.professional)) ? [row.professional] : [];
      row.professional_mode = surgicalHair ? 'all' : 'any';
      row.professional_resolution = row.required_professionals.map((label) => {
        const tokens = staffTokens(label);
        const candidates = local.professionals.filter((p) => {
          const existingTokens = staffTokens(`${p.name} ${p.surname || ''}`);
          return tokens.length && existingTokens.length && (tokens.every((t) => existingTokens.includes(t)) || existingTokens.every((t) => tokens.includes(t)));
        });
        const mappedId = resourceMap.professionals?.[label];
        const mapped = mappedId ? local.professionals.find((p) => p.id === mappedId && p.clinic_id === row.clinic_id) : null;
        if (mapped && !candidates.includes(mapped)) candidates.push(mapped);
        return { label, confirmed_id: mapped?.id || null, candidates: candidates.map((p) => ({ id: p.id, clinic_id: p.clinic_id, active: Boolean(p.active), receives_appointments: Boolean(p.receives_appointments), subrole: p.subrole })), name_matches_are_not_identity_approval: true, requires_membership: mappedId && !mapped ? true : undefined };
      });
      row.installation_resolution = cabins.map((key) => {
        const mappedId = resourceMap.cabins?.[key];
        const confirmed = local.installations.find((i) => i.id === mappedId);
        const number = /^C(\d+)$/.exec(key)?.[1];
        const candidates = local.installations.filter((i) => key === 'Hospital' ? norm(i.name) === 'HOSPITAL' : new RegExp(`^(CABINA|CONSULTA|BOX) ${number}(?:\\b|$)`).test(norm(i.name)));
        return { key, confirmed_id: confirmed?.id || null, confirmed_clinic_id: confirmed?.clinic_id || null, candidates: candidates.map((i) => ({ id: i.id, clinic_id: i.clinic_id, name: i.name, active: Boolean(i.active) })), warning: 'SAME_NUMBER_DOES_NOT_PROVE_SAME_PHYSICAL_ROOM' };
      });
      const schedulable = ['treatment', 'addon'].includes(row.kind);
      if (schedulable) {
        if (row.duration_info.mode !== 'fixed') row.issues.push('DURATION_REQUIRES_CONFIGURATION');
        if (!cabins.length) row.issues.push('CABIN_NOT_SPECIFIED');
        if (cabins.length > 1) row.issues.push('MULTI_CABIN_PHASE_DISTRIBUTION_REQUIRED');
        if (!row.required_professionals.length) row.issues.push('PROFESSIONAL_NOT_SPECIFIED');
        if (row.installation_resolution.some((r) => !r.confirmed_id)) row.issues.push('PHYSICAL_CABIN_MAP_NOT_CONFIRMED');
        if (row.installation_resolution.some((r) => r.confirmed_id && r.confirmed_clinic_id !== row.clinic_id)) row.issues.push('SHARED_CABIN_RUNTIME_MEMBERSHIP_REQUIRED');
        if (row.professional_resolution.some((r) => !r.confirmed_id)) row.issues.push('PROFESSIONAL_MEMBERSHIP_MAP_NOT_CONFIRMED');
        if (row.professional_resolution.some((r) => r.confirmed_id && !r.candidates.some((p) => p.id === r.confirmed_id && p.clinic_id === row.clinic_id && p.active && p.receives_appointments))) row.issues.push('PROFESSIONAL_NOT_BOOKABLE');
        if (row.installation_resolution.some((r) => r.confirmed_id && !local.installations.find((i) => i.id === r.confirmed_id)?.active)) row.issues.push('INSTALLATION_INACTIVE');
      }
      if (/HILO .*PDO/.test(norm(category))) { row.duration_info = { ...row.duration_info, mode: 'per_unit' }; row.issues.push('QUANTITY_AND_PREPARATION_TIME_REQUIRED'); }
      if (row.required_professionals.some((p) => /^AUX/.test(norm(p))) && /MESOTERAPIA|DUTASTERIDE|CARBOXITERAPIA|HAIR FILLER|VITAMINAS Y AMINOACIDOS|BIOESTIMULACION CORPORAL/.test(notes)) row.issues.push('INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION');
      if (row.kind === 'program') row.issues.push('PROGRAM_APPOINTMENTS_AND_CADENCE_REQUIRED');
      if (row.kind === 'voucher') row.issues.push('VOUCHER_BASE_TREATMENT_LINK_REQUIRED');
      if (row.source_price.mode === 'from') row.issues.push('INDIVIDUAL_QUOTATION_REQUIRED');
      if (row.source_price.mode === 'included') row.warnings.push('INCLUDED_IS_NOT_STANDALONE_FREE');
      if (row.source_price.mode === 'unresolved') row.issues.push('PRICE_REQUIRES_REVIEW');
      if (row.sheet === 'Facial · tratamientos' && row.source_row >= 49 && row.source_row <= 65) row.warnings.push('SOURCE_PRICE_WAS_PROPOSED_USER_ACCEPTED_IMPORT_REVIEW');
      if (row.display_name.length > 255) row.issues.push('DISPLAY_NAME_TOO_LONG');
      row.existing_new_catalog_ids = local.treatments.filter((t) => t.code === row.proposed_code).map((t) => t.id);
      row.legacy_name_candidate_ids = local.treatments.filter((t) => t.clinic_id === row.clinic_id && [norm(row.name), norm(row.display_name)].includes(norm(t.name))).map((t) => t.id);
      row.safe_for_draft_import = row.display_name.length <= 255;
      row.ready_for_booking = schedulable && !row.issues.length;
      row.proposed_clinical_config = { catalog_status: 'draft', source_catalog: row.provenance, source_price: row.source_price, import_issues: row.issues };
      if (row.ready_for_booking) row.proposed_clinical_config.booking_profile = { version: 1, phases: [{ key: 'phase_1', label: '', duration_minutes: row.duration_info.minutes, installation_ids: row.installation_resolution.map((r) => r.confirmed_id), professionals: { mode: row.professional_mode, ids: row.professional_resolution.map((r) => r.confirmed_id), preferred_id: row.professional_mode === 'any' && row.professional_resolution.length === 1 ? row.professional_resolution[0].confirmed_id : null } }] };
      row.do_not_write_price_base = true;
      // Only these two columns are bono prices, never generic Sale a/Ahorro.
      row.additional_voucher_offers = row.sheet === 'Tratamientos individuales' ? [['E', 5], ['F', 10]].filter(([column]) => c[column] && !['—', '-'].includes(c[column])).map(([column, units]) => ({ units, source_price: grossPrice(c[column]), base_source_catalog_key: row.source_catalog_key })) : [];
      rows.push(row);
    }
  }
  const count = (field) => rows.reduce((out, r) => { out[r[field]] = (out[r[field]] || 0) + 1; return out; }, {});
  const result = { version: 1, workbook_sha256: workbookHash, local_snapshot_sha256: hash(local), resource_map_sha256: hash(resourceMap), source_price_semantics: 'gross_tax_included_no_price_base_write', mode: 'catalog_dry_run_only', clinics: { medical: 72, capilar: 66 }, ignored_sheets: sheets.filter((s) => !CONFIG[s.name]).map((s) => s.name), local_resources: { installations: local.installations, professionals: local.professionals }, rows,
    summary: { commercial_rows: rows.length, by_kind: count('kind'), by_clinic: count('clinic_id'), safe_draft_rows: rows.filter((r) => r.safe_for_draft_import).length, ready_for_booking: rows.filter((r) => r.ready_for_booking).length, additional_voucher_offers: rows.reduce((n, r) => n + r.additional_voucher_offers.length, 0), issues: rows.flatMap((r) => r.issues).reduce((out, issue) => { out[issue] = (out[issue] || 0) + 1; return out; }, {}) } };
  return { ...result, plan_sha256: hash(result) };
}
module.exports = { buildCatalogPlan, grossPrice, durationInfo, kindOf };
