'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{AsyncLocalStorage}=require('node:async_hooks');
const {DatabaseSync}=require('node:sqlite');
const R=require('../../../services/googleOAuthAdmissionRecovery.contract');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-ga-recovery-'));fs.chmodSync(dir,0o700);const db=new DatabaseSync(path.join(dir,'state.sqlite'));
 const dates=new Set(R.DATES),fields=R.FIELDS;
 db.exec('CREATE TABLE intents ('+fields.map(name=>name+' '+(['actor_user_id','clinic_id','revision','generation'].includes(name)?'INTEGER':'TEXT')+(name==='attempt_id'?' PRIMARY KEY':'')).join(',')+')');
 for(const name of ['crm_intent_id','dispatch_request_id','scope_lock','subject_lock'])db.exec('CREATE UNIQUE INDEX unique_'+name+' ON intents('+name+')');
 const context=new AsyncLocalStorage();let active=false;const publications=new Map(),attempts=new Map();
 const encode=(name,value)=>value instanceof Date?value.toISOString():value;
 const decode=row=>row&&Object.fromEntries(Object.entries(row).map(([key,value])=>[key,dates.has(key)&&value!==null?new Date(value):value]));
 const assertTx=options=>{if(!options?.transaction||options.transaction!==context.getStore())throw Error('FIXTURE_TRANSACTION_REQUIRED');};
 const model={
  async findByPk(id,options){assertTx(options);return decode(db.prepare('SELECT * FROM intents WHERE attempt_id=?').get(id));},
  async create(value,options){assertTx(options);try{db.prepare('INSERT INTO intents('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').run(...fields.map(name=>encode(name,value[name])));}catch(error){if(/UNIQUE/.test(error.message))throw Object.assign(Error('PRIVATE_DATABASE_DETAIL'),{name:'SequelizeUniqueConstraintError'});throw error;}return decode(db.prepare('SELECT * FROM intents WHERE attempt_id=?').get(value.attempt_id));},
  async update(patch,options){assertTx(options);const keys=Object.keys(patch),where=Object.keys(options.where);const conditions=where.map(name=>name+(options.where[name]===null?' IS NULL':'=?')).join(' AND ');
   let result;try{result=db.prepare('UPDATE intents SET '+keys.map(name=>name+'=?').join(',')+' WHERE '+conditions).run(...keys.map(name=>encode(name,patch[name])),...where.filter(name=>options.where[name]!==null).map(name=>options.where[name]));}catch(error){if(/UNIQUE/.test(error.message))throw Object.assign(Error('PRIVATE_DATABASE_DETAIL'),{name:'SequelizeUniqueConstraintError'});throw error;}return [Number(result.changes)];},
 };
 const sequelize={async transaction(options,work){if(typeof options==='function'){work=options;options={};}if(active)throw Error('NESTED_FIXTURE_TRANSACTION');active=true;db.exec('BEGIN IMMEDIATE');const tx={sequelize,LOCK:{UPDATE:'UPDATE'},finished:false};const saved=new Map(publications);
  try{return await context.run(tx,async()=>{const result=await work(tx);db.exec('COMMIT');tx.finished='commit';return result;});}
  catch(error){db.exec('ROLLBACK');publications.clear();for(const [id,row]of saved)publications.set(id,row);tx.finished='rollback';throw error;}finally{active=false;}
 }};
 const attemptModel={async findByPk(id,options){assertTx(options);return attempts.get(id)||null;}};
 const publicationModel={async findByPk(id,options){assertTx(options);return publications.get(id)||null;}};
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{db,dir,sequelize,model,attemptModel,publicationModel,attempts,publications,active:()=>active,rows:()=>db.prepare('SELECT * FROM intents').all(),tx:()=>context.getStore()};
}
module.exports={fixture};
