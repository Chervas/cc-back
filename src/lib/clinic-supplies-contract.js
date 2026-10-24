'use strict';

const crypto = require('node:crypto');
const MAX_QUANTITY = 1000000000;
function fail(code, message, statusCode = 400) { const error = new Error(message); Object.assign(error, { code, statusCode }); throw error; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('fields_invalid', 'Revisa los campos de esta acción.');
  return value;
}
function text(value, max, required = false) {
  if (typeof value !== 'string') fail('text_invalid', 'Revisa los textos de esta acción.');
  const result = value.trim();
  if (result.length > max || required && !result || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) fail('text_invalid', 'Revisa la longitud y el contenido de los textos.');
  return result;
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) fail('id_invalid', 'Selecciona un registro válido.');
  return value;
}
function integer(value) { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) fail('scope_invalid', 'Selecciona una clínica válida.'); return result; }
// Quantities are exact thousandths throughout commands; no binary-float accumulation.
function units(value, allowZero = true) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_QUANTITY || !allowZero && value === 0 || Math.abs(value * 1000 - Math.round(value * 1000)) > 0.0001) fail('quantity_invalid', 'Indica una cantidad válida, con un máximo de tres decimales.');
  return Math.round(value * 1000);
}
const amount = value => Number(value) / 1000;
function date(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) fail('date_invalid', 'Indica una fecha válida.');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('date_invalid', 'Indica una fecha válida.');
  return value;
}
function version(value) { if (!Number.isSafeInteger(value) || value < 1) fail('version_required', 'Actualiza el registro antes de guardar.', 428); return value; }
function commandKey(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{8,120}$/.test(value)) fail('idempotency_required', 'Reintenta la acción con su identificador original.', 428); return value; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])); return value; }
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function supplier(value, creating = false) {
  fields(value, ['name', 'type', 'contact_name', 'email', 'phone', 'notes', 'active']);
  const result = {};
  if (creating || value.name !== undefined) result.name = text(value.name, 160, true);
  if (creating || value.type !== undefined) { if (!['laboratory', 'distributor', 'manufacturer', 'other'].includes(value.type)) fail('supplier_type', 'Selecciona el tipo de proveedor.'); result.type = value.type; }
  for (const [key, max] of [['contact_name', 160], ['email', 254], ['phone', 60], ['notes', 5000]]) if (creating || value[key] !== undefined) result[key] = text(value[key] ?? '', max);
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) fail('email_invalid', 'Revisa el correo del proveedor.');
  if (creating || value.active !== undefined) { if (value.active !== undefined && typeof value.active !== 'boolean') fail('active_invalid', 'Revisa el estado del registro.'); result.active = value.active ?? true; }
  if (!Object.keys(result).length) fail('empty_update', 'Indica qué quieres modificar.');
  return result;
}
function product(value, creating = false) {
  fields(value, ['name', 'unit', 'location', 'supplier_id', 'minimum_quantity', 'active']);
  const result = {};
  for (const [key, max] of [['name', 160], ['unit', 40], ['location', 160]]) if (creating || value[key] !== undefined) result[key] = text(value[key] ?? (key === 'location' ? '' : undefined), max, key !== 'location');
  if (creating || value.supplier_id !== undefined) result.supplier_id = value.supplier_id ? id(value.supplier_id) : null;
  if (creating || value.minimum_quantity !== undefined) result.minimum_quantity = amount(units(value.minimum_quantity ?? 0));
  if (creating || value.active !== undefined) { if (value.active !== undefined && typeof value.active !== 'boolean') fail('active_invalid', 'Revisa el estado del registro.'); result.active = value.active ?? true; }
  if (!Object.keys(result).length) fail('empty_update', 'Indica qué quieres modificar.');
  return result;
}
function today(at, timezone = 'Europe/Madrid') {
  let zone = timezone;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(at); } catch { zone = 'Europe/Madrid'; }
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
module.exports = { MAX_QUANTITY, fail, object, fields, text, id, integer, units, amount, date, version, commandKey, hash, supplier, product, today };
