'use strict';
const PATIENT_READ_ACTIONS = Object.freeze(['patient.list', 'patient.search', 'patient.contact_targets', 'patient.duplicate_check',
  'patient.legacy_consents.read', 'patient.detail.read', 'patient.activity.read']);
const MAX_CLINICS = 100; const IDS_PER_EVENT = 100; const MAX_PATIENTS = 10000;
const positive = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647;
module.exports = { PATIENT_READ_ACTIONS, MAX_CLINICS, IDS_PER_EVENT, MAX_PATIENTS, positive };
