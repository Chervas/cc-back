'use strict';

// Documentary preparation only. No IDs, SQL, activation or appointment writes.
// Confirmed by the requester on 2026-09-22: one physical unit each, three mobile
// machines; C9 (presotherapy) and C10 (carboxytherapy) cannot receive mobile units.
const bsEquipmentBlueprint = Object.freeze({
  version: 2,
  confirmed_on: '2026-09-25',
  units_per_equipment: 1,
  turnaround_minutes: 0,
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
    { name: 'INDIBA ONA', family_key: 'indiba_ona', aliases: [], mobility: 'fixed', home_room: 'C8' },
    { name: 'INDIBA corporal, facial y capilar', family_key: 'indiba_rf', aliases: ['INDIBA PREMIUM NS'], mobility: 'fixed', home_room: 'C12' },
  ],
  mobile_prohibited_rooms: ['C9', 'C10'],
  other_documented_cabins_allow_mobile: true,
  external_hospital_included: false,
  reminders_enabled: false,
  pending: ['Completar las restantes unidades fijas con ubicación confirmada.',
    'Conciliar reservas existentes antes de activar requisitos de maquinaria.'],
});
module.exports = { bsEquipmentBlueprint };
