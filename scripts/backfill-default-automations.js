/* eslint-disable no-console */
'use strict';

require('dotenv').config();
const db = require('../models');
const automationDefaultsService = require('../src/services/automationDefaults.service');

async function run() {
  try {
    const clinics = await db.Clinica.findAll({
      attributes: ['id_clinica'],
      raw: true,
    });

    for (const clinic of clinics) {
      await automationDefaultsService.createDefaultAutomationsForClinic({
        clinicId: clinic.id_clinica,
      });
    }

    console.log(`Backfill completado para ${clinics.length} clínicas`);
  } catch (err) {
    console.error('Error en backfill-default-automations', err);
    process.exitCode = 1;
  } finally {
    await db.sequelize.close();
  }
}

run();
