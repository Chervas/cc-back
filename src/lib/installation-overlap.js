'use strict';

// An explicit flag, never a large synthetic capacity. Omission preserves the
// existing policy so older clients cannot silently change a shared room.
function normalizeInstallationOverlap(body, previous = {}) {
  const enabled = body.allow_overlap_confirmation ?? previous.allow_overlap_confirmation ?? false;
  const unlimited = body.overlap_capacity_unlimited ?? previous.overlap_capacity_unlimited ?? false;
  const capacity = body.capacidad !== undefined ? Number(body.capacidad) : Number(previous.capacidad || 1);
  if (typeof enabled !== 'boolean' || typeof unlimited !== 'boolean' || !Number.isInteger(capacity)
    || capacity < 1 || capacity > 20 || (enabled && !unlimited && capacity < 2)) {
    throw Object.assign(new Error('Indica una capacidad entre 1 y 20; para compartir elige un máximo de al menos 2 o «Sin límite».'), { code: 'installation_overlap_invalid', status: 400 });
  }
  return { allow_overlap_confirmation: enabled, overlap_capacity_unlimited: unlimited, capacidad: capacity };
}

function installationOverlapCapacity(room) {
  return room?.overlap_capacity_unlimited === true || room?.overlap_capacity_unlimited === 1
    ? null : Number(room?.capacidad) || 1;
}

module.exports = { normalizeInstallationOverlap, installationOverlapCapacity };
