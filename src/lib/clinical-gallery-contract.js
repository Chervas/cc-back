'use strict';
const C = require('./clinical-episode-contract');
const json = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw C.error(400, 'clinical_gallery_id_invalid', 'Selecciona un elemento válido.');
  return value;
};
function classification(value, required = false) {
  if (['photo', 'test'].includes(value)) return value;
  if (!required && (value == null || value === 'unknown')) return 'unknown';
  throw C.error(400, 'clinical_attachment_classification_required', 'Indica si el archivo es una foto o una prueba.');
}
function originalClassification(asset) { const value = json(asset.metadata)?.classification; return ['photo', 'test'].includes(value) ? value : 'unknown'; }
function libraryItem(asset, state) {
  return { classification: state ? classification(state.classification) : originalClassification(asset),
    library_status: state?.status === 'archived' ? 'archived' : 'active', library_version: Number(state?.version_number || 1) };
}
function expected(payload) {
  if (!C.has(payload, 'expected_version')) throw C.error(428, 'clinical_gallery_version_required', 'Vuelve a cargar el elemento antes de guardar.');
  return C.integer(payload.expected_version, 'expected_version');
}
function side(value) {
  if (!C.object(value) || Object.keys(value).some(key => !['asset_id', 'episode_id'].includes(key))) throw C.error(400, 'clinical_photo_pair_side_invalid', 'Selecciona las fotos del antes y el después.');
  return { asset_id: id(value.asset_id), episode_id: value.episode_id == null ? null : id(value.episode_id) };
}
function pairInput(payload, creating = false) {
  if (!C.object(payload)) throw C.error(400, 'clinical_photo_pair_invalid', 'Revisa la comparación.');
  if (Object.keys(payload).some(key => !['clinic_id', 'expected_version', 'idempotency_key', 'title', 'service_ref', 'treatment_id', 'before', 'after'].includes(key))) throw C.error(400, 'clinical_photo_pair_invalid', 'Revisa los campos de la comparación.');
  const out = {};
  if (creating && payload.expected_version !== undefined && payload.expected_version !== 0) throw C.error(409, 'clinical_gallery_version_conflict', 'Esta comparación ya tiene otra versión.');
  if (C.has(payload, 'title')) out.title = C.text(payload.title, 'title', 180) || 'Antes y después';
  else if (creating) out.title = 'Antes y después';
  for (const key of ['before', 'after']) if (creating || C.has(payload, key)) out[key] = side(payload[key]);
  if (!creating && (C.has(payload, 'service_ref') || C.has(payload, 'treatment_id'))) throw C.error(400, 'clinical_photo_pair_scope_immutable', 'El servicio de esta comparación se conserva. Crea otra comparación para cambiarlo.');
  out.idempotency_key = C.idempotencyKey(payload.idempotency_key, creating);
  return out;
}
module.exports = { json, id, classification, originalClassification, libraryItem, expected, side, pairInput };
