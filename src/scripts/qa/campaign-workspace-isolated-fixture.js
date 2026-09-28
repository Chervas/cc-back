'use strict';

// Temporary SQL-only fixture for authenticated DEV QA. Never boot the app/models,
// create credentials, attest web installation, or enable any integration/worker.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const MARKER = 'campaign-qa-isolated-20260928';
const ACCOUNT = '9999900928';
const TABLES = Object.freeze({ GoogleConnections: 'id', ClinicGoogleAdsAccounts: 'id', ExternalCampaignInventories: 'id',
  GoogleAdsInsightsDaily: 'id', GoogleAdsAdInventory: 'id', GoogleAdsAdInsightsDaily: 'id', GoogleAdsAdSyncDays: 'id',
  LeadIntakes: 'id', Pacientes: 'id_paciente', CitasPacientes: 'id_cita', EconomicBudgets: 'id',
  CampaignWorkspaceSettings: 'id', CampaignWorkspaceEvents: 'id' });
const DRAFT_TABLES = ['CampaignWorkspaceSettings', 'CampaignWorkspaceEvents'];
const CLOSED = ['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'JOBS_AUTO_START', 'CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED',
  'CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED', 'CAMPAIGN_GOOGLE_LEAD_SYNC_ENABLED', 'CAMPAIGN_OPTIMIZATION_ENABLED',
  'CAMPAIGN_PUBLISH_ENABLED', 'CAMPAIGN_AUTOPILOT_ENABLED'];
const REQUIRED_FALSE = ['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER'];
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = row => createHash('sha256').update(JSON.stringify(stable(row))).digest('hex');
const sqlTime = date => date.toISOString().slice(0, 19).replace('T', ' ');

function assertClosed(env) {
  for (const key of CLOSED) assert.ok(env[key] === undefined || ['false', '0'].includes(env[key]), 'BUSINESS_GATE_NOT_CLOSED:' + key);
  for (const key of REQUIRED_FALSE) assert.equal(env[key], 'false', 'BUSINESS_WORKER_NOT_EXPLICITLY_STOPPED:' + key);
}

function runtimeSafety() {
  const pid = execFileSync('systemctl', ['show', 'clinicaclick-back-dev.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  assert.match(pid, /^[1-9][0-9]*$/, 'ISOLATED_DEV_SERVICE_REQUIRED');
  // Return only gate booleans, never the rest of the protected process environment.
  const script = `const fs=require('fs'); const env=Object.fromEntries(fs.readFileSync('/proc/${pid}/environ','utf8').split('\\0').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)]})); const keys=${JSON.stringify(CLOSED)}; console.log(JSON.stringify(Object.fromEntries(keys.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]))))`;
  assertClosed(JSON.parse(execFileSync('sudo', ['-n', '/usr/bin/node', '-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
}

function manifestPath(filename) {
  assert.ok(typeof filename === 'string' && /^\/tmp\/cc-campaign-fixture-[a-z0-9-]+\/manifest\.json$/i.test(filename), 'PRIVATE_FIXTURE_PATH_REQUIRED');
  const directory = path.dirname(filename); const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid(), 'PRIVATE_FIXTURE_DIRECTORY_REQUIRED');
  return filename;
}

async function assertDatabase(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db, CURRENT_USER() db_user');
  assert.equal(identity.db, 'clinicaclick_dev_isolated');
  assert.equal(identity.db_user, 'cc_dev_api@localhost');
  const [[clinic]] = await connection.query('SELECT nombre_clinica FROM Clinicas WHERE id_clinica=1');
  assert.equal(clinic?.nombre_clinica, 'Clinica ficticia DEV');
}

function daysBefore(now, days) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return new Date(Date.parse(today + 'T12:00:00Z') - days * 86400000).toISOString().slice(0, 10);
}

async function seed(connection, filename, now = new Date(), scenario = 'standard') {
  assert.ok(['standard', 'report'].includes(scenario), 'UNKNOWN_FIXTURE_SCENARIO');
  const fd = fs.openSync(filename, 'wx', 0o600);
  const manifest = { version: 1, marker: MARKER, account: ACCOUNT, scenario, createdAt: now.toISOString(), state: 'preparing', rows: [] };
  const persist = () => { const data = JSON.stringify(manifest, null, 2); fs.ftruncateSync(fd); fs.writeSync(fd, data, 0, 'utf8'); fs.fsyncSync(fd); };
  const observed = sqlTime(now); let committed = false;
  try {
    persist(); await connection.beginTransaction(); await assertDatabase(connection);
    for (const table of ['ClinicGoogleAdsAccounts', 'GoogleConnections', 'ExternalCampaignInventories', 'LeadIntakes', 'CampaignWorkspaceSettings']) {
      const [[row]] = await connection.query('SELECT COUNT(*) n FROM ??', [table]);
      assert.equal(row.n, 0, 'FIXTURE_REQUIRES_EMPTY_DEV_CAMPAIGN_DATA:' + table);
    }
    const insert = async (table, row) => {
      assert.ok(Object.hasOwn(TABLES, table));
      const [result] = await connection.query('INSERT INTO ?? SET ?', [table, row]);
      const [[saved]] = await connection.query('SELECT * FROM ?? WHERE ??=?', [table, TABLES[table], result.insertId]);
      manifest.rows.push({ table, id: result.insertId, hash: digest(saved) });
      return result.insertId;
    };
    const connectionId = await insert('GoogleConnections', { googleUserId: MARKER, userName: 'QA FICTICIA - SIN CREDENCIALES',
      accessToken: null, refreshToken: null, scopes: null, userId: null });
    const mapping = await insert('ClinicGoogleAdsAccounts', { clinicaId: 1, googleConnectionId: connectionId, customerId: ACCOUNT,
      descriptiveName: 'QA FICTICIA - DEV aislado', currencyCode: 'EUR', timeZone: 'Europe/Madrid', isActive: 1,
      lastSyncedAt: observed, broker_read_connection_ref: null, broker_read_asset_ref: null });
    const campaigns = [
      { id: '999990092801', name: 'QA FICTICIA - Primera visita', cost: 10, previous: 5, state: 'ENABLED' },
      { id: '999990092802', name: 'QA FICTICIA - Sin nuevos leads', cost: 4, previous: 4, state: 'ENABLED' },
      { id: '999990092803', name: 'QA FICTICIA - En pausa', cost: 0, previous: 0, state: 'PAUSED' },
    ];
    if (scenario === 'report') for (let number = 4; number <= 15; number++) campaigns.push({
      id: ACCOUNT + String(number).padStart(2, '0'), name: 'QA FICTICIA - Inventario ' + String(number).padStart(2, '0'),
      state: number % 2 ? 'ENABLED' : 'PAUSED', inventoryOnly: true,
    });
    const timestamps = { created_at: observed, updated_at: observed };
    for (const campaign of campaigns) {
      await insert('ExternalCampaignInventories', { provider: 'google_ads', customer_id: ACCOUNT, campaign_id: campaign.id,
        campaign_name: campaign.name, account_name: 'QA FICTICIA - DEV aislado', status: campaign.state, channel_type: 'SEARCH',
        source: MARKER, last_seen_at: observed, destination_detection: JSON.stringify({ kind: 'web', urls: ['https://campaign-qa.invalid/primera-visita'], fixture: MARKER }) });
      // Additional inventory has no observed investment; the UI must not invent zeros.
      if (campaign.inventoryOnly) continue;
      for (let ad = 1; ad <= 2; ad++) {
        await insert('GoogleAdsAdInventory', { clinicGoogleAdsAccountId: mapping, customerId: ACCOUNT, campaignId: campaign.id,
          campaignName: campaign.name, campaignStatus: campaign.state, adGroupId: campaign.id + '1', adGroupName: 'QA FICTICIA - Grupo',
          adGroupStatus: 'ENABLED', adId: campaign.id + String(ad), adName: 'QA FICTICIA - Anuncio ' + ad,
          adType: 'RESPONSIVE_SEARCH_AD', adStatus: 'ENABLED', present: 1, observedAt: observed,
          finalUrl: 'https://campaign-qa.invalid/primera-visita', displayUrl: 'campaign-qa.invalid',
          headlines: JSON.stringify(['QA FICTICIA - Primera visita', 'Clinica de prueba']),
          descriptions: JSON.stringify(['Contenido ficticio para validar la interfaz.']),
          // Missing policy evidence intentionally remains unknown, never fake approval.
          deliveryObservation: null, ...timestamps });
      }
      for (let day = 1; day <= 60; day++) {
        const date = daysBefore(now, day); const cost = day <= 30 ? campaign.cost : campaign.previous;
        await insert('GoogleAdsInsightsDaily', { clinicGoogleAdsAccountId: mapping, clinicaId: 1, customerId: ACCOUNT,
          campaignId: campaign.id, campaignName: campaign.name, campaignStatus: campaign.state, date,
          network: 'SEARCH', device: 'MOBILE', costMicros: cost * 1e6, impressions: cost * 100, clicks: cost * 4,
          conversions: cost, ...timestamps });
        for (let ad = 1; ad <= 2; ad++) await insert('GoogleAdsAdInsightsDaily', {
          clinicGoogleAdsAccountId: mapping, clinicaId: 1, customerId: ACCOUNT, campaignId: campaign.id,
          campaignName: campaign.name, campaignStatus: campaign.state, adGroupId: campaign.id + '1', adId: campaign.id + String(ad),
          date, network: 'SEARCH', device: 'MOBILE', costMicros: cost * 5e5, observedAt: observed, ...timestamps,
        });
      }
    }
    for (let day = 1; day <= 60; day++) {
      const date = daysBefore(now, day);
      await insert('GoogleAdsAdSyncDays', { clinicGoogleAdsAccountId: mapping, customerId: ACCOUNT, campaignId: '', date,
        observedAt: observed, ...timestamps });
      for (let n = 0; n < (day <= 30 ? 1 : 2); n++) {
        const lead = await insert('LeadIntakes', { clinica_id: 1, source: 'google_ads', channel: 'paid',
          nombre: 'QA FICTICIA - Contacto sin datos personales', external_source: MARKER, external_id: `${day}-${n}`,
          google_ads_customer_id: ACCOUNT, google_ads_campaign_id: campaigns[0].id,
          consentimiento_canal: JSON.stringify({ marketing: false }), created_at: date + ' 09:00:00', updated_at: date + ' 09:00:00' });
        if (n === 0 && [3, 33].includes(day)) {
          const patient = await insert('Pacientes', { public_id: MARKER + '-' + day, nombre: 'QA FICTICIA', apellidos: 'Sin datos personales', clinica_id: 1 });
          await insert('CitasPacientes', { clinica_id: 1, paciente_id: patient, lead_intake_id: lead,
            source_system: MARKER, source_reference: String(day), titulo: 'QA FICTICIA - Cita', estado: 'completada',
            inicio: date + ' 10:00:00', fin: date + ' 10:30:00', created_at: date + ' 09:30:00', updated_at: date + ' 09:30:00' });
          await insert('EconomicBudgets', { public_id: MARKER + '-' + day, clinic_id: 1, patient_id: patient,
            number: 'QA-FICTICIA-' + day, source_system: MARKER, source_reference: String(day), status: 'accepted',
            accepted_amount: day === 3 ? 1200 : 800, responded_at: date + ' 11:00:00' });
        }
      }
    }
    manifest.state = 'ready-to-commit'; persist();
    await connection.commit(); committed = true;
    manifest.state = 'seeded'; persist();
    return { state: manifest.state, rows: manifest.rows.length, campaigns: campaigns.length };
  } catch (error) {
    if (!committed) { await connection.rollback(); manifest.state = 'rolled-back'; persist(); }
    throw error;
  } finally { fs.closeSync(fd); }
}

async function cleanup(connection, filename) {
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid());
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(manifest.version, 1); assert.equal(manifest.marker, MARKER); assert.equal(manifest.account, ACCOUNT);
  assert.ok(['seeded', 'ready-to-commit'].includes(manifest.state), 'FIXTURE_NOT_SEEDED');
  await connection.beginTransaction();
  try {
    await assertDatabase(connection);
    for (const row of manifest.rows) {
      assert.ok(Object.hasOwn(TABLES, row.table) && (DRAFT_TABLES.includes(row.table)
        ? /^[a-f0-9-]{36}$/.test(row.id) : Number.isSafeInteger(row.id) && row.id > 0));
      const [[current]] = await connection.query('SELECT * FROM ?? WHERE ??=? FOR UPDATE', [row.table, TABLES[row.table], row.id]);
      assert.ok(current && digest(current) === row.hash, 'FIXTURE_ROW_CHANGED:' + row.table + ':' + row.id);
    }
    const [references] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IN (?)`, [Object.keys(TABLES)]);
    for (const reference of references) {
      const parents = manifest.rows.filter(row => row.table === reference.REFERENCED_TABLE_NAME).map(row => row.id);
      if (!parents.length) continue;
      const children = manifest.rows.filter(row => row.table === reference.TABLE_NAME).map(row => row.id);
      const params = [reference.TABLE_NAME, reference.COLUMN_NAME, parents];
      let sql = 'SELECT COUNT(*) n FROM ?? WHERE ?? IN (?)';
      if (children.length) { sql += ' AND ?? NOT IN (?)'; params.push(TABLES[reference.TABLE_NAME], children); }
      const [[result]] = await connection.query(sql, params);
      assert.equal(result.n, 0, 'FIXTURE_HAS_NEW_DEPENDANTS:' + reference.TABLE_NAME);
    }
    // Validate every fingerprint/dependant first, including cascading foreign keys.
    for (const row of [...manifest.rows].reverse()) {
      const [result] = await connection.query('DELETE FROM ?? WHERE ??=?', [row.table, TABLES[row.table], row.id]);
      assert.equal(result.affectedRows, 1);
    }
    await connection.commit();
    manifest.state = 'cleaned'; manifest.cleanedAt = new Date().toISOString();
    fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { state: 'cleaned', rows: manifest.rows.length };
  } catch (error) { await connection.rollback(); throw error; }
}

function validateDraftCapture(setting, events, startedAt) {
  const accounts = value => Array.isArray(value) && value.length <= 1 && value.every(row => row.provider === 'google_ads'
    && row.account_id === ACCOUNT && typeof row.include_future === 'boolean' && Array.isArray(row.campaign_ids)
    && row.campaign_ids.every(id => ['999990092801', '999990092802', '999990092803'].includes(id)));
  const preferences = value => value == null || ['measurement', 'optimize'].includes(value.mode)
    && value.signals?.enabled === false && value.signals.events?.length === 0
    && (value.mode === 'measurement' ? value.optimization === null
      : value.optimization?.budget_changes === false && value.optimization.monthly_limit_cents === null
        && Array.isArray(value.optimization.actions) && value.optimization.actions.every(action => ['pause_underperforming_ads', 'adjust_bids'].includes(action)));
  const afterStart = value => Number.isFinite(+new Date(value + 'Z')) && +new Date(value + 'Z') >= Math.floor(+new Date(startedAt) / 1000) * 1000;
  assert.ok(setting?.scope_type === 'clinic' && setting.scope_id === 1 && setting.updated_by_user_id === 1
    && setting.activation === null && setting.signal_preparation === null && accounts(setting.accounts)
    && preferences(setting.preferences) && afterStart(setting.created_at), 'ONLY_OWN_UNACTIVATED_DRAFT_CAN_BE_CAPTURED');
  assert.ok(events.length > 0 && events.length <= 20 && setting.version === events.length, 'INCOMPLETE_DRAFT_AUDIT');
  let previousAccounts = []; let previousPreferences = null;
  for (const [index, event] of events.entries()) {
    assert.ok(event.setting_id === setting.id && event.actor_user_id === 1 && event.version === index + 1 && afterStart(event.created_at), 'FOREIGN_DRAFT_EVENT');
    if (event.event_type === 'accounts_selected') {
      const change = event.changes?.accounts;
      assert.ok(change && accounts(change.before) && accounts(change.after) && digest(change.before) === digest(previousAccounts), 'FOREIGN_ACCOUNT_DRAFT');
      previousAccounts = change.after;
    } else {
      assert.equal(event.event_type, 'preferences_saved', 'NON_DRAFT_EVENT');
      const change = event.changes?.preferences;
      assert.ok(change && preferences(change.before) && preferences(change.after) && digest(change.before) === digest(previousPreferences), 'FOREIGN_PREFERENCE_DRAFT');
      previousPreferences = change.after;
    }
  }
  assert.equal(digest(setting.accounts), digest(previousAccounts), 'ACCOUNT_AUDIT_MISMATCH');
  assert.equal(digest(setting.preferences), digest(previousPreferences), 'PREFERENCE_AUDIT_MISMATCH');
}

async function captureDrafts(connection, filename) {
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077) && stat.uid === process.getuid());
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(manifest.marker, MARKER); assert.equal(manifest.account, ACCOUNT); assert.equal(manifest.state, 'seeded');
  assert.ok(!manifest.rows.some(row => DRAFT_TABLES.includes(row.table)), 'DRAFTS_ALREADY_CAPTURED');
  await connection.query('SET TRANSACTION READ ONLY'); await connection.beginTransaction();
  try {
    await assertDatabase(connection);
    const mapping = manifest.rows.find(row => row.table === 'ClinicGoogleAdsAccounts');
    assert.ok(mapping);
    const [[currentMapping]] = await connection.query('SELECT * FROM ClinicGoogleAdsAccounts WHERE id=?', [mapping.id]);
    assert.equal(digest(currentMapping), mapping.hash, 'FIXTURE_MAPPING_CHANGED');
    const [settings] = await connection.query("SELECT * FROM CampaignWorkspaceSettings WHERE scope_type='clinic' AND scope_id=1");
    assert.equal(settings.length, 1, 'SINGLE_FIXTURE_DRAFT_REQUIRED');
    const [events] = await connection.query('SELECT * FROM CampaignWorkspaceEvents WHERE setting_id=? ORDER BY version', [settings[0].id]);
    validateDraftCapture(settings[0], events, manifest.createdAt);
    await connection.rollback();
    manifest.rows.push(...settings.map(row => ({ table: 'CampaignWorkspaceSettings', id: row.id, hash: digest(row) })),
      ...events.map(row => ({ table: 'CampaignWorkspaceEvents', id: row.id, hash: digest(row) })));
    manifest.draftCaptureAt = new Date().toISOString();
    fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { state: 'drafts-captured', events: events.length, activation: false };
  } catch (error) { await connection.rollback(); throw error; }
}

async function main() {
  assert.equal(process.env.CC_QA_ISOLATED_CAMPAIGN_WRITES, MARKER, 'EXPLICIT_ISOLATED_FIXTURE_OPT_IN_REQUIRED');
  const [action, filename, ...rest] = process.argv.slice(2);
  assert.ok(['seed', 'seed-report', 'capture-drafts', 'cleanup'].includes(action) && !rest.length, 'USE_SEED_CAPTURE_DRAFTS_OR_CLEANUP_WITH_MANIFEST');
  manifestPath(filename); runtimeSafety();
  const connection = await connectOperatorDatabase('dev');
  try { console.log(JSON.stringify(await (action === 'seed' || action === 'seed-report' ? seed(connection, filename, new Date(), action === 'seed-report' ? 'report' : 'standard')
    : action === 'capture-drafts' ? captureDrafts(connection, filename) : cleanup(connection, filename)))); }
  finally { await connection.end(); }
}
module.exports = { MARKER, ACCOUNT, assertClosed, assertDatabase, digest, daysBefore, manifestPath, seed, cleanup, validateDraftCapture, captureDrafts };
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
