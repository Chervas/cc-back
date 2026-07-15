'use strict';

function selectAuthorizedMetaAssets(requestedAssets, authorizedAssets) {
  const authorizedByKey = new Map((Array.isArray(authorizedAssets) ? authorizedAssets : [])
    .map((asset) => [`${String(asset?.type || '').trim()}|${String(asset?.id || '').trim()}`, asset]));
  const selectedByKey = new Map();
  for (const requested of Array.isArray(requestedAssets) ? requestedAssets : []) {
    const type = String(requested?.type || '').trim();
    const id = String(requested?.id || '').trim();
    const authorized = authorizedByKey.get(`${type}|${id}`);
    if (!authorized) {
      const error = new Error('Algún activo seleccionado no pertenece a la conexión Meta autorizada.');
      error.code = 'meta_asset_not_accessible';
      error.httpStatus = 400;
      throw error;
    }
    selectedByKey.set(`${type}|${id}`, authorized);
  }
  return Array.from(selectedByKey.values());
}

function withoutMetaAccessToken(value) {
  const plain = typeof value?.get === 'function' ? value.get({ plain: true }) : value;
  if (Array.isArray(plain)) return plain.map(withoutMetaAccessToken);
  if (!plain || typeof plain !== 'object' || plain instanceof Date) return plain;
  const publicValue = {};
  for (const [key, nestedValue] of Object.entries(plain)) {
    if (String(key).toLowerCase().includes('token')) continue;
    publicValue[key] = withoutMetaAccessToken(nestedValue);
  }
  return publicValue;
}

module.exports = {
  selectAuthorizedMetaAssets,
  withoutMetaAccessToken,
};
