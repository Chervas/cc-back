'use strict';

const db = require('../../models');
const { usesClinicDirections, directionsReadiness } = require('../lib/automation-directions-readiness');
const { buildLinksFromBusinessLocation } = require('./googleLocalLinks.service');

async function forTemplates(rows, models = db) {
  const items = rows.map(row => row.toJSON ? row.toJSON() : row);
  const ids = [...new Set(items.filter(usesClinicDirections).map(row => Number(row.clinic_id)).filter(id => id > 0))];
  const result = new Map();
  if (!ids.length) return result;
  const [clinics, locations] = await Promise.all([
    models.Clinica.findAll({ where: { id_clinica: ids }, attributes: ['id_clinica', 'direccion'], raw: true }),
    models.ClinicBusinessLocation.findAll({ where: { clinica_id: ids, is_active: true },
      attributes: ['id', 'clinica_id', 'location_name', 'location_id', 'raw_payload'],
      order: [['last_synced_at', 'DESC'], ['updated_at', 'DESC']], raw: true }),
  ]);
  for (const id of ids) {
    const clinic = clinics.find(row => Number(row.id_clinica) === id);
    const location = locations.find(row => Number(row.clinica_id) === id);
    const links = location ? buildLinksFromBusinessLocation(location, clinic) : {};
    result.set(id, directionsReadiness(clinic, location, links));
  }
  return result;
}

function decorate(mapped, row, states) {
  const item = row?.toJSON ? row.toJSON() : row;
  if (!item.clinic_id || !usesClinicDirections(item)) return mapped;
  return { ...mapped, directions_readiness: states.get(Number(item.clinic_id))
    || { status: 'warning', reason: 'configuration_unavailable' } };
}

module.exports = { forTemplates, decorate };
