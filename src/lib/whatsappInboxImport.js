'use strict';
const { createHash, randomUUID } = require('node:crypto');
const D = require('./whatsappInboundDetails');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function held() { throw Error('whatsapp_inbox_review_required'); }
function contact(value) { if (typeof value !== 'string' || !/^[1-9][0-9]{6,14}$/.test(value)) held(); return value; }
function normalize(raw, scope, now = Date.now()) {
  if (!Buffer.isBuffer(raw) || raw.length > 3 * 1024 * 1024 || !Number.isSafeInteger(scope.clinicId)
    || scope.clinicId < 1 || !/^[1-9][0-9]{0,29}$/.test(scope.wabaId) || !/^[1-9][0-9]{0,29}$/.test(scope.phoneId)) held();
  let body; try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { held(); }
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || !body.entry.length || body.entry.length > 100) held();
  const messages = []; const statuses = [];
  const add = (m, peer, direction, historical) => {
    contact(peer);
    if (!m || typeof m.id !== 'string' || !/^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(m.id)
      || typeof m.timestamp !== 'string' || !/^[0-9]{1,12}$/.test(m.timestamp)) held();
    const at = Number(m.timestamp) * 1000;
    if (!Number.isSafeInteger(at) || at < Date.UTC(2000,0,1) || at > now + 300000) held();
    let content; let type = 'text';
    if (m.type === 'text') content = m.text?.body;
    else if (m.type === 'button') content = m.button?.text;
    else if (m.type === 'interactive') content = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
    else if (['image','video','audio','document','sticker','location','contacts','reaction','unsupported','system'].includes(m.type)) {
      type = D.messageType(m.type); content = '[' + m.type + ']';
      if (['image','video','document'].includes(m.type) && m[m.type]?.caption) content += ' ' + m[m.type].caption;
    } else held();
    if (typeof content !== 'string' || Buffer.byteLength(content) > 50000) held();
    const key = hash(JSON.stringify([scope.wabaId,scope.phoneId,m.id]));
    const digest = hash(JSON.stringify([peer,direction,m.type,content,at]));
    messages.push({ key,digest,peer,direction,at,content,type,wamid:m.id,providerType:m.type,historical,details:D.details(m) });
    if (messages.length > 2000) held();
  };
  for (const entry of body.entry) {
    if (entry?.id !== scope.wabaId || !Array.isArray(entry.changes) || !entry.changes.length || entry.changes.length > 100) held();
    for (const change of entry.changes) {
      const value = change?.value;
      if (value?.metadata?.phone_number_id !== scope.phoneId || value.messaging_product !== 'whatsapp') held();
      if (change.field === 'messages') {
        if (!Array.isArray(value.messages) && !Array.isArray(value.statuses)) held();
        for (const m of value.messages || []) add(m,m.from,'inbound',false);
        for (const s of value.statuses || []) {
          if (typeof s?.id !== 'string' || !/^wamid\.[A-Za-z0-9+/=_:.-]{1,500}$/.test(s.id)
            || !['sent','delivered','read','failed'].includes(s.status)) held();
          statuses.push({ wamid:s.id,status:s.status,errors:D.errors(s) }); if (statuses.length > 2000) held();
        }
      } else if (change.field === 'smb_message_echoes') {
        if (!Array.isArray(value.message_echoes)) held();
        for (const m of value.message_echoes) add(m,m.to,'outbound',false);
      } else if (change.field === 'history') {
        if (!Array.isArray(value.history)) held();
        for (const h of value.history) {
          if (!Array.isArray(h.threads)) held();
          for (const thread of h.threads) {
            contact(thread.id); if (!Array.isArray(thread.messages)) held();
            for (const m of thread.messages) {
              const direction = m.from === thread.id ? 'inbound' : m.to === thread.id ? 'outbound' : null;
              if (!direction) held(); add(m,thread.id,direction,true);
            }
          }
        }
      } else held(); // Account changes/contact sync stay encrypted for review.
    }
  }
  if (!messages.length && !statuses.length) held();
  return { messages, statuses };
}
// Additive schema; no FK cascades: deleting a conversation/message must not
// erase a receipt and allow an old provider retry to recreate it.
const SCHEMA = [
 `CREATE TABLE IF NOT EXISTS WhatsappInboxImports (receipt CHAR(36) CHARACTER SET ascii PRIMARY KEY, digest CHAR(64) CHARACTER SET ascii NOT NULL,
 import_receipt CHAR(36) CHARACTER SET ascii NOT NULL, clinic_id INT NOT NULL, phone_id VARCHAR(30) CHARACTER SET ascii NOT NULL,
 message_count INT NOT NULL, imported_at DATETIME(3) NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS WhatsappInboxMessageKeys (message_key CHAR(64) CHARACTER SET ascii PRIMARY KEY, digest CHAR(64) CHARACTER SET ascii NOT NULL,
 message_id INT NOT NULL, created_at DATETIME(3) NOT NULL) ENGINE=InnoDB`,
 `CREATE TABLE IF NOT EXISTS WhatsappInboxContactKeys (contact_key CHAR(64) CHARACTER SET ascii PRIMARY KEY, conversation_id INT NOT NULL,
 created_at DATETIME(3) NOT NULL) ENGINE=InnoDB`,
];
async function importLease(connection, lease, scope, now = Date.now(), { validateScope } = {}) {
  if (!uuid(lease?.receipt) || !uuid(lease?.lease) || lease.automaticActionsAllowed !== false || !Buffer.isBuffer(lease.raw)) held();
  const batch = normalize(lease.raw,scope,now); const digest = hash(lease.raw);
  const lock = 'wa-inbox:' + hash(JSON.stringify([scope.clinicId,scope.phoneId])).slice(0,48);
  let locked = false; let tx = false;
  const query = async (sql, values=[]) => (await connection.execute(sql,values))[0];
  try {
    const result = await query('SELECT GET_LOCK(?,2) AS acquired',[lock]); if (result[0]?.acquired !== 1) held(); locked = true;
    await connection.beginTransaction(); tx = true;
    await validateScope?.(connection);
    const old = await query('SELECT * FROM WhatsappInboxImports WHERE receipt=? FOR SHARE',[lease.receipt]);
    if (old.length) {
      if (old[0].digest !== digest || old[0].clinic_id !== scope.clinicId || old[0].phone_id !== scope.phoneId) held();
      await validateScope?.(connection);
      await connection.commit(); tx=false; return { importReceipt:old[0].import_receipt, replayed:true };
    }
    if ((await query('SELECT id_clinica FROM Clinicas WHERE id_clinica=?',[scope.clinicId])).length !== 1) held();
    let inserted=0;
    for (const m of batch.messages) {
      const seen=await query('SELECT digest FROM WhatsappInboxMessageKeys WHERE message_key=?',[m.key]);
      if (seen.length) { if (seen[0].digest !== m.digest) held(); continue; }
      const contactKey=hash(JSON.stringify([scope.clinicId,scope.phoneId,m.peer]));
      const bound=await query('SELECT conversation_id FROM WhatsappInboxContactKeys WHERE contact_key=?',[contactKey]);
      let conversationId=bound[0]?.conversation_id;
      if (!conversationId) {
        const candidates=await query("SELECT id FROM Conversations WHERE clinic_id=? AND channel='whatsapp' AND contact_id IN (?,?) ORDER BY id LIMIT 2 FOR UPDATE",[scope.clinicId,m.peer,'+'+m.peer]);
        if (candidates.length > 1) held(); conversationId=candidates[0]?.id;
        if (!conversationId) {
          const row=await query("INSERT INTO Conversations(clinic_id,channel,contact_id,unread_count,createdAt,updatedAt) VALUES(?,'whatsapp',?,0,NOW(3),NOW(3))",[scope.clinicId,m.peer]); conversationId=row.insertId;
        }
        await query('INSERT INTO WhatsappInboxContactKeys VALUES(?,?,NOW(3))',[contactKey,conversationId]);
      }
      const c=await query("SELECT id FROM Conversations WHERE id=? AND clinic_id=? AND channel='whatsapp' AND contact_id IN (?,?) FOR UPDATE",[conversationId,scope.clinicId,m.peer,'+'+m.peer]);
      if (c.length !== 1) held();
      // Legacy messages lack the new unique key. Adopt only one matching WAMID
      // in this exact conversation; never import it twice on a history replay.
      const legacy=await query("SELECT id,direction,content FROM Messages WHERE conversation_id=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wamid'))=? LIMIT 2",[conversationId,m.wamid]);
      if (legacy.length > 1 || legacy.length && (legacy[0].direction !== m.direction || legacy[0].content !== m.content)) held();
      let messageId=legacy[0]?.id;
      if (!messageId) {
        const metadata=JSON.stringify({ wamid:m.wamid,phone_number_id:scope.phoneId,waba_id:scope.wabaId,passive_recovery:true,
          historical:m.historical,provider_type:m.providerType,automatic_actions_allowed:false,inbox_receipt:lease.receipt,...m.details });
        const row=await query("INSERT INTO Messages(conversation_id,direction,content,message_type,status,metadata,sent_at,createdAt,updatedAt) VALUES(?,?,?,?,'sent',?,?,?,NOW(3))",[conversationId,m.direction,m.content,m.type,metadata,new Date(m.at),new Date(m.at)]);
        messageId=row.insertId; inserted++;
        await query('UPDATE Conversations SET unread_count=unread_count+?,last_message_at=IF(last_message_at IS NULL OR last_message_at<?,?,last_message_at),last_inbound_at=IF(? AND (last_inbound_at IS NULL OR last_inbound_at<?),?,last_inbound_at),updatedAt=NOW(3) WHERE id=?',
          [m.direction==='inbound'?1:0,new Date(m.at),new Date(m.at),m.direction==='inbound'?1:0,new Date(m.at),new Date(m.at),conversationId]);
      }
      await query('INSERT INTO WhatsappInboxMessageKeys VALUES(?,?,?,NOW(3))',[m.key,m.digest,messageId]);
    }
    for (const s of batch.statuses) {
      const rows=await query("SELECT m.id,m.status FROM Messages m JOIN Conversations c ON c.id=m.conversation_id WHERE c.clinic_id=? AND c.channel='whatsapp' AND m.direction='outbound' AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.wamid'))=? LIMIT 2 FOR UPDATE",[scope.clinicId,s.wamid]);
      if (rows.length !== 1) held();
      const rank={pending:0,sending:0,failed:0,sent:1,delivered:2,read:3}; const old=rows[0];
      if (s.status==='failed' ? rank[old.status]<2 : rank[s.status]>rank[old.status]) {
        const extra=s.status==='failed'?{wa_error:s.errors,wa_status:{status:s.status,errors:s.errors},error_code:s.errors[0]?.code||null,delivery_failed:true}:{};
        await query('UPDATE Messages SET status=?,metadata=JSON_MERGE_PATCH(COALESCE(metadata,JSON_OBJECT()),CAST(? AS JSON)),updatedAt=NOW(3) WHERE id=?',[s.status,JSON.stringify(extra),old.id]);
      }
    }
    const importReceipt=randomUUID();
    await query('INSERT INTO WhatsappInboxImports VALUES(?,?,?,?,?,?,NOW(3))',[lease.receipt,digest,importReceipt,scope.clinicId,scope.phoneId,inserted]);
    await validateScope?.(connection);
    await connection.commit();tx=false;return { importReceipt,replayed:false };
  } catch { if(tx) await connection.rollback().catch(()=>{}); held(); }
  finally { if(locked) await query('SELECT RELEASE_LOCK(?)',[lock]).catch(()=>{}); }
}
module.exports={ normalize,importLease,SCHEMA };
