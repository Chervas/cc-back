'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cut=require('../clinical-forms-schema-release');
const {hash}=require('../../lib/cliniccloud-import/adapter');
function baseline(){return{database_name:'clinicaclick_dev_isolated',identity_sha256:'synthetic',server_sha256:hash('synthetic-server'),tables:cut.PARENTS.map(TABLE_NAME=>({TABLE_NAME,ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_unicode_ci'})).sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME)),columns:[{TABLE_NAME:'AppointmentClinicalReports',COLUMN_NAME:'id',COLUMN_TYPE:'bigint unsigned',IS_NULLABLE:'NO',COLUMN_DEFAULT:null,EXTRA:'auto_increment',GENERATION_EXPRESSION:'',ORDINAL_POSITION:1}],indexes:[],foreignKeys:[],triggers:[],metadata_names:[...cut.PREREQUISITES]};}
function complete(){
 const s=baseline();for(const TABLE_NAME of cut.NEW_TABLES)s.tables.push({TABLE_NAME,ENGINE:'InnoDB',TABLE_COLLATION:'utf8mb4_unicode_ci'});
 s.columns.push({TABLE_NAME:'AppointmentClinicalReports',COLUMN_NAME:'form_data',COLUMN_TYPE:'json',IS_NULLABLE:'YES',COLUMN_DEFAULT:null,EXTRA:'',GENERATION_EXPRESSION:'',ORDINAL_POSITION:2});
 for(const [table,fields]of Object.entries(cut.EXPECTED))Object.entries(fields).forEach(([name,type],i)=>s.columns.push({TABLE_NAME:table,COLUMN_NAME:name,COLUMN_TYPE:type,IS_NULLABLE:['published_version','published_at'].includes(name)?'YES':'NO',COLUMN_DEFAULT:null,EXTRA:name==='id'?'auto_increment':'',GENERATION_EXPRESSION:'',ORDINAL_POSITION:i+1}));
 const ix=(table,name,fields,unique)=>fields.forEach((field,i)=>s.indexes.push({TABLE_NAME:table,INDEX_NAME:name,NON_UNIQUE:unique?0:1,SEQ_IN_INDEX:i+1,COLUMN_NAME:field,SUB_PART:null,INDEX_TYPE:'BTREE'}));
 for(const table of cut.NEW_TABLES)ix(table,'PRIMARY',['id'],true);
 ix('ClinicalTemplateCatalogEntries','public_id',['public_id'],true);ix('ClinicalTemplateCatalogEntries','catalog_key',['catalog_key'],true);ix('ClinicalTemplateCatalogVersions','clinical_catalog_version_once',['entry_id','version_number'],true);ix('ClinicalTemplateCatalogAdoptions','clinical_catalog_adoption_once',['clinic_id','source_version_id'],true);ix('ClinicalTemplateCatalogAdoptions','clinical_catalog_adoption_scope',['clinic_id','entry_id'],false);
 for(const [table,column,parent,key]of cut.FOREIGN_KEYS){s.foreignKeys.push({TABLE_NAME:table,COLUMN_NAME:column,CONSTRAINT_NAME:table+'_'+column+'_fk',REFERENCED_TABLE_NAME:parent,REFERENCED_COLUMN_NAME:key,UPDATE_RULE:'NO ACTION',DELETE_RULE:'RESTRICT'});if(!s.indexes.some(row=>row.TABLE_NAME===table&&row.COLUMN_NAME===column&&row.SEQ_IN_INDEX===1))ix(table,column,[column],false);}
 s.tables.sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME));s.columns.sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME)||a.ORDINAL_POSITION-b.ORDINAL_POSITION);s.indexes.sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME)||a.INDEX_NAME.localeCompare(b.INDEX_NAME)||a.SEQ_IN_INDEX-b.SEQ_IN_INDEX);s.foreignKeys.sort((a,b)=>a.TABLE_NAME.localeCompare(b.TABLE_NAME)||a.CONSTRAINT_NAME.localeCompare(b.CONSTRAINT_NAME));s.metadata_names.push(...cut.MIGRATIONS);return s;
}
test('new cut admits only explicit local DEV/CRM identities and exactly the two reviewed additive files',()=>{
 assert.deepEqual(cut.MIGRATIONS,['20261021210000-clinical-structured-forms.js','20261021210500-clinical-template-catalog.js']);
 const cfg={host:'127.0.0.1',port:3306,database:'clinicaclick_dev_isolated',user:'cc_dev_api'};assert.doesNotThrow(()=>cut.assertTarget('dev',cfg));
 const crm={...cfg,database:'clinicaclick',user:'crm-operator'};assert.doesNotThrow(()=>cut.assertTarget('crm',crm));
 for(const [target,config]of [['crm',cfg],['dev',crm],['staging',crm],['dev',{...cfg,host:'remote'}],['dev',{...cfg,user:'root'}],['dev',{...cfg,port:3307}],['crm',{...crm,host:'remote'}],['crm',{...crm,user:'cc_dev_api'}],['crm',{...crm,user:''}],['crm',{...crm,port:3307}]])assert.throws(()=>cut.assertTarget(target,config),/LOCAL_EXPLICIT_TARGET/);
 assert.equal(cut.lockNameForTarget('dev'),'clinicaclick_dev_schema_release');assert.equal(cut.lockNameForTarget('crm'),'clinicaclick_crm_schema_release');assert.throws(()=>cut.lockNameForTarget('staging'),/LOCAL_EXPLICIT_TARGET/);
});
test('capture binds authenticated SQL user/database/port; only DEV requires its fictional anchor',async()=>{
 const config={host:'127.0.0.1',port:3306,database:'clinicaclick',user:'crm-operator'},calls=[];
 function sql(patch={},anchor=1){return{query:async text=>{calls.push(text);assert.match(text,/^SELECT /);if(text.includes('CURRENT_USER()'))return[[{database_name:config.database,database_user:config.user+'@localhost',server_name:'synthetic-server',server_port:3306,...patch}]];if(text.includes('nombre_clinica'))return[[{ok:anchor}]];if(text.includes('information_schema.TABLES'))return[baseline().tables];if(text.includes('information_schema.COLUMNS'))return[baseline().columns];if(text.includes('SELECT name FROM SequelizeMeta'))return[cut.PREREQUISITES.map(name=>({name}))];return[[]];}};}
 const state=await cut.capture(sql(),'crm',config);assert.equal(state.database_name,'clinicaclick');assert(!calls.some(text=>text.includes('nombre_clinica')));
 for(const patch of [{database_name:'clinicaclick_dev_isolated'},{database_user:'other@localhost'},{server_port:3307}])await assert.rejects(cut.capture(sql(patch),'crm',config),/DATABASE_IDENTITY/);
 const dev={...config,database:'clinicaclick_dev_isolated',user:'cc_dev_api'};
 await assert.rejects(cut.capture(sql({database_name:dev.database,database_user:dev.user+'@localhost'},0),'dev',dev),/FICTIONAL_ANCHOR/);
 assert(calls.some(text=>text.includes('nombre_clinica')));
});
test('registry prerequisites and partial/unregistered schema block blind retries',()=>{
 const before=baseline();assert.deepEqual(cut.pending(before),cut.MIGRATIONS);assert.deepEqual(cut.pending(complete()),[]);
 for(const mutate of [s=>s.metadata_names.pop(),s=>s.tables.push({TABLE_NAME:cut.NEW_TABLES[0]}),s=>s.columns.push({TABLE_NAME:'AppointmentClinicalReports',COLUMN_NAME:'form_data'}),s=>s.metadata_names.push(cut.MIGRATIONS[1])]){const s=baseline();mutate(s);assert.throws(()=>cut.pending(s),/PRIOR_CLINICAL|UNREGISTERED|ORDER_INVALID/);}
});
test('the actual two-DDL cohort allows implicit FK indexes and registry publication while retaining parent metadata',()=>{
 const before=baseline(),after=complete(),pre={...after,metadata_names:before.metadata_names};assert.doesNotThrow(()=>cut.verifyAfter(before,pre,cut.MIGRATIONS,false));assert.doesNotThrow(()=>cut.verifyAfter(before,after,cut.MIGRATIONS));
 for(const mutate of [s=>s.columns.find(c=>c.TABLE_NAME==='AppointmentClinicalReports'&&c.COLUMN_NAME==='id').COLUMN_TYPE='int',s=>s.metadata_names.push('unrelated.js'),s=>s.identity_sha256='other',s=>s.indexes.push({TABLE_NAME:'AppointmentClinicalReports',INDEX_NAME:'unexpected'}),s=>s.triggers.push({EVENT_OBJECT_TABLE:'Pacientes'}),s=>s.columns.find(c=>c.COLUMN_NAME==='form_data').IS_NULLABLE='NO']){const s=complete();mutate(s);assert.throws(()=>cut.verifyAfter(before,s,cut.MIGRATIONS),/CLINICAL_FORMS_/);}
});
test('catalog requires exact columns/types, unique indexes and restrictive source/copy foreign keys',()=>{
 for(const mutate of [s=>s.columns.find(c=>c.TABLE_NAME==='ClinicalTemplateCatalogVersions'&&c.COLUMN_NAME==='snapshot').COLUMN_TYPE='text',s=>s.foreignKeys[0].DELETE_RULE='CASCADE',s=>s.foreignKeys.pop(),s=>s.indexes.find(i=>i.INDEX_NAME==='clinical_catalog_adoption_once').NON_UNIQUE=1,s=>s.columns.push({...s.columns.find(c=>c.TABLE_NAME===cut.NEW_TABLES[0]),COLUMN_NAME:'unexpected'})]){const s=complete();mutate(s);assert.throws(()=>cut.verifyCatalog(s),/CATALOG_/);}
});
test('plan binds source commit, both migration hashes, target, freshness, prior metadata and explicit approval cohort',()=>{
 const info={commit:'a'.repeat(40),migrations:cut.MIGRATIONS.map(name=>({name,sha256:'b'.repeat(64)}))},before=baseline(),plan={version:cut.VERSION,target:'dev',source_commit:info.commit,migrations:info.migrations,pending:cut.MIGRATIONS,before,generated_at:new Date().toISOString()};assert.doesNotThrow(()=>cut.validatePlan(plan,info,'dev',before));
 for(const patch of [{target:'crm'},{source_commit:'old'},{migrations:[]},{pending:['other.js']},{generated_at:'2020-01-01'}])assert.throws(()=>cut.validatePlan({...plan,...patch},info,'dev',before),/PLAN_INVALID/);
 assert.throws(()=>cut.validatePlan(plan,info,'dev',{...before,indexes:[{}]}),/PLAN_DRIFT/);
 const crm={...plan,target:'crm',before:{...before,database_name:'clinicaclick'}};assert.doesNotThrow(()=>cut.validatePlan(crm,info,'crm',crm.before));
 assert.throws(()=>cut.validatePlan(crm,info,'dev'),/PLAN_INVALID/);assert.throws(()=>cut.validatePlan(plan,info,'crm'),/PLAN_INVALID/);assert.throws(()=>cut.validatePlan({...crm,before},info,'crm'),/PLAN_INVALID/);
});
test('full verified backup must be fresh and cover the exact target/database/server and all retained tables',()=>{
 for(const target of ['dev','crm']){
  const plan={target,before:{...baseline(),database_name:target==='dev'?'clinicaclick_dev_isolated':'clinicaclick'}},b={version:'cliniccloud-operator-backup/1',database_target:target,database_name:plan.before.database_name,server_name:'synthetic-server',full_gzip_verified:true,dump_completion_verified:true,tables:cut.PARENTS,generated_at:new Date().toISOString()};assert.doesNotThrow(()=>cut.validateBackupManifest(b,plan));
  for(const patch of [{database_target:target==='dev'?'crm':'dev'},{database_name:'other'},{server_name:'other'},{tables:[]},{full_gzip_verified:false},{dump_completion_verified:false},{generated_at:'2020-01-01'},{generated_at:new Date(Date.now()+60000).toISOString()}])assert.throws(()=>cut.validateBackupManifest({...b,...patch},plan),/FRESH_TARGET_BACKUP/);
 }
});
test('both DEV writers must already be stopped, without issuing a stop/restart command',()=>{
 const calls=[];assert.doesNotThrow(()=>cut.assertStopped('dev',(cmd,args)=>{calls.push([cmd,args]);return'inactive\n';}));assert.equal(calls.length,2);assert(calls.every(([cmd,args])=>cmd==='systemctl'&&args[0]==='show'));assert.throws(()=>cut.assertStopped('dev',()=> 'active\n'),/STOP_DEV_WRITERS/);assert.throws(()=>cut.assertStopped('unknown',()=> 'inactive\n'),/LOCAL_EXPLICIT_TARGET/);
});
test('CRM requires exactly its API stopped and port3001 closed, without stopping gateway or any process',()=>{
 const stopped={name:'pm2-back-staging',pid:0,pm2_env:{status:'stopped'}},gateway={name:'gateway',pid:123,pm2_env:{status:'online'}},calls=[];
 function command(processes=[stopped,gateway],listening='LISTEN 0 511 127.0.0.1:3306 0.0.0.0:*\n'){return(cmd,args)=>{calls.push([cmd,args]);return cmd==='pm2'?JSON.stringify(processes):listening;};}
 assert.doesNotThrow(()=>cut.assertStopped('crm',command()));assert.deepEqual(calls,[['pm2',['jlist']],['ss',['-H','-ltn']]]);
 for(const rows of [[],[stopped,stopped],[{...stopped,pid:456}],[{...stopped,pm2_env:{status:'online'}}],[{name:stopped.name,pid:0}]])assert.throws(()=>cut.assertStopped('crm',command(rows)),/STOP_CRM_API/);
 for(const address of ['127.0.0.1:3001','[::]:3001','*:3001'])assert.throws(()=>cut.assertStopped('crm',command(undefined,`LISTEN 0 511 ${address} 0.0.0.0:*\n`)),/CRM_PORT_STILL_LISTENING/);
});
