'use strict';

const { equipmentError, positiveIds, normalizeEquipmentUnit, normalizeRoomEquipmentPolicy, clinicUsesEquipment, equipmentFitsRoom } = require('../lib/booking-equipment');
const { equipmentRuntimeEnabled, assertEquipmentEnabled } = require('./bookingEquipmentAvailability.service');
const { lockBookingResources } = require('./appointmentBookingCommand.service');
const { resolveInstallationKeys } = require('./appointmentBookingAvailability.service');
const plain = row => row?.toJSON ? row.toJSON() : row;
const numeric = values => [...new Set(values.map(Number))].sort((a, b) => a - b);

function createBookingEquipmentRegistry({ db, authorize, enabled = equipmentRuntimeEnabled, now = () => new Date() }) {
  const { Op } = db.Sequelize;
  const transaction = work => db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, work);
  async function canEdit(clinicId) {
    try { await authorize('clinic.settings.edit', clinicId); return true; }
    catch (error) {
      if (error.status === 403 || error.statusCode === 403 || error.message === 'access_policy_forbidden') return false;
      throw error;
    }
  }
  async function scope(ids, feature = 'clinic.settings.edit', tx = null, lock = false) {
    ids = positiveIds(numeric(ids), 50);
    if (!ids.length) throw equipmentError('scope', 'Selecciona una clínica.', 400);
    for (const clinicId of ids) await authorize(feature, clinicId);
    const clinics = [];
    for (const id of ids) {
      const clinic = await db.Clinica.findByPk(id, { transaction: tx, ...(lock ? { lock: tx.LOCK.UPDATE } : {}) });
      if (!clinic) throw equipmentError('not_found', 'Clínica no encontrada.', 404);
      clinics.push(clinic);
    }
    return clinics;
  }
  async function futureEquipmentRows(keys, tx) {
    if (!keys.length) return [];
    const rows = await db.AppointmentBookingOccupancy.findAll({ where: { resource_key: { [Op.in]: keys }, end_at: { [Op.gt]: now() } },
      include: [{ model: db.CitaPaciente, as: 'appointment', attributes: ['clinica_id'], required: true,
        where: { estado: { [Op.ne]: 'cancelada' } } }], limit: 2001, transaction: tx });
    if (rows.length > 2000) throw equipmentError('review_required', 'Revisa las reservas por partes antes de cambiar el equipo.', 409);
    return rows;
  }
  async function read(clinicId) {
    const [clinic] = await scope([clinicId], 'clinic.settings.view');
    const feature = clinicUsesEquipment(clinic);
    const result = { clinic_id: clinicId, enabled: feature, runtime_available: enabled(), can_edit: await canEdit(clinicId),
      units: [], rooms: [], sharing_clinics: [] };
    // No inventory or compatibility query for clinics without this feature.
    if (!feature || !enabled()) return result;
    // Configuration screen only: never called by the availability/slot search path.
    const peers = clinic.grupoClinicaId ? await db.Clinica.findAll({
      where: { grupoClinicaId: clinic.grupoClinicaId },
      attributes: ['id_clinica', 'nombre_clinica', 'equipment_booking_enabled'], limit: 51,
    }) : [clinic];
    const editable = new Set(result.can_edit ? [clinicId] : []);
    for (const peer of peers.slice(0, 50)) {
      const peerId = Number(peer.id_clinica);
      if (peerId === clinicId ? result.can_edit : await canEdit(peerId)) {
        editable.add(peerId);
        result.sharing_clinics.push({ id: peerId, name: peer.nombre_clinica, enabled: clinicUsesEquipment(peer) });
      }
    }
    const shares = await db.BookingEquipmentClinic.findAll({ where: { clinic_id: clinicId }, limit: 201 });
    if (shares.length > 200) throw equipmentError('limit', 'Revisa el inventario por partes.');
    const units = shares.length ? await db.BookingEquipment.findAll({ where: { id: { [Op.in]: shares.map(s => s.equipment_id) } },
      include: [{ model: db.Clinica, as: 'owner_clinic', attributes: ['id_clinica', 'grupoClinicaId'] }] }) : [];
    // Group changes do not grant inherited access to a physical device.
    const visible = units.filter(u => Number(u.owner_clinic_id) === clinicId || (Number(clinic.grupoClinicaId)
      && Number(u.group_id) === Number(clinic.grupoClinicaId) && Number(u.owner_clinic?.grupoClinicaId) === Number(clinic.grupoClinicaId)));
    const ownedIds = visible.filter(u => Number(u.owner_clinic_id) === clinicId).map(u => Number(u.id));
    const ownedShares = ownedIds.length ? await db.BookingEquipmentClinic.findAll({
      where: { equipment_id: { [Op.in]: ownedIds } },
    }) : [];
    const rooms = await db.Instalacion.findAll({ where: { clinica_id: clinicId }, attributes: ['id', 'nombre', 'activo'] });
    const mapping = await resolveInstallationKeys({ db, clinic, installationIds: rooms.map(r => Number(r.id)), enabled: true });
    const canonicalIds = numeric([...mapping.keys.values()].map(k => k.split(':')[1]));
    const policies = canonicalIds.length ? await db.BookingEquipmentRoomPolicy.findAll({ where: { installation_id: { [Op.in]: canonicalIds } } }) : [];
    const policyMap = new Map(policies.map(p => [Number(p.installation_id), p]));
    result.rooms = rooms.map(r => {
      const key = mapping.keys.get(Number(r.id));
      const p = policyMap.get(Number(key.split(':')[1]));
      return { id: Number(r.id), name: r.nombre, active: r.activo, resource_key: key,
        equipment_policy: p ? { mode: p.mode, equipment_ids: p.equipment_ids || [] } : { mode: 'none', equipment_ids: [] }, revision: p?.revision || 0 };
    });
    result.units = visible.map(u => {
      const unit = { ...plain(u), owner_clinic: undefined, id: Number(u.id),
        fixed_resource_key: mapping.keys.get(Number(u.home_installation_id)) || `installation:${u.home_installation_id}` };
      return { id: unit.id, name: u.name, family_key: u.family_key, aliases: u.aliases || [], mobility: u.mobility, status: u.status,
        home_installation_id: u.home_installation_id, turnaround_minutes: u.turnaround_minutes, revision: u.revision,
        owned_here: Number(u.owner_clinic_id) === clinicId,
        can_edit: Number(u.owner_clinic_id) === clinicId && result.can_edit
          && ownedShares.filter(s => Number(s.equipment_id) === unit.id).every(s => editable.has(Number(s.clinic_id))),
        ...(Number(u.owner_clinic_id) === clinicId ? { clinic_ids: numeric(ownedShares.filter(s => Number(s.equipment_id) === unit.id).map(s => s.clinic_id)) } : {}),
        permitted_rooms: result.rooms.filter(r => equipmentFitsRoom({ ...unit, status: 'available' }, r)).map(r => ({ id: r.id, name: r.name })) };
    });
    return result;
  }
  async function setEnabled(clinicId, value) {
    if (typeof value !== 'boolean') throw equipmentError('invalid', 'Indica si esta clínica utiliza equipos.');
    if (value && !enabled()) throw equipmentError('runtime_unavailable', 'Primero debe publicarse el soporte de maquinaria en todos los consumidores.', 409);
    return transaction(async tx => {
      const [clinic] = await scope([clinicId], 'clinic.settings.edit', tx, true);
      if (!value && clinicUsesEquipment(clinic)) {
        const linked = await db.BookingEquipmentClinic.findOne({ where: { clinic_id: clinicId }, transaction: tx });
        if (linked) throw equipmentError('in_use', 'Revisa y retira las asignaciones de equipos antes de desactivar la función. No se ocultarán reservas existentes.', 409);
      }
      await clinic.update({ equipment_booking_enabled: value }, { transaction: tx });
      return { clinic_id: clinicId, enabled: value };
    });
  }
  async function saveUnit(clinicId, id, payload) {
    await scope([clinicId]);
    const initial = id ? await db.BookingEquipment.findByPk(id) : null;
    if (id && (!initial || Number(initial.owner_clinic_id) !== clinicId)) throw equipmentError('not_found', 'Equipo no encontrado en esta clínica.', 404);
    // Keep technical family identifiers out of the basic editor; preserve on rename.
    const family = initial?.family_key || String(payload?.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    const data = normalizeEquipmentUnit({ ...payload, family_key: payload.family_key ?? family });
    const priorShares = initial ? await db.BookingEquipmentClinic.findAll({ where: { equipment_id: id } }) : [];
    const requestedClinics = positiveIds(payload.clinic_ids ?? (priorShares.length ? numeric(priorShares.map(s => s.clinic_id)) : [clinicId]));
    if (!requestedClinics.includes(clinicId)) throw equipmentError('scope', 'Conserva la clínica propietaria del equipo.');
    const affectedIds = numeric([...requestedClinics, ...priorShares.map(s => s.clinic_id)]);
    return transaction(async tx => {
      const clinics = await scope(affectedIds, 'clinic.settings.edit', tx, true);
      const owner = clinics.find(c => Number(c.id_clinica) === clinicId);
      assertEquipmentEnabled(owner, enabled());
      if (requestedClinics.some(cid => !clinicUsesEquipment(clinics.find(c => Number(c.id_clinica) === cid)))) throw equipmentError('disabled', 'Activa la gestión de equipos en las clínicas seleccionadas.', 409);
      if (requestedClinics.length > 1 && (!owner.grupoClinicaId || clinics.filter(c => requestedClinics.includes(Number(c.id_clinica)))
        .some(c => Number(c.grupoClinicaId) !== Number(owner.grupoClinicaId)))) throw equipmentError('scope', 'Solo se comparten equipos entre clínicas del mismo grupo.');
      if (data.home_installation_id) {
        const room = await db.Instalacion.findByPk(data.home_installation_id, { transaction: tx });
        if (!room || !requestedClinics.includes(Number(room.clinica_id))) throw equipmentError('scope', 'La ubicación habitual debe pertenecer a una clínica autorizada.');
      }
      let unit;
      if (id) {
        await lockBookingResources({ db, resourceKeys: [`equipment:${id}`], transaction: tx });
        unit = await db.BookingEquipment.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
        if (unit.revision !== payload.revision) throw equipmentError('changed', 'El equipo ha cambiado. Actualiza la ficha antes de guardar.', 409);
        const shares = await db.BookingEquipmentClinic.findAll({ where: { equipment_id: id }, transaction: tx });
        if (shares.some(s => !affectedIds.includes(Number(s.clinic_id)))) throw equipmentError('changed', 'Han cambiado las clínicas que utilizan el equipo. Actualiza la ficha.', 409);
        const structural = ['family_key', 'mobility', 'status', 'home_installation_id', 'turnaround_minutes'].some(k => data[k] !== unit[k])
          || JSON.stringify(numeric(shares.map(s => s.clinic_id))) !== JSON.stringify(numeric(requestedClinics));
        if (structural && (await futureEquipmentRows([`equipment:${id}`], tx)).length) throw equipmentError('in_use',
          'Este cambio afecta a citas futuras. Revisa sus equipos antes de modificar disponibilidad, ubicación o clínicas.', 409);
        await unit.update({ ...data, group_id: owner.grupoClinicaId || null, revision: unit.revision + 1 }, { transaction: tx });
      } else unit = await db.BookingEquipment.create({ ...data, owner_clinic_id: clinicId, group_id: owner.grupoClinicaId || null }, { transaction: tx });
      await db.BookingEquipmentClinic.destroy({ where: { equipment_id: unit.id }, transaction: tx });
      await db.BookingEquipmentClinic.bulkCreate(requestedClinics.map(cid => ({ equipment_id: unit.id, clinic_id: cid })), { transaction: tx });
      return { id: Number(unit.id), revision: unit.revision };
    });
  }
  async function saveRoomPolicy(clinicId, roomId, payload) {
    const policy = normalizeRoomEquipmentPolicy(payload);
    const [clinic] = await scope([clinicId]);
    assertEquipmentEnabled(clinic, enabled());
    const room = await db.Instalacion.findByPk(roomId);
    if (!room || Number(room.clinica_id) !== clinicId) throw equipmentError('not_found', 'Cabina no encontrada.', 404);
    const mapping = await resolveInstallationKeys({ db, clinic, installationIds: [roomId], enabled: true });
    const rooms = await db.Instalacion.findAll({ where: { id: { [Op.in]: mapping.physicalInstallationIds } }, attributes: ['id', 'clinica_id'] });
    return transaction(async tx => {
      const lockedClinics = await scope(numeric(rooms.map(r => r.clinica_id)), 'clinic.settings.edit', tx, true);
      assertEquipmentEnabled(lockedClinics.find(c => Number(c.id_clinica) === clinicId), enabled());
      const currentMapping = await resolveInstallationKeys({ db, clinic, installationIds: [roomId], enabled: true, transaction: tx });
      if (JSON.stringify(currentMapping.physicalInstallationIds) !== JSON.stringify(mapping.physicalInstallationIds)) throw equipmentError('changed', 'Ha cambiado la equivalencia de cabinas. Actualiza la ficha.', 409);
      const key = mapping.keys.get(roomId), canonicalId = Number(key.split(':')[1]);
      await lockBookingResources({ db, resourceKeys: [key], transaction: tx });
      const current = await db.BookingEquipmentRoomPolicy.findByPk(canonicalId, { transaction: tx });
      if ((current?.revision || 0) !== payload.revision) throw equipmentError('changed', 'La cabina ha cambiado. Actualiza la ficha.', 409);
      if (policy.equipment_ids.length) {
        const shares = await db.BookingEquipmentClinic.findAll({ where: { clinic_id: clinicId, equipment_id: { [Op.in]: policy.equipment_ids } }, transaction: tx });
        if (shares.length !== policy.equipment_ids.length) throw equipmentError('scope', 'Selecciona equipos autorizados para esta clínica.');
      }
      const roomRows = await futureEquipmentRows([key], tx);
      if (roomRows.length) {
        const eqRows = await db.AppointmentBookingOccupancy.findAll({ where: { resource_kind: 'equipment',
          appointment_id: { [Op.in]: numeric(roomRows.map(r => r.appointment_id)) } }, limit: 2001, transaction: tx });
        if (eqRows.length > 2000) throw equipmentError('review_required', 'Revisa las reservas por partes.', 409);
        const machineIds = numeric(eqRows.map(r => r.resource_key.split(':')[1]));
        const units = machineIds.length ? await db.BookingEquipment.findAll({ where: { id: { [Op.in]: machineIds } }, transaction: tx }) : [];
        const blocked = eqRows.some(row => roomRows.some(r => Number(r.appointment_id) === Number(row.appointment_id) && r.phase_key === row.phase_key)
          && units.some(u => Number(u.id) === Number(row.resource_key.split(':')[1]) && u.mobility === 'mobile'
            && !equipmentFitsRoom({ ...plain(u), id: Number(u.id), status: 'available' }, { resource_key: key, equipment_policy: policy })));
        if (blocked) throw equipmentError('in_use', 'La restricción impediría utilizar equipos de citas ya reservadas. Revisa esas citas primero.', 409);
      }
      const revision = (current?.revision || 0) + 1;
      await db.BookingEquipmentRoomPolicy.upsert({ installation_id: canonicalId, ...policy, revision }, { transaction: tx });
      return { installation_id: roomId, policy, revision };
    });
  }
  async function archiveUnit(clinicId, id, revision) {
    await scope([clinicId]);
    const initial = await db.BookingEquipment.findByPk(id);
    if (!initial || Number(initial.owner_clinic_id) !== clinicId) throw equipmentError('not_found', 'Equipo no encontrado en esta clínica.', 404);
    const priorShares = await db.BookingEquipmentClinic.findAll({ where: { equipment_id: id } });
    const affectedIds = numeric([clinicId, ...priorShares.map(s => s.clinic_id)]);
    return transaction(async tx => {
      await scope(affectedIds, 'clinic.settings.edit', tx, true);
      await lockBookingResources({ db, resourceKeys: [`equipment:${id}`], transaction: tx });
      const unit = await db.BookingEquipment.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (unit.revision !== revision) throw equipmentError('changed', 'El equipo ha cambiado. Actualiza la ficha.', 409);
      const shares = await db.BookingEquipmentClinic.findAll({ where: { equipment_id: id }, transaction: tx });
      if (shares.some(s => !affectedIds.includes(Number(s.clinic_id)))) throw equipmentError('changed', 'Han cambiado las clínicas que utilizan el equipo. Actualiza la ficha.', 409);
      if ((await futureEquipmentRows([`equipment:${id}`], tx)).length) throw equipmentError('in_use', 'Revisa las citas futuras antes de retirar este equipo.', 409);
      // Logical withdrawal only. Preserve IDs, snapshots and occupancy history.
      // Existing treatments still requiring it fail closed, never book without it.
      await unit.update({ status: 'unavailable', revision: unit.revision + 1 }, { transaction: tx });
      await db.BookingEquipmentClinic.destroy({ where: { equipment_id: id }, transaction: tx });
      return { id: Number(id), archived: true, revision: unit.revision };
    });
  }
  return { read, setEnabled, saveUnit, saveRoomPolicy, archiveUnit };
}
module.exports = { createBookingEquipmentRegistry };
