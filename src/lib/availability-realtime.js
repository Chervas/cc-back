'use strict';

const { positive, MAX_CLINICS } = require('../../services/platform-audit/src/realtime-contract');

// Only resource membership metadata. Never read appointments, patient identities,
// schedules or individual slots here. Re-read this graph for every batch: a new
// room alias/equipment share must not wait for an unrelated cache TTL to expire.
const RELATED_CLINICS_SQL = `
WITH source_rooms AS (
  SELECT DISTINCT COALESCE(a.canonical_installation_id, i.id) AS physical_id
  FROM Instalaciones i
  LEFT JOIN InstallationPhysicalAliases a ON a.installation_id = i.id
  WHERE i.clinica_id IN (:clinicIds)
), source_equipment AS (
  SELECT id FROM BookingEquipment WHERE owner_clinic_id IN (:clinicIds)
  UNION
  SELECT equipment_id FROM BookingEquipmentClinics WHERE clinic_id IN (:clinicIds)
), related AS (
  SELECT peer.clinica_id AS clinic_id
  FROM DoctorClinicas origin
  INNER JOIN DoctorClinicas peer ON peer.doctor_id = origin.doctor_id
  WHERE origin.clinica_id IN (:clinicIds) AND peer.activo = 1 AND peer.recibe_citas = 1
  UNION
  SELECT i.clinica_id FROM source_rooms s INNER JOIN Instalaciones i ON i.id = s.physical_id
  UNION
  SELECT i.clinica_id FROM source_rooms s
  INNER JOIN InstallationPhysicalAliases a ON a.canonical_installation_id = s.physical_id
  INNER JOIN Instalaciones i ON i.id = a.installation_id
  UNION
  SELECT e.owner_clinic_id FROM source_equipment s INNER JOIN BookingEquipment e ON e.id = s.id
  UNION
  SELECT peer.clinic_id FROM source_equipment s
  INNER JOIN BookingEquipmentClinics peer ON peer.equipment_id = s.id
)
SELECT /*+ MAX_EXECUTION_TIME(1500) */ DISTINCT clinic_id FROM related
WHERE clinic_id NOT IN (:clinicIds) ORDER BY clinic_id LIMIT 1001`;

async function relatedClinics({ db, clinicIds }) {
  if (!Array.isArray(clinicIds) || !clinicIds.length || clinicIds.length > MAX_CLINICS || clinicIds.some(id => !positive(id))) {
    throw Error('availability_realtime_scope_invalid');
  }
  const ids = [...new Set(clinicIds.map(Number))].sort((a,b) => a-b);
  const rows = await db.sequelize.query(RELATED_CLINICS_SQL, {
    replacements: { clinicIds: ids }, type: db.Sequelize.QueryTypes.SELECT, retry: { max: 0 },
  });
  if (rows.length > 1000 || rows.some(row => !positive(row.clinic_id))) throw Error('availability_realtime_scope_limit');
  return [...new Set(rows.map(row => Number(row.clinic_id)))].filter(id => !ids.includes(id));
}

// One outstanding graph lookup, at most 100 source clinics per query and a
// bounded queue. This is best-effort UI invalidation, never part of committing a
// booking. Failed delivery cannot roll back/duplicate a successful appointment.
function createInvalidator({ resolve, publish, warn = () => {}, delayMs = 200,
  setTimer = setTimeout, clearTimer = clearTimeout, maxPending = 1000 }) {
  const pending = new Set(); let timer = null, running = false, stopped = false;
  function schedule() {
    if (!stopped && !running && !timer && pending.size) {
      timer = setTimer(flush, delayMs); timer?.unref?.();
    }
  }
  async function flush() {
    timer = null;
    if (stopped || running || !pending.size) return;
    running = true;
    const ids = [...pending].slice(0, MAX_CLINICS); ids.forEach(id => pending.delete(id));
    try {
      const targets = await resolve(ids);
      if (!Array.isArray(targets) || targets.length > 1000 || targets.some(id => !positive(id))) throw Error('invalid_targets');
      if (!stopped) for (const clinicId of new Set(targets.map(Number))) {
        if (!ids.includes(clinicId)) publish('availability:changed', { clinic_id: clinicId }, [`clinic:${clinicId}`]);
      }
    } catch (_) { warn('availability_realtime_refresh_failed'); }
    finally { running = false; schedule(); }
  }
  return {
    notify(event, payload) {
      if (stopped || !['appointment:created','appointment:updated','appointment:deleted'].includes(event)
        || !positive(payload?.clinic_id) || !positive(payload?.appointment_id)) return;
      const id = Number(payload.clinic_id);
      if (!pending.has(id) && pending.size >= maxPending) { warn('availability_realtime_queue_full'); return; }
      pending.add(id); schedule();
    },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null; pending.clear(); },
    state() { return { pending: pending.size, running }; },
  };
}

module.exports = { relatedClinics, createInvalidator, RELATED_CLINICS_SQL };
