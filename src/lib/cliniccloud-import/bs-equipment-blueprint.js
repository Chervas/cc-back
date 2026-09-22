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
  mobile_prohibited_rooms: ['C9', 'C10'],
  other_documented_cabins_allow_mobile: true,
  external_hospital_included: false,
  reminders_enabled: false,
  pending: ['Confirmar margen de traslado/preparación antes de habilitar reservas consecutivas.',
    'Vincular cada unidad fija a su ubicación confirmada, distinguiendo modelos INDIBA.',
    'Conciliar reservas existentes antes de activar requisitos de maquinaria.'],
});
module.exports = { bsEquipmentBlueprint };
