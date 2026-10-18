'use strict';
// Fictional fixtures only. The two b_guard_* triggers are deliberately labelled
// synthetic; they do not substitute for the real WhatsApp guards' fixed digest.
const SCHEMA='cc_dms_pilot';
const quote=name=>'`'+SCHEMA+'`.`'+name+'`';
const TABLES=Object.freeze({
  pilot_identity:['id','run_id'],pilot_probe:['id','payload'],
  b_parent:['id','label'],b_child_cascade:['id','parent_id','marker'],b_child_setnull:['id','parent_id','marker'],
  b_lob:['id','payload','document','nullable_document','revision'],
  b_google_generated:['id','ad_group','network','device'],
  b_due_generated:['id','created_at','grace_minutes'],b_phone_generated:['id','state','phone_key'],
  b_wa_catalog:['id','provider','catalog_enabled','phone_asset_key','properties'],
  b_wa_queue:['id','dedupe_key','state','lease_owner','payload','attempts','acked_at'],
  b_cdc_barrier:['id','marker','phase'],
});
Object.values(TABLES).forEach(Object.freeze);
const GENERATED=Object.freeze([
  ['b_google_generated','ad_group_key'],['b_google_generated','network_key'],['b_google_generated','device_key'],
  ['b_due_generated','due_at'],['b_phone_generated','active_phone_key'],
]);
const EXPORT_ORDER=Object.freeze(['pilot_identity','pilot_probe','b_child_cascade','b_child_setnull','b_lob',
  'b_google_generated','b_due_generated','b_phone_generated','b_wa_catalog','b_wa_queue','b_cdc_barrier','b_parent']);
const GUARD_BODY="BEGIN IF NEW.provider = 'whatsapp' AND (NEW.catalog_enabled <> 1 OR NEW.phone_asset_key IS NULL OR NEW.phone_asset_key = '') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic_whatsapp_catalog_guard'; END IF; END";
const DDL=Object.freeze([
  'CREATE TABLE '+quote('b_parent')+' (id INT PRIMARY KEY,label VARCHAR(64) NOT NULL) ENGINE=InnoDB',
  'CREATE TABLE '+quote('b_child_cascade')+' (id INT PRIMARY KEY,parent_id INT NOT NULL,marker VARCHAR(64) NOT NULL,CONSTRAINT b_fk_cascade FOREIGN KEY(parent_id) REFERENCES b_parent(id) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB',
  'CREATE TABLE '+quote('b_child_setnull')+' (id INT PRIMARY KEY,parent_id INT NULL,marker VARCHAR(64) NOT NULL,CONSTRAINT b_fk_setnull FOREIGN KEY(parent_id) REFERENCES b_parent(id) ON DELETE SET NULL ON UPDATE SET NULL) ENGINE=InnoDB',
  'CREATE TABLE '+quote('b_lob')+' (id INT PRIMARY KEY,payload JSON NOT NULL,document MEDIUMTEXT NOT NULL,nullable_document LONGTEXT NULL,revision INT NOT NULL DEFAULT 0) ENGINE=InnoDB',
  'CREATE TABLE '+quote('b_google_generated')+" (id INT PRIMARY KEY,ad_group VARCHAR(64) NULL,network VARCHAR(64) NULL,device VARCHAR(64) NULL,ad_group_key VARCHAR(64) GENERATED ALWAYS AS (COALESCE(ad_group,'__NULL__')) STORED,network_key VARCHAR(64) GENERATED ALWAYS AS (COALESCE(network,'__NULL__')) STORED,device_key VARCHAR(64) GENERATED ALWAYS AS (COALESCE(device,'__NULL__')) STORED,UNIQUE KEY b_uniq_generated(ad_group_key,network_key,device_key)) ENGINE=InnoDB",
  'CREATE TABLE '+quote('b_due_generated')+' (id INT PRIMARY KEY,created_at DATETIME(3) NOT NULL,grace_minutes INT NOT NULL,due_at DATETIME(3) GENERATED ALWAYS AS (DATE_ADD(created_at,INTERVAL grace_minutes MINUTE)) STORED) ENGINE=InnoDB',
  'CREATE TABLE '+quote('b_phone_generated')+" (id INT PRIMARY KEY,state ENUM('active','inactive') NOT NULL,phone_key VARCHAR(30) NOT NULL,active_phone_key VARCHAR(30) GENERATED ALWAYS AS (IF(state='active',phone_key,NULL)) STORED,UNIQUE KEY b_uniq_phone(active_phone_key)) ENGINE=InnoDB",
  'CREATE TABLE '+quote('b_wa_catalog')+" (id INT PRIMARY KEY,provider ENUM('whatsapp','other') NOT NULL,catalog_enabled TINYINT NOT NULL,phone_asset_key VARCHAR(64) NULL,properties JSON NOT NULL) ENGINE=InnoDB",
  'CREATE TABLE '+quote('b_wa_queue')+" (id INT PRIMARY KEY,dedupe_key VARCHAR(64) NOT NULL UNIQUE,state ENUM('pending','leased','acked') NOT NULL,lease_owner VARCHAR(64) NULL,payload JSON NOT NULL,attempts INT NOT NULL,acked_at DATETIME(3) NULL) ENGINE=InnoDB",
  'CREATE TABLE '+quote('b_cdc_barrier')+' (id INT PRIMARY KEY,marker CHAR(64) NOT NULL,phase VARCHAR(32) NOT NULL) ENGINE=InnoDB',
]);
function textBytes(size) {return '🦷'.repeat(Math.floor(size/4))+'x'.repeat(size%4);}
function insert(name,values) {
  const columns=TABLES[name];
  return {sql:'INSERT INTO '+quote(name)+' ('+columns.map(c=>'`'+c+'`').join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')',values};
}
function initialRows() {
  const rows=[insert('b_parent',[1,'DELETE_PARENT']),insert('b_parent',[2,'UPDATE_PARENT']),
    insert('b_child_cascade',[1,1,'DELETE_CHILD']),insert('b_child_cascade',[2,2,'UPDATE_CHILD']),
    insert('b_child_setnull',[1,1,'DELETE_SET_NULL']),insert('b_child_setnull',[2,2,'UPDATE_SET_NULL'])];
  for(const [index,size]of [0,32769,65535,65536,65537,1048576,1048577].entries()) {
    rows.push(insert('b_lob',[index+1,JSON.stringify({fixture:'SYNTHETIC_B',unicode:'漢字á',body:textBytes(size)}),textBytes(size),index%2?null:'',0]));
  }
  rows.push(insert('b_google_generated',[1,null,'fictional-network','🦷-device']),
    insert('b_google_generated',[2,'fictional-ad',null,null]),
    insert('b_due_generated',[1,'2026-10-18 00:00:00.123',15]),
    insert('b_phone_generated',[1,'active','TEST-NO-PHONE-1']),insert('b_phone_generated',[2,'inactive','TEST-NO-PHONE-1']),
    insert('b_wa_catalog',[1,'whatsapp',1,'TEST-ASSET-NO-PROVIDER',JSON.stringify({synthetic:true})]),
    insert('b_wa_queue',[1,'B-FAKE-DEDUPE-1','pending',null,JSON.stringify({synthetic:true,sendForbidden:true}),0,null]));
  return rows;
}
function triggerDDL() {
  return ['INSERT','UPDATE'].map(event=>'CREATE DEFINER=CURRENT_USER TRIGGER '+quote('b_guard_catalog_'+event.toLowerCase())+' BEFORE '+event+' ON '+quote('b_wa_catalog')+' FOR EACH ROW '+GUARD_BODY);
}
function mutationStage(name) {
  const stages={
    during_seed_delete:[{sql:'DELETE FROM '+quote('b_parent')+' WHERE id=1',values:[]}],
    after_seed_update:[{sql:'UPDATE '+quote('b_parent')+' SET id=20 WHERE id=2',values:[]},
      insert('b_lob',[100,JSON.stringify({synthetic:true,body:textBytes(65537)}),textBytes(1048577),null,0]),
      {sql:'UPDATE '+quote('b_lob')+' SET payload=?,document=?,nullable_document=?,revision=revision+1 WHERE id=2',values:[JSON.stringify({synthetic:true,body:textBytes(1048577),unicode:'🦷漢字á'}),textBytes(65537),textBytes(32769)]},
      {sql:'UPDATE '+quote('b_google_generated')+' SET network=?,device=? WHERE id=1',values:['fictional-network-new',null]},
      {sql:'UPDATE '+quote('b_due_generated')+' SET grace_minutes=30 WHERE id=1',values:[]},
      {sql:'UPDATE '+quote('b_phone_generated')+" SET state='inactive' WHERE id=1",values:[]},
      {sql:'UPDATE '+quote('b_phone_generated')+" SET state='active' WHERE id=2",values:[]},
      {sql:'UPDATE '+quote('b_wa_queue')+" SET state='leased',lease_owner='SYNTHETIC-WORKER',attempts=attempts+1 WHERE id=1",values:[]}],
    acknowledge_after_commit:[{sql:'UPDATE '+quote('b_wa_queue')+" SET state='acked',acked_at='2026-10-18 00:01:00.123' WHERE id=1 AND state='leased'",values:[]}],
    final_marker:[insert('b_cdc_barrier',[1,'b'.repeat(64),'FINAL_WRITERS_FENCED'])],
  };
  if(!stages[name])throw Error('synthetic_stage_unknown');return stages[name];
}
const NEGATIVE_GUARDS=Object.freeze([
  insert('b_wa_catalog',[99,'whatsapp',0,null,JSON.stringify({synthetic:true})]),
  {sql:'UPDATE '+quote('b_wa_catalog')+' SET phone_asset_key=NULL WHERE id=1',values:[]},
]);
module.exports={SCHEMA,TABLES,GENERATED,EXPORT_ORDER,GUARD_BODY,DDL,textBytes,initialRows,triggerDDL,mutationStage,NEGATIVE_GUARDS};
