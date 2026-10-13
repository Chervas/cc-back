'use strict';

const { createHash } = require('node:crypto');
const { normalizeInstallationProfessionals } = require('../lib/installation-professionals');
const { bookingCapabilities, bookingError } = require('./treatmentBookingProfile.service');
const { lockBookingResources } = require('./appointmentBookingCommand.service');
const { withCalendarMutation } = require('./appointmentCalendarMutation.service');

const plain = row => row?.toJSON ? row.toJSON() : row;
const numeric = values => [...new Set(values.map(Number))].sort((a, b) => a - b);
const error = (suffix, message, status = 409) => bookingError(`installation_sharing_${suffix}`, message, null, status);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const isActive = value => value === true || value === 1;
const MAX_CLINICS = 50;
const MAX_ROOMS = 1000;

function normalizeSharingRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['revision', 'memberships'].includes(key))
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || !Array.isArray(value.memberships) || !value.memberships.length || value.memberships.length > MAX_CLINICS) {
    throw error('invalid', 'Actualiza la configuración y selecciona clínicas válidas.', 400);
  }
  const clinicIds = new Set();
  const memberships = value.memberships.map(member => {
    if (!member || typeof member !== 'object' || Array.isArray(member)
      || Object.keys(member).some(key => !['clinic_id', 'installation_id', 'enabled', 'professional_mode', 'professional_ids'].includes(key))
      || !positiveId(member.clinic_id) || clinicIds.has(member.clinic_id)
      || (member.installation_id !== null && !positiveId(member.installation_id))
      || typeof member.enabled !== 'boolean' || !['all', 'selected'].includes(member.professional_mode)) {
      throw error('invalid', 'Selecciona una única instalación válida por clínica.', 400);
    }
    clinicIds.add(member.clinic_id);
    const ids = normalizeInstallationProfessionals(member.professional_ids);
    if (!Array.isArray(member.professional_ids) || member.professional_mode === 'all' && ids.length
      || member.enabled && member.professional_mode === 'selected' && !ids.length) {
      throw error('invalid', 'Selecciona profesionales o permite todos los profesionales de esa clínica.', 400);
    }
    return { clinic_id: member.clinic_id, installation_id: member.installation_id, enabled: member.enabled,
      professional_mode: member.professional_mode, professional_ids: ids };
  }).sort((a, b) => a.clinic_id - b.clinic_id);
  return { revision: value.revision, memberships };
}

function canonicalId(roomId, aliases) {
  return Number(aliases.find(row => Number(row.installation_id) === Number(roomId))?.canonical_installation_id || roomId);
}

function physicalMembers(roomId, aliases) {
  if (!roomId) return [];
  const canonical = canonicalId(roomId, aliases);
  const attached = aliases.filter(row => Number(row.canonical_installation_id) === canonical);
  if (attached.some(row => Number(row.installation_id) === canonical)
    || aliases.some(row => Number(row.installation_id) === canonical)) {
    throw error('review_required', 'La vinculación física necesita revisión antes de editarse.');
  }
  return numeric([canonical, ...attached.map(row => row.installation_id)]);
}

/** Configuration-only adapter. The clinical IDs, clinic ownership and frozen
 * appointment snapshots are never merged or rewritten. The existing canonical
 * physical key is immutable through this API; removing clinic use disables its
 * member, not the identity link. No name matching and no DoctorClinica writes.
 */
function createInstallationPhysicalSharingService({ db, authorize, enabled = () => bookingCapabilities().simple,
  now = () => new Date(), lockResources = lockBookingResources, calendarMutation = withCalendarMutation,
  realtimeEnabled = process.env.AVAILABILITY_REALTIME_ENABLED === 'true',
  notify = require('../lib/calendar-availability-invalidation').notifyCalendarAvailability }) {
  const { Op } = db.Sequelize;
  async function can(feature, clinicId) {
    try { await authorize(feature, clinicId); return true; }
    catch (cause) {
      if (cause.status === 403 || cause.statusCode === 403 || cause.message === 'access_policy_forbidden') return false;
      throw cause;
    }
  }

  async function scope({ installationId = null, clinicId = null, transaction = null }) {
    if (installationId !== null && !positiveId(installationId) || clinicId !== null && !positiveId(clinicId)) {
      throw error('invalid', 'La clínica o la instalación indicada no es válida.', 400);
    }
    const room = installationId ? plain(await db.Instalacion.findByPk(installationId, { transaction })) : null;
    if (installationId && !room) throw error('not_found', 'Instalación no encontrada.', 404);
    const principalId = room ? Number(room.clinica_id) : clinicId;
    if (!positiveId(principalId)) throw error('invalid', 'Selecciona una clínica.', 400);
    await authorize('clinic.settings.view', principalId);
    const clinic = plain(await db.Clinica.findByPk(principalId, { transaction }));
    if (!clinic) throw error('not_found', 'Clínica no encontrada.', 404);
    const peers = Number(clinic.grupoClinicaId) > 0 ? (await db.Clinica.findAll({
      where: { grupoClinicaId: Number(clinic.grupoClinicaId) }, attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
      order: [['id_clinica', 'ASC']], limit: MAX_CLINICS + 1, transaction,
    })).map(plain) : [clinic];
    if (peers.length > MAX_CLINICS) throw error('review_required', 'Revisa las instalaciones del grupo por partes.');
    if (!peers.some(peer => Number(peer.id_clinica) === principalId)) throw error('review_required', 'Actualiza la clínica antes de configurar la sala.');
    return { room, clinic, principalId, peers };
  }

  async function state(args) {
    const scoped = await scope(args);
    const clinics = [];
    for (const peer of scoped.peers) {
      const id = Number(peer.id_clinica);
      if (id === scoped.principalId || await can('clinic.settings.view', id)) clinics.push({
        clinic_id: id, name: String(peer.nombre_clinica || ''), can_edit: await can('clinic.settings.edit', id),
      });
    }
    const ids = clinics.map(clinic => clinic.clinic_id);
    const [rooms, aliases, doctors] = await Promise.all([
      db.Instalacion.findAll({ where: { clinica_id: { [Op.in]: ids } },
        attributes: ['id', 'clinica_id', 'nombre', 'activo', 'profesionales_permitidos', 'updated_at'],
        order: [['id', 'ASC']], limit: MAX_ROOMS + 1, transaction: args.transaction }),
      Number(scoped.clinic.grupoClinicaId) > 0 ? db.InstallationPhysicalAlias.findAll({
        where: { group_id: Number(scoped.clinic.grupoClinicaId) },
        attributes: ['installation_id', 'canonical_installation_id', 'group_id'], order: [['installation_id', 'ASC']],
        limit: MAX_ROOMS + 1, transaction: args.transaction }) : [],
      db.DoctorClinica.findAll({ where: { clinica_id: { [Op.in]: ids }, activo: true, recibe_citas: true },
        attributes: ['doctor_id', 'clinica_id'], include: [{ model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos'] }],
        order: [['clinica_id', 'ASC'], ['doctor_id', 'ASC']], limit: 5001, transaction: args.transaction }),
    ]);
    if (rooms.length > MAX_ROOMS || aliases.length > MAX_ROOMS || doctors.length > 5000) {
      throw error('review_required', 'Revisa las instalaciones o profesionales del grupo por partes.');
    }
    const plainRooms = rooms.map(plain), plainAliases = aliases.map(plain), plainDoctors = doctors.map(plain);
    const memberIds = physicalMembers(scoped.room?.id, plainAliases);
    const members = memberIds.map(id => plainRooms.find(room => Number(room.id) === id)).filter(Boolean);
    const missing = members.length !== memberIds.length;
    if (new Set(members.map(room => Number(room.clinica_id))).size !== members.length) {
      throw error('review_required', 'Hay varias fichas de la misma sala en una clínica. Revisa la vinculación.');
    }
    const revision = createHash('sha256').update(JSON.stringify({ principal: scoped.principalId,
      room: scoped.room?.id || null, group: Number(scoped.clinic.grupoClinicaId) || null,
      clinics: clinics.map(row => [row.clinic_id, row.can_edit]),
      rooms: plainRooms.map(row => [Number(row.id), Number(row.clinica_id), row.nombre, isActive(row.activo),
        normalizeInstallationProfessionals(row.profesionales_permitidos), row.updated_at || row.updatedAt || null]),
      aliases: plainAliases.map(row => [Number(row.installation_id), Number(row.canonical_installation_id), Number(row.group_id)]),
      professionals: plainDoctors.map(row => [Number(row.clinica_id), Number(row.doctor_id)]),
    })).digest('hex');
    return { ...scoped, clinics, rooms: plainRooms, aliases: plainAliases, doctors: plainDoctors,
      memberIds, members, missing, revision };
  }

  async function context(args) {
    const current = await state(args);
    const linked = new Set(current.memberIds);
    const canConfigure = current.clinics.length > 1 && !current.missing
      && current.members.every(room => current.clinics.find(clinic => clinic.clinic_id === Number(room.clinica_id))?.can_edit)
      && current.clinics.find(clinic => clinic.clinic_id === current.principalId)?.can_edit === true;
    return {
      installation_id: current.room ? Number(current.room.id) : null,
      canonical_installation_id: current.room && current.rooms.some(room => Number(room.id) === canonicalId(current.room.id, current.aliases))
        ? canonicalId(current.room.id, current.aliases) : null,
      group_id: Number(current.clinic.grupoClinicaId) || null, revision: current.revision,
      can_configure: canConfigure, topology_changes_enabled: enabled() === true,
      sharing_enabled: current.members.filter(room => isActive(room.activo)).length > 1,
      clinics: current.clinics.map(clinic => ({ ...clinic,
        professionals: current.doctors.filter(row => Number(row.clinica_id) === clinic.clinic_id).map(row => ({
          doctor_id: Number(row.doctor_id), name: [row.doctor?.nombre, row.doctor?.apellidos].filter(Boolean).join(' ').trim(),
        })),
        installations: current.rooms.filter(room => Number(room.clinica_id) === clinic.clinic_id).map(room => {
          const ids = normalizeInstallationProfessionals(room.profesionales_permitidos);
          return {
            installation_id: Number(room.id), name: String(room.nombre || ''), active: isActive(room.activo), linked: linked.has(Number(room.id)),
            professional_mode: ids.length ? 'selected' : 'all', professional_ids: ids,
            can_link: !current.aliases.some(alias => Number(alias.installation_id) === Number(room.id)
              || Number(alias.canonical_installation_id) === Number(room.id)),
          };
        }),
      })),
      memberships: current.room ? current.members.map(room => {
        const ids = normalizeInstallationProfessionals(room.profesionales_permitidos);
        return { clinic_id: Number(room.clinica_id), installation_id: Number(room.id), enabled: isActive(room.activo),
          professional_mode: ids.length ? 'selected' : 'all', professional_ids: ids };
      }) : [{ clinic_id: current.principalId, installation_id: null, enabled: true,
        professional_mode: 'all', professional_ids: [] }],
    };
  }

  async function futureReservations(roomId, transaction) {
    const [appointment, occupancy] = await Promise.all([
      db.CitaPaciente.findOne({ where: { instalacion_id: roomId, estado: { [Op.ne]: 'cancelada' }, fin: { [Op.gt]: now() } },
        attributes: ['id_cita'], transaction }),
      db.AppointmentBookingOccupancy ? db.AppointmentBookingOccupancy.findOne({ where: { installation_id: roomId, end_at: { [Op.gt]: now() } },
        attributes: ['id'], include: [{ model: db.CitaPaciente, as: 'appointment', attributes: [], required: true,
          where: { estado: { [Op.ne]: 'cancelada' } } }], transaction }) : null,
    ]);
    return Boolean(appointment || occupancy);
  }

  async function assertLinkable(room, transaction) {
    // Rekeying frozen occupancy here would silently rewrite booked history.
    // A free clinical alias can be linked; a used segmented alias needs the
    // separate audited reconciliation, including both old/new resource keys.
    const [ledger, future, block, policy, fixed] = await Promise.all([
      db.AppointmentBookingOccupancy.findOne({ where: { [Op.or]: [
        { installation_id: Number(room.id) }, { resource_key: `installation:${room.id}` },
      ] }, attributes: ['id'], transaction }),
      futureReservations(Number(room.id), transaction),
      db.InstalacionBloqueo.findOne({ where: { instalacion_id: Number(room.id), fecha_fin: { [Op.gt]: now() } }, attributes: ['id'], transaction }),
      db.BookingEquipmentRoomPolicy ? db.BookingEquipmentRoomPolicy.findByPk(Number(room.id), { attributes: ['installation_id'], transaction }) : null,
      db.BookingEquipment ? db.BookingEquipment.findOne({ where: { home_installation_id: Number(room.id) }, attributes: ['id'], transaction }) : null,
    ]);
    if (ledger || future || block || policy || fixed) throw error('review_required',
      'Esta instalación tiene reservas, bloqueos o maquinaria vinculada. Revisa esas dependencias antes de compartir la sala; no se ha cambiado ninguna cita.');
  }

  async function validatePlan(current, request, transaction) {
    if (current.missing) throw error('forbidden', 'Necesitas permiso en todas las clínicas que utilizan esta sala.', 403);
    if (request.revision !== current.revision) throw error('stale', 'La configuración ha cambiado. Actualízala antes de guardar.');
    for (const room of current.members) {
      if (!request.memberships.some(member => member.clinic_id === Number(room.clinica_id)
        && member.installation_id === Number(room.id))) {
        throw error('invalid', 'Conserva las fichas vinculadas; para quitar una clínica desactiva su uso.', 400);
      }
    }
    const principal = request.memberships.find(member => member.clinic_id === current.principalId);
    if (!principal || !principal.enabled || principal.installation_id !== (current.room ? Number(current.room.id) : null)) {
      throw error('invalid', 'Conserva habilitada la clínica de la instalación que estás editando.', 400);
    }
    const additions = [];
    for (const member of request.memberships) {
      const clinic = current.clinics.find(row => row.clinic_id === member.clinic_id);
      if (!clinic) throw error('forbidden', 'Sólo puedes compartir instalaciones con clínicas autorizadas del mismo grupo.', 403);
      await authorize('clinic.settings.edit', member.clinic_id);
      const existing = current.members.find(room => Number(room.clinica_id) === member.clinic_id);
      if (existing && Number(existing.id) !== member.installation_id) throw error('invalid', 'Conserva el identificador de la ficha vinculada.', 400);
      const selectedIds = member.professional_mode === 'all' ? [] : member.professional_ids;
      const validStaff = new Set(current.doctors.filter(row => Number(row.clinica_id) === member.clinic_id).map(row => Number(row.doctor_id)));
      const previousRoom = existing || current.rooms.find(room => Number(room.id) === member.installation_id
        && Number(room.clinica_id) === member.clinic_id);
      const previousIds = previousRoom ? normalizeInstallationProfessionals(previousRoom.profesionales_permitidos) : [];
      const unchangedIds = previousRoom && JSON.stringify(previousIds) === JSON.stringify(selectedIds);
      // Stored historical allowlists may include a now-disabled professional.
      // Preserve unchanged evidence, but never add them as a new authorization.
      if (member.enabled && !unchangedIds && selectedIds.some(id => !validStaff.has(id))) {
        throw error('professionals_invalid', 'Selecciona profesionales activos que reciben citas en esa clínica.', 400);
      }
      if (existing) {
        const narrower = selectedIds.length && (!previousIds.length || previousIds.some(id => !selectedIds.includes(id)));
        if ((!member.enabled && isActive(existing.activo) || narrower) && await futureReservations(Number(existing.id), transaction)) {
          throw error('review_required', 'Hay citas futuras en esa ficha. Revisa sus asignaciones antes de quitar la clínica o restringir los profesionales.');
        }
      } else if (member.clinic_id !== current.principalId && member.enabled) {
        if (!Number(current.clinic.grupoClinicaId) || current.clinics.length < 2) {
          throw error('invalid', 'La instalación sólo puede compartirse dentro de un grupo de clínicas.', 400);
        }
        if (member.installation_id !== null) {
          const candidate = current.rooms.find(room => Number(room.id) === member.installation_id && Number(room.clinica_id) === member.clinic_id);
          if (!candidate || current.aliases.some(alias => Number(alias.installation_id) === member.installation_id
            || Number(alias.canonical_installation_id) === member.installation_id)) {
            throw error('invalid', 'Selecciona una instalación libre de otra clínica o crea su ficha compartida.', 400);
          }
          additions.push({ member, room: candidate });
        } else additions.push({ member, room: null });
      } else if (!existing && member.installation_id !== null && member.clinic_id !== current.principalId) {
        throw error('invalid', 'No puedes desactivar una instalación que todavía no está vinculada.', 400);
      }
    }
    if (additions.length && enabled() !== true) throw error('runtime_required',
      'La reserva de salas físicas compartidas debe estar habilitada antes de vincular otra instalación.');
    return additions;
  }

  async function save({ installationId = null, clinicId = null, sharing, mutate }) {
    const request = normalizeSharingRequest(sharing);
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const initial = await scope({ installationId, clinicId, transaction });
      // Booking writers take a SHARE lock on their clinic before reading alias
      // identity. Lock all group clinics in ascending order first: no writer
      // can carry an old physical key across this configuration commit.
      for (const id of numeric(initial.peers.map(row => row.id_clinica))) {
        await db.Clinica.findByPk(id, { attributes: ['id_clinica'], transaction, lock: transaction.LOCK.UPDATE });
      }
      const current = await state({ installationId, clinicId, transaction });
      const additions = await validatePlan(current, request, transaction);
      const keys = [ ...(current.room ? [`installation:${canonicalId(current.room.id, current.aliases)}`] : []),
        ...additions.filter(addition => addition.room).map(addition => `installation:${addition.room.id}`) ];
      if (enabled()) await lockResources({ db, resourceKeys: keys, transaction });
      for (const addition of additions) if (addition.room) await assertLinkable(addition.room, transaction);

      const write = async tx => {
        const result = await mutate(tx);
        const root = await db.Instalacion.findByPk(installationId || Number(plain(result)?.id), { transaction: tx });
        if (!root || Number(root.clinica_id) !== current.principalId) throw error('invalid', 'La ficha de la instalación no coincide con la clínica.', 400);
        const canonical = current.room ? canonicalId(current.room.id, current.aliases) : Number(root.id);
        const physical = Number(root.id) === canonical ? root : await db.Instalacion.findByPk(canonical, { transaction: tx });
        if (!physical) throw error('review_required', 'No se encuentra la referencia física de la instalación.');
        for (const member of request.memberships) {
          let target = current.members.find(room => Number(room.clinica_id) === member.clinic_id);
          if (member.clinic_id === current.principalId) target = root;
          const addition = additions.find(addition => addition.member.clinic_id === member.clinic_id);
          if (addition) {
            if (addition.room) target = await db.Instalacion.findByPk(Number(addition.room.id), { transaction: tx, lock: tx.LOCK.UPDATE });
            else {
              const source = plain(root);
              const { id, clinica_id, created_at, updated_at, createdAt, updatedAt, ...fields } = source;
              // Copy the room's configuration, not the clinic's configuration
              // or staff membership. Initial use hours come from the new clinic.
              target = await db.Instalacion.create({ ...fields, clinica_id: member.clinic_id,
                profesionales_permitidos: [], activo: true }, { transaction: tx });
              const hours = await db.ClinicaHorario.findAll({ where: { clinica_id: member.clinic_id }, transaction: tx });
              if (hours.length) await db.InstalacionHorario.bulkCreate(hours.map(row => ({
                instalacion_id: Number(target.id), dia_semana: Number(row.dia_semana), activo: isActive(row.activo),
                hora_inicio: row.hora_inicio, hora_fin: row.hora_fin,
              })), { transaction: tx });
            }
            await db.InstallationPhysicalAlias.create({ installation_id: Number(target.id),
              canonical_installation_id: canonical, group_id: Number(current.clinic.grupoClinicaId) }, { transaction: tx });
          }
          if (!target) continue; // Unselected, unlinked clinic: no implicit write.
          if (typeof target.update !== 'function') target = await db.Instalacion.findByPk(Number(target.id), { transaction: tx, lock: tx.LOCK.UPDATE });
          const ids = member.professional_mode === 'all' ? [] : member.professional_ids;
          const changes = { activo: member.enabled, profesionales_permitidos: ids };
          if (addition) Object.assign(changes, { capacidad: Number(physical.capacidad),
            allow_overlap_confirmation: isActive(physical.allow_overlap_confirmation),
            overlap_capacity_unlimited: isActive(physical.overlap_capacity_unlimited) });
          await target.update(changes, { transaction: tx });
        }
        return result;
      };
      const result = current.room ? await calendarMutation({ db, installationId, transaction, enabled: enabled(), mutate: write }) : await write(transaction);
      if (realtimeEnabled) transaction.afterCommit(async () => {
        for (const clinicId of numeric(request.memberships.map(member => member.clinic_id))) {
          try { await notify({ db, clinicId }); }
          catch (_) { console.warn('[availability-realtime] installation_sharing_refresh_failed'); }
        }
      });
      return result;
    });
  }

  return { context, save };
}

/** Names/IDs in the extra list column are restricted independently of the list's
 * selected clinic. Never disclose a peer for which settings.view is denied.
 */
async function installationSharingListMetadata({ db, items, aliases, accessibleClinicIds }) {
  const { Op } = db.Sequelize;
  const roots = numeric(items.map(room => canonicalId(room.id, aliases)));
  // A single-clinic read may start from a non-canonical member. Complete the
  // physical set in one batch so a third authorized clinic is not omitted.
  const attached = roots.length && db.InstallationPhysicalAlias ? await db.InstallationPhysicalAlias.findAll({
    where: { canonical_installation_id: { [Op.in]: roots } },
    attributes: ['installation_id', 'canonical_installation_id', 'group_id'], raw: true,
  }) : [];
  const completeAliases = [...new Map([...aliases, ...attached].map(row => [Number(row.installation_id), row])).values()];
  const allIds = numeric([...roots, ...completeAliases.filter(alias => roots.includes(Number(alias.canonical_installation_id)))
    .map(alias => alias.installation_id)]);
  const members = allIds.length ? await db.Instalacion.findAll({ where: { id: { [Op.in]: allIds },
    clinica_id: { [Op.in]: accessibleClinicIds } }, attributes: ['id', 'clinica_id', 'activo'],
    include: [{ model: db.Clinica, as: 'clinica', attributes: ['nombre_clinica'] }], raw: false }) : [];
  const result = {};
  for (const room of items) {
    const canonical = canonicalId(room.id, aliases);
    result[room.id] = members.filter(member => canonicalId(member.id, completeAliases) === canonical).map(member => ({
      clinic_id: Number(member.clinica_id), name: String(member.clinica?.nombre_clinica || ''), enabled: isActive(member.activo),
    })).sort((a, b) => a.clinic_id - b.clinic_id);
  }
  return result;
}

module.exports = { normalizeSharingRequest, canonicalId, physicalMembers, createInstallationPhysicalSharingService, installationSharingListMetadata };
