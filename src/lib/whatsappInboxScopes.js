'use strict';
const fs = require('node:fs'); const { createHash } = require('node:crypto');
const { normalize, importLease } = require('./whatsappInboxImport');
const CONFIG_FILE = '/etc/clinicaclick-whatsapp-inbox/staging/scopes.json';
const id = v => Number.isInteger(v) && v > 0 && v <= 2147483647;
const providerId = v => typeof v === 'string' && /^[1-9][0-9]{0,29}$/.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
function held() { throw Error('whatsapp_inbox_review_required'); }
function validateConfiguration(c) {
  if (!exact(c,'scopes,version') || c.version !== 1 || !Array.isArray(c.scopes) || !c.scopes.length || c.scopes.length > 1000) held();
  const phones = new Set(); const assets = new Set();
  for (const s of c.scopes) {
    if (!exact(s,'assetId,clinicIds,phoneId,wabaId') || !id(s.assetId) || assets.has(s.assetId) || !providerId(s.phoneId)
      || phones.has(s.phoneId) || !providerId(s.wabaId) || !Array.isArray(s.clinicIds) || !s.clinicIds.length || s.clinicIds.length > 1000
      || s.clinicIds.some((n,i,a) => !id(n) || i && a[i-1] >= n)) held();
    phones.add(s.phoneId); assets.add(s.assetId);
  }
  return {version:1,scopes:c.scopes.map(s=>({assetId:s.assetId,wabaId:s.wabaId,phoneId:s.phoneId,clinicIds:[...s.clinicIds]})).sort((a,b)=>a.phoneId.localeCompare(b.phoneId))};
}
function configuration(env = process.env) {
  if (!env.WHATSAPP_INBOX_SCOPES_FILE) return null;
  if (env.RUNTIME_NAMESPACE !== 'staging' || env.WHATSAPP_INBOX_SCOPES_FILE !== CONFIG_FILE) held();
  let raw;
  try {
    const stat = fs.statSync(CONFIG_FILE);
    if (fs.realpathSync(CONFIG_FILE) !== CONFIG_FILE || !stat.isFile() || stat.mode & 0o077 || stat.size > 1048576) held();
    raw = fs.readFileSync(CONFIG_FILE); return validateConfiguration(JSON.parse(raw));
  } catch { held(); } finally { raw?.fill(0); }
}
const ownership = s => JSON.stringify({wabaId:s.wabaId,phoneId:s.phoneId,clinicIds:s.clinicIds});
async function assertScope(connection, scope, { lock = false } = {}) {
  const query = async (sql, values=[]) => (await connection.execute(sql + (lock ? ' FOR SHARE' : ''),values))[0];
  // Deliberately no additionalData, connection tokens or patient columns.
  const assets = await query('SELECT id,assignmentScope,clinicaId,grupoClinicaId,assetType,phoneNumberId,wabaId FROM ClinicMetaAssets WHERE id=?',[scope.assetId]);
  const asset = assets[0];
  if (assets.length !== 1 || asset.id !== scope.assetId || asset.assetType !== 'whatsapp_phone_number'
    || asset.phoneNumberId !== scope.phoneId || asset.wabaId !== scope.wabaId) held();
  const clinics = await query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE id_clinica IN ('+scope.clinicIds.map(()=>'?').join(',')+')',scope.clinicIds);
  if (clinics.length !== scope.clinicIds.length) held();
  let members;
  if (asset.assignmentScope === 'clinic' && id(asset.clinicaId)) members = [asset.clinicaId];
  else if (asset.assignmentScope === 'group' && id(asset.grupoClinicaId)) {
    members = (await query('SELECT id_clinica FROM Clinicas WHERE grupoClinicaId=?',[asset.grupoClinicaId])).map(c=>c.id_clinica);
  } else held();
  const directors = await query('SELECT clinic_id FROM PatientDirectionSettings WHERE director_phone_asset_id=?',[scope.assetId]);
  members = [...new Set([...members,...directors.map(d=>d.clinic_id)])].sort((a,b)=>a-b);
  if (members.some(n=>!id(n)) || JSON.stringify(members) !== JSON.stringify(scope.clinicIds)) held();
  const keys = [...new Set([...scope.clinicIds.map(n=>'clinic:'+n),...clinics.filter(c=>id(c.grupoClinicaId)).map(c=>'group:'+c.grupoClinicaId)])];
  if ((await query('SELECT scope_key FROM MetaScopeBlocks WHERE scope_key IN ('+keys.map(()=>'?').join(',')+') LIMIT 1',keys)).length) held();
}
function childId(receipt, index) {
  const h = createHash('sha256').update(JSON.stringify(['cc-wa-inbox-child-v1',receipt,index])).digest('hex');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
}
function splitLease(lease, config) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lease?.receipt) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lease?.lease)
    || !Buffer.isBuffer(lease?.raw) || lease.raw.length > 3*1024*1024 || lease.automaticActionsAllowed !== false
    || !Array.isArray(lease.scopeBindings)) held();
  let body; try { body = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(lease.raw)); } catch { held(); }
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || !body.entry.length || body.entry.length > 100) held();
  const parts = []; const covered = new Set();
  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes) || !entry.changes.length || entry.changes.length > 100) held();
    for (const change of entry.changes) {
      const value = change?.value; const scope = config.scopes.find(s=>s.wabaId===entry.id && s.phoneId===value?.metadata?.phone_number_id);
      if (!scope || value.messaging_product !== 'whatsapp' || !lease.scopeBindings.some(s=>ownership(s)===ownership(scope))) held();
      covered.add(scope.phoneId);
      const add = (content, route) => {
        const packet = {object:'whatsapp_business_account',entry:[{id:entry.id,changes:[{field:change.field,value:{...value,...content}}]}]};
        parts.push({scope,packet,route}); if(parts.length > 2000) held();
      };
      if (change.field === 'messages') {
        if (!Array.isArray(value.messages) && !Array.isArray(value.statuses)) held();
        for (const message of value.messages || []) add({messages:[message],statuses:[]},{peer:message.from});
        for (const status of value.statuses || []) add({messages:[],statuses:[status]},{wamid:status.id});
      } else if (change.field === 'smb_message_echoes') {
        if (!Array.isArray(value.message_echoes)) held();
        for (const message of value.message_echoes) add({message_echoes:[message]},{peer:message.to});
      } else if (change.field === 'history') {
        if (!Array.isArray(value.history)) held();
        for (const h of value.history) {
          if (!Array.isArray(h?.threads)) held();
          for (const thread of h.threads) add({history:[{...h,threads:[thread]}]},{peer:thread.id});
        }
      } else held(); // Keep original signed event encrypted; no partial ACK.
    }
  }
  if (!parts.length || lease.scopeBindings.some(s=>!covered.has(s.phoneId))) held();
  return parts;
}
async function routeClinic(connection, part) {
  if (part.scope.clinicIds.length === 1) return part.scope.clinicIds[0];
  const ids = part.scope.clinicIds; const marks = ids.map(()=>'?').join(','); let rows;
  if (part.route.wamid) {
    if (typeof part.route.wamid !== 'string' || !/^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(part.route.wamid)) held();
    [rows] = await connection.execute("SELECT DISTINCT c.clinic_id FROM Messages m JOIN Conversations c ON c.id=m.conversation_id WHERE c.clinic_id IN ("+marks+") AND c.channel='whatsapp' AND m.direction='outbound' AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.wamid'))=? LIMIT 2",[...ids,part.route.wamid]);
  } else {
    if (typeof part.route.peer !== 'string' || !/^[1-9][0-9]{6,14}$/.test(part.route.peer)) held();
    [rows] = await connection.execute("SELECT DISTINCT clinic_id FROM Conversations WHERE clinic_id IN ("+marks+") AND channel='whatsapp' AND contact_id IN (?,?) LIMIT 2",[...ids,part.route.peer,'+'+part.route.peer]);
  }
  if (rows.length !== 1 || !ids.includes(rows[0].clinic_id)) held(); return rows[0].clinic_id;
}
async function importScopedLease(connection, lease, config, { importer = importLease, loadConfiguration = () => config, now = Date.now() } = {}) {
  config = validateConfiguration(config); const parts = splitLease(lease, config); const prepared = [];
  const checkConfig = () => { if (JSON.stringify(validateConfiguration(loadConfiguration())) !== JSON.stringify(config)) held(); };
  try {
    // Resolve and validate the ENTIRE batch before the first clinical write.
    for (const scope of [...new Map(parts.map(p=>[p.scope.phoneId,p.scope])).values()]) await assertScope(connection, scope);
    for (let i=0;i<parts.length;i++) {
      const part = parts[i]; const clinicId = await routeClinic(connection,part); const raw = Buffer.from(JSON.stringify(part.packet));
      const scope = {clinicId,wabaId:part.scope.wabaId,phoneId:part.scope.phoneId};
      try { normalize(raw,scope,now); } catch { raw.fill(0); throw Error('whatsapp_inbox_review_required'); }
      prepared.push({scope:part.scope,importScope:scope,lease:{...lease,raw,receipt:childId(lease.receipt,i)}});
    }
    for (const part of prepared) {
      checkConfig(); await assertScope(connection,part.scope);
      await importer(connection,part.lease,part.importScope,now,{validateScope:async c=>{checkConfig();await assertScope(c,part.scope,{lock:true});}});
      checkConfig(); await assertScope(connection,part.scope);
    }
    // Stable parent receipt lets a retry reconcile previously committed children
    // without replaying any business handler or acknowledging partial imports.
    checkConfig(); return {importReceipt:childId(lease.receipt,'complete'),replayed:false};
  } finally { for (const p of prepared) p.lease.raw.fill(0); }
}
module.exports = {CONFIG_FILE,validateConfiguration,configuration,assertScope,splitLease,routeClinic,childId,importScopedLease};
