'use strict';

// Documentary preparation only. No IDs, SQL, activation or appointment writes.
// Confirmed by the requester on 2026-09-22: one physical unit each, three mobile
// machines; C9 (presotherapy) and C10 (carboxytherapy) cannot receive mobile units.
const bsEquipmentBlueprint = Object.freeze({
  version: 1,
  confirmed_on: '2026-09-22',
  units_per_equipment: 1,
  mobile_equipment: [
    { name: 'EXION', family_key: 'exion', aliases: [], mobility: 'mobile' },
    { name: 'EMShape PRO', family_key: 'emshape', aliases: ['EMS', 'EMShape'], mobility: 'mobile' },
    { name: 'Ondas de choque BTL', family_key: 'btl_shockwave', aliases: ['Ondas acústicas BTL', 'Ondas de choque'], mobility: 'mobile' },
  ],
  // Only locations corroborated by the written cabin map AND the later
  // clarification that all equipment except the three above remains fixed.
  // Home codes describe physical rooms, never a second unit per clinic alias.
  fixed_equipment: [
    { name: 'Cyclone', family_key: 'cyclone', aliases: [], mobility: 'fixed', home_room: 'C11' },
    { name: 'BTL Lymphastim', family_key: 'btl_lymphastim', aliases: ['Lymphastim', 'Presoterapia'], mobility: 'fixed', home_room: 'C9' },
    { name: 'Equipo de carboxiterapia', family_key: 'carboxytherapy', aliases: ['Carbo'], mobility: 'fixed', home_room: 'C10' },
  ],
  mobile_prohibited_rooms: ['C9', 'C10'],
  other_documented_cabins_allow_mobile: true,
  external_hospital_included: false,
  reminders_enabled: false,
  pending: ['Confirmar margen de traslado/preparación antes de habilitar reservas consecutivas.',
    'Completar las restantes unidades fijas con ubicación confirmada, distinguiendo modelos INDIBA.',
    'Conciliar reservas existentes antes de activar requisitos de maquinaria.'],
});
module.exports = { bsEquipmentBlueprint };
