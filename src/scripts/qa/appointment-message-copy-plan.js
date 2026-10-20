#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { planEntry, hash } = require('../../lib/appointment-copy-publication');
const { updateAppointmentCatalog } = require('../../lib/appointment-message-copy');

async function main() {
  const [target, out] = process.argv.slice(2);
  if (!['crm', 'dev'].includes(target) || !path.isAbsolute(out || '') || !out.startsWith('/home/ubuntu/secure-imports/')
    || fs.existsSync(out) || (fs.statSync(path.dirname(out)).mode & 0o077)) throw Error('private_new_plan_required');
  const c = await require('../../lib/cliniccloud-import/operator-database').connectOperatorDatabase(target);
  try {
    await c.query('START TRANSACTION READ ONLY');
    const [flows] = await c.query('SELECT * FROM AutomationFlowTemplatesV2 WHERE published_at IS NOT NULL ORDER BY version DESC,id DESC');
    const latest = new Map();
    for (const row of flows) {
      for (const key of ['nodes', 'trigger_config']) if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
      const key = JSON.stringify([row.public_id, row.template_key, row.clinic_id, row.group_id]);
      if (!latest.has(key)) latest.set(key, { ...row, is_system: !!row.is_system, is_active: !!row.is_active });
    }
    const entries = [...latest.values()].map(planEntry).filter(Boolean);
    const [catalogs] = await c.query('SELECT * FROM WhatsappTemplateCatalog ORDER BY locale="es" DESC,id');
    const [templates] = await c.query('SELECT id,name,language,status,components,variables,catalog_template_id,clinic_id,waba_id,is_active,last_synced_at FROM WhatsappTemplates');
    const lookup = { templates, catalogs };
    for (const row of [...templates, ...catalogs]) for (const key of ['components', 'variables']) if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
    for (const template of templates) template.catalog = catalogs.find(catalog => Number(catalog.id) === Number(template.catalog_template_id)) || null;
    const [clinics] = await c.query('SELECT id_clinica,nombre_clinica,direccion,url_ficha_local,configuracion FROM Clinicas');
    const [locations] = await c.query('SELECT id,clinica_id,location_name,location_id,raw_payload FROM ClinicBusinessLocations WHERE is_active=1 ORDER BY last_synced_at DESC,updated_at DESC');
    for (const row of [...clinics, ...locations]) for (const key of ['raw_payload', 'configuracion']) if (typeof row[key] === 'string') row[key] = JSON.parse(row[key]);
    const localLinks = require('../tests/fixtures/business_profile_flow_runtime.fixture').loadSource('googleLocalLinks.service', {
      '../../models': { ClinicBusinessLocation: { findOne: async ({ where }) => locations.find(row => Number(row.clinica_id) === Number(where.clinica_id)) || null } } });
    const clinicLinks = {};
    for (const clinic of clinics) clinicLinks[clinic.id_clinica] = { ...await localLinks.resolveClinicGoogleLocalLinks(clinic),
      timezone: require('../tests/fixtures/business_profile_flow_runtime.fixture').loadSource('clinicOpeningHours.service', { '../../models': {} }).resolveClinicTimeZone(clinic) };
    const catalogPlan = catalogs.filter(row => [20,78,79,28,29,30,92,93,94,95,96,97].includes(Number(row.id)))
      .map(source => ({ source, next: updateAppointmentCatalog(source), source_hash: hash(source) }))
      .filter(entry => hash(entry.source.body_text) !== hash(entry.next.body_text));
    const plan = { version: 1, target, read_only: true, at: new Date().toISOString(), entries, catalogPlan, lookup, clinicLinks };
    fs.writeFileSync(out, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ target, flows: entries.length, active: entries.filter(e => e.source.is_active).length,
      catalogs: catalogPlan.length, unchangedLatest: latest.size - entries.length }));
  } finally { await c.rollback(); await c.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
