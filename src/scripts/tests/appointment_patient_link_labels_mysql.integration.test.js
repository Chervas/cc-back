'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedBookingDurationFixture } = require('./helpers/owned-booking-duration-fixture');
test('native SQL linked-member projection names treatments outside the loaded page without writes or provider access',
  { skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
    await withIsolatedCampaignMysql(async ({ sql, models: db, report, registerOwnedLoopbackServer }) => {
      const fixture = await createOwnedBookingDurationFixture({ sql, models: db, registerOwnedLoopbackServer });
      try {
      await require('../../../migrations/20261007170000-create-appointment-patient-links').up(sql.getQueryInterface(), S);
      db.AppointmentPatientLink = require('../../../models/appointmentpatientlink')(sql, S.DataTypes);
      db.AppointmentPatientLinkMember = require('../../../models/appointmentpatientlinkmember')(sql, S.DataTypes);
      const owner = await db.CitaPaciente.create(fixture.values({ tratamiento_id: 4 }));
      const follower = await db.CitaPaciente.create(fixture.values({ tratamiento_id: 5,
        inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' }));
      const link = await db.AppointmentPatientLink.create({ id: 'synthetic-label-link', clinic_id: 100, patient_id: 1,
        owner_appointment_id: owner.id_cita, created_by: 1 });
      await db.AppointmentPatientLinkMember.bulkCreate([owner, follower].map(row => ({ appointment_id: row.id_cita, link_id: link.id })));
      const fingerprint = async () => JSON.stringify({ appointments: await db.CitaPaciente.findAll({ raw: true, order: [['id_cita', 'ASC']] }),
        links: await db.AppointmentPatientLink.findAll({ raw: true }), members: await db.AppointmentPatientLinkMember.findAll({ raw: true, order: [['appointment_id', 'ASC']] }) });
      const before = await fingerprint();
      const originalFindAll = db.Tratamiento.findAll.bind(db.Tratamiento); let catalogueReads = 0;
      db.Tratamiento.findAll = (...args) => { catalogueReads++; return originalFindAll(...args); };
      try {
        const loaded = [await db.CitaPaciente.findByPk(follower.id_cita)];
        await require('../../services/appointmentPatientLinks.service').decorate(db, loaded);
        const projection = loaded[0].getDataValue('appointment_link');
        assert.equal(projection.index, 2); assert.equal(projection.count, 2);
        assert.deepEqual(projection.members.map(member => member.treatment_name), ['Tratamiento sintético 4', 'Tratamiento sintético 5']);
        assert.equal(catalogueReads, 1, 'One batched catalogue read, including the owner outside this page');
        assert.equal(await fingerprint(), before, 'Projection must not persist a change');
        report.checks.push('Actual SQL projects both linked treatment names from one loaded follower, one batch catalogue query, no persistent changes');
      } finally { db.Tratamiento.findAll = originalFindAll; }
      } finally { await fixture.close(); }
    });
  });
