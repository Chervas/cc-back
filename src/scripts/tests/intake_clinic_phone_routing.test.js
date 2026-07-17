'use strict';

const assert = require('node:assert/strict');
const { matchClinicByContactPhone } = require('../../lib/intake-clinic-phone-routing');

const clinics = [
  {
    id_clinica: 59,
    estado_clinica: true,
    telefono: '618 25 55 31',
    telefono_fijo: null,
    telefono_movil: '+34 618 25 55 31',
    telefono_whatsapp: null,
  },
  {
    id_clinica: 60,
    estado_clinica: true,
    telefono_fijo: '934 00 00 60',
    telefono_whatsapp: '624 31 25 83',
  },
];

assert.equal(
  matchClinicByContactPhone({ phone: '618255531', clinics })?.id_clinica,
  59,
  'all fixed/mobile/legacy clinic contact fields must be routable',
);

assert.equal(
  matchClinicByContactPhone({
    phone: '+34 611 22 33 44',
    clinics,
    clinicPhoneAssets: [{
      clinicaId: 59,
      assignmentScope: 'clinic',
      additionalData: { displayPhoneNumber: '+34 611 22 33 44' },
    }],
  })?.id_clinica,
  59,
  'a clinic-assigned Meta phone must route to that clinic',
);

assert.equal(
  matchClinicByContactPhone({
    phone: '+34 699 00 00 59',
    clinics,
    configRecord: {
      config: { locations: [{ id: 59, phone_aliases: ['+34 699 00 00 59'] }] },
    },
  })?.id_clinica,
  59,
  'explicit location aliases must be routable',
);

assert.equal(
  matchClinicByContactPhone({
    phone: '+34 624 31 25 83',
    clinics: clinics.map((clinic) => ({ ...clinic, telefono_whatsapp: '624 31 25 83' })),
  }),
  null,
  'a shared number collision must not be assigned to the first clinic',
);

assert.equal(
  matchClinicByContactPhone({
    phone: '+34 611 22 33 44',
    clinics,
    clinicPhoneAssets: [{
      clinicaId: 59,
      assignmentScope: 'group',
      metaAssetName: '+34 611 22 33 44',
    }],
  }),
  null,
  'group-level Meta phones cannot identify one clinic',
);

assert.equal(
  matchClinicByContactPhone({
    phone: '618 25 55 31',
    clinics,
    allowedClinicIds: [60],
  }),
  null,
  'routing must respect the configured clinic scope',
);

console.log('intake_clinic_phone_routing.test.js OK');
