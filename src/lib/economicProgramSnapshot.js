'use strict';

const crypto = require('node:crypto');
const { domainError } = require('./treatmentPrograms.contract');
const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter((key) => !['program_snapshot', 'entitlement_units', 'base', 'total', 'expected_version', 'source_reference'].includes(key)).map((key) => [key, stable(value[key])])) : value;
const requestHash = (payload) => hash(stable(payload));
const economicsEnabled = (environment = process.env) => environment.TREATMENT_PROGRAM_ECONOMICS_ENABLED === 'true';
function assertIntegrationEnabled(lines = [], { enabled = economicsEnabled() } = {}) {
  if (!enabled && Array.isArray(lines) && lines.some((line) => line?.program_id || line?.program_snapshot)) {
    throw domainError(503, 'program_economics_disabled', 'La integración económica de programas está deshabilitada hasta promocionar todos los entornos compatibles. Puedes preparar la definición en Tratamientos > Programas, pero aún no incorporarla a presupuestos ni bonos.');
  }
}
function integrationCapabilities({ programsAvailable = false, enabled = economicsEnabled() } = {}) {
  return { program_catalog: enabled && programsAvailable, program_economics_enabled: enabled,
    program_definitions_preparation_only: true, program_batch_booking: false,
    program_integration_reason: enabled ? 'program_booking_and_consumption_pending' : 'shared_runtime_compatibility_pending' };
}

function catalogItem(program) {
  return {
    id: `program:${program.id}`, treatment_id: null, program_id: program.id,
    program_version: program.version, program_kind: program.kind,
    code: `PG-${program.id.slice(0, 8)}`, name: program.name,
    description: program.notes || '', area_code: 'general', specialty: null,
    category: program.kind === 'voucher' ? 'Bonos' : 'Programas',
    product_type: program.kind === 'voucher' ? 'voucher' : 'pack',
    base_price: program.total_price, default_units: 1, unit_label: program.kind === 'voucher' ? 'bono' : 'programa',
    entitlement_units: program.summary.appointment_count, duration_minutes: program.summary.duration_minutes,
    price_semantics: 'gross_tax_included', requires_tooth: false, requires_zone: false,
    active: true, origin: 'clinica', activation_rule: 'on_acceptance',
  };
}

function snapshot(program) {
  if (program.status !== 'active' || program.total_price == null || program.summary.issues.length) {
    throw domainError(422, 'budget_program_not_sellable', 'El programa debe estar activo y tener su composición completa antes de presupuestarlo.');
  }
  const value = {
    schema_version: 1, program_id: program.id, program_version: program.version,
    kind: program.kind, name: program.name, currency: 'EUR',
    catalog_total_price: program.total_price, price_semantics: 'gross_tax_included',
    appointments: program.appointments.map((a) => ({
      key: a.key, label: a.label, offset_days: a.offset_days,
      treatment_ids: [...a.treatment_ids], duration_minutes: a.duration_minutes,
      treatments: a.treatments.map((t) => ({ id: t.id, name: t.name, duration_minutes: t.duration_minutes, booking_profile: copy(t.booking_profile) })),
    })),
  };
  return { ...value, sha256: hash(value) };
}

// Only a previous SERVER version or the scoped catalog resolver may supply a
// snapshot. Client JSON is never accepted as evidence of a sale/composition.
async function resolveLines(rawLines, { previousLines = [], resolve, integrationEnabled = economicsEnabled() }) {
  if (!Array.isArray(rawLines)) throw domainError(400, 'budget_lines_required', 'Las líneas del presupuesto deben ser una lista.');
  assertIntegrationEnabled([...rawLines, ...previousLines], { enabled: integrationEnabled });
  const previous = new Map(previousLines.map((line) => [line.key, line]));
  const keys = new Set();
  const result = [];
  for (const raw of rawLines) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw domainError(400, 'budget_line_invalid', 'Concepto de presupuesto no válido.');
    const line = { ...raw };
    line.key = String(raw.key || raw.id || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    delete line.program_snapshot;
    delete line.entitlement_units;
    if (line.key && keys.has(line.key)) throw domainError(400, 'budget_duplicate_line_key', 'Cada concepto del presupuesto necesita una clave única.');
    if (line.key) keys.add(line.key);
    if (!line.program_id) {
      if (raw.program_snapshot) throw domainError(400, 'budget_program_reference_required', 'Falta la referencia del programa.');
      result.push(line); continue;
    }
    if (!line.key) throw domainError(400, 'budget_program_line_key_required', 'Falta la clave estable del concepto de programa.');
    if (Number(line.quantity) !== 1) throw domainError(400, 'budget_program_quantity_invalid', 'Cada línea representa un programa completo. Para comprar otro, añade otra línea.');
    if (!Number.isSafeInteger(Number(line.program_version)) || Number(line.program_version) < 1) throw domainError(400, 'budget_program_version_required', 'Falta la versión del programa seleccionado.');
    const prior = previous.get(line.key);
    let frozen;
    if (prior?.program_snapshot && prior.program_id === line.program_id && Number(prior.program_version) === Number(line.program_version)) {
      frozen = copy(prior.program_snapshot);
    } else {
      const program = await resolve(line.program_id, Number(line.program_version));
      if (Number(program.version) !== Number(line.program_version)) throw domainError(409, 'budget_program_version_conflict', 'El catálogo ha cambiado. Vuelve a seleccionar el programa.');
      frozen = snapshot(program);
    }
    result.push({ ...line, name: frozen.name, treatment_id: frozen.kind === 'voucher' ? frozen.appointments[0].treatment_ids[0] : null,
      program_id: frozen.program_id, program_version: frozen.program_version, program_snapshot: frozen,
      product_type: frozen.kind === 'voucher' ? 'voucher' : 'pack',
      entitlement_units: frozen.appointments.length, unit_label: frozen.kind === 'voucher' ? 'bono' : 'programa',
      activation_rule: 'on_acceptance' });
  }
  return result;
}

function programPlans({ budget, lines, events = [], vouchers = [] }) {
  const accepted = ['accepted', 'partially_accepted'].includes(budget.status);
  const acceptance = [...events].reverse().find((e) => ['accepted', 'partially_accepted'].includes(e.event_type));
  const metadata = typeof acceptance?.metadata === 'string' ? JSON.parse(acceptance.metadata) : acceptance?.metadata;
  const acceptedKeys = new Set(metadata?.accepted_line_keys || []);
  return lines.filter((l) => l.program_snapshot).map((line) => {
    const included = accepted && (budget.status === 'accepted' || acceptedKeys.has(line.key));
    const voucher = vouchers.find((v) => v.budget_line_key === line.key);
    return { budget_line_key: line.key, program_id: line.program_id, program_version: line.program_version,
      name: line.program_snapshot.name, kind: line.program_snapshot.kind,
      snapshot_sha256: line.program_snapshot.sha256, appointment_count: line.program_snapshot.appointments.length,
      purchase_status: included ? 'accepted' : accepted ? 'not_accepted' : 'offered',
      can_schedule: false, capability_reason: 'program_batch_booking_pending',
      // No synthetic reserved/completed state: no program-unit ledger exists yet.
      appointments: line.program_snapshot.appointments.map((a) => ({ ...copy(a), scheduling_status: included ? 'pending_planning' : 'not_accepted' })),
      voucher_id: voucher?.public_id || null };
  });
}

function assertFiscalReady({ lines = [], status, fiscalLines = [] }) {
  if (!lines.some((line) => line.program_snapshot)) return;
  // A gross program price is not a taxable base. No inferred specialty-wide
  // tax rate, no additional VAT, and no effect on the existing fiscal engine.
  if (status === 'issued' || fiscalLines.some((line) => Number(line.tax_percent ?? line.vat_percent ?? 0) !== 0)) {
    throw domainError(422, 'program_fiscal_configuration_pending', 'El precio del programa incluye impuestos. Falta confirmar su desglose fiscal: no se puede añadir IVA ni emitir este documento todavía. Puedes conservar el borrador con el precio final.');
  }
}
function assertOperational(lines = []) {
  if (lines.some((line) => line.program_id || line.program_snapshot)) throw domainError(409, 'program_preparation_only', 'Este presupuesto contiene un programa en preparación. Puedes guardar el borrador, pero no presentarlo, firmarlo ni cobrarlo hasta habilitar la planificación y el consumo de sus citas.');
}

module.exports = { catalogItem, snapshot, resolveLines, programPlans, requestHash, assertFiscalReady, assertOperational,
  economicsEnabled, assertIntegrationEnabled, integrationCapabilities };
