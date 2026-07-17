'use strict';

const assert = require('node:assert/strict');
const { buildClinicWhatsappContactProjection } = require('../../lib/clinic-whatsapp-contact');

const hospitalet = buildClinicWhatsappContactProjection({
  manualPhone: '+34 618 25 55 31',
  connected: {
    phone: '+34 624 31 25 83',
    scope: 'group',
    asset: { waVerifiedName: 'Atención al paciente de Propdental', quality_rating: 'GREEN' },
  },
});
assert.equal(hospitalet.telefono_whatsapp_efectivo, '34618255531');
assert.equal(hospitalet.telefono_whatsapp_conectado, '34624312583');
assert.equal(hospitalet.whatsapp_public_source, 'clinic_manual');
assert.equal(hospitalet.whatsapp_public_differs_from_sender, true);
assert.equal(hospitalet.whatsapp_verified_name, 'Atención al paciente de Propdental');

const ownMeta = buildClinicWhatsappContactProjection({
  manualPhone: '+34 600 00 00 00',
  connected: { phone: '+34 611 11 11 11', scope: 'clinic' },
});
assert.equal(ownMeta.telefono_whatsapp_efectivo, '34611111111');
assert.equal(ownMeta.whatsapp_public_source, 'clinic_meta');

const inheritedOnly = buildClinicWhatsappContactProjection({
  connected: { phone: '+34 624 31 25 83', scope: 'group' },
});
assert.equal(inheritedOnly.telefono_whatsapp_efectivo, '34624312583');
assert.equal(inheritedOnly.whatsapp_public_source, 'group_meta');

console.log('clinic_whatsapp_contact.test.js OK');
