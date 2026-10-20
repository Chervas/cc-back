'use strict';

// Preserve the appointment API while using the same canonical clinical row as
// the patient workspace. No report copying or historical narrative backfill.
const db = require('../../models');
const { createClinicalEpisodeService } = require('./clinicalEpisodes.service');
const { error: domainError } = require('../lib/clinical-episode-contract');
const service = () => createClinicalEpisodeService({ db });
module.exports = {
  domainError,
  getByAppointment: (...args) => service().getLegacy(...args),
  listForPatient: (...args) => service().listLegacy(...args),
  save: (...args) => service().saveLegacy(...args),
};
