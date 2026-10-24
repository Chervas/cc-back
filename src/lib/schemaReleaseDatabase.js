'use strict';
// Metadata preflight transport only. Never mutates schema, imports models or loads an admin secret.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {buildDatabaseTlsOptions}=require('./databaseTlsConfig');
const HOST='clinicaclick-mysql.clkgw6ogy2cb.eu-west-3.rds.amazonaws.com',DATABASE='clinicaclick',VERSION='8.4.11',CA='/etc/clinicaclick-database/rds-eu-west-3-bundle.pem',CA_SHA='6f2e2f0cabeed0e40f7cc432e47be1ff7a4b6faa28318fb2a9e060afdee5bc26';
const USERS=Object.freeze({staging:'cc_app_api_ee4b8ca0',gateway:'cc_app_wa_ee4b8ca0'});
const BINDING_KEYS=['schema','rootReviewed','runtime','checkedAtEpochMs','expiresAtEpochMs','host','port','database','serverUuid','engineVersion','caSha256','expectedUsername'];
const IDENTITY_SQL='SELECT @@server_uuid AS uuid,@@version AS version,@@port AS port,DATABASE() AS database_name,CURRENT_USER() AS account,CONNECTION_ID() AS sid',TLS_SQL="SHOW SESSION STATUS WHERE Variable_name IN ('Ssl_version','Ssl_cipher')";
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),fail=code=>{throw Error(code);},need=(v,c)=>{if(!v)fail(c);},uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
function validateBinding(r,runtime,at=Date.now()){
 need(Object.hasOwn(USERS,runtime)&&r&&Object.keys(r).sort().join(',')===BINDING_KEYS.slice().sort().join(',')&&r.schema==='clinicaclick-rds-schema-check-binding/1'&&r.rootReviewed===true&&r.runtime===runtime,'schema_public_binding_required');
 need(Number.isSafeInteger(at)&&Number.isSafeInteger(r.checkedAtEpochMs)&&Number.isSafeInteger(r.expiresAtEpochMs)&&r.checkedAtEpochMs<=at&&at<r.expiresAtEpochMs&&r.expiresAtEpochMs-r.checkedAtEpochMs<=900000,'schema_public_binding_expired');
 need(r.host===HOST&&r.port===3306&&r.database===DATABASE&&r.engineVersion===VERSION&&uuid(r.serverUuid)&&r.serverUuid!=='f22a7594-fcca-11ee-b0f3-064dc31d7557'&&r.caSha256===CA_SHA&&r.expectedUsername===USERS[runtime],'schema_public_binding_identity');
 return r;
}
function readBinding(file,expectedSha,runtime,{io=fs,now=Date.now()}={}){
 need(process.getuid()===0&&typeof file==='string'&&file.startsWith('/home/ubuntu/qa-evidence/')&&path.resolve(file)===file&&file.endsWith('.json')&&/^[a-f0-9]{64}$/.test(expectedSha||''),'schema_public_root_binding_required');
 const dir=path.dirname(file),ds=io.lstatSync(dir);need(ds.isDirectory()&&!ds.isSymbolicLink()&&ds.uid===0&&(ds.mode&511)===448&&io.realpathSync(dir)===dir,'schema_public_binding_parent');
 const same=(a,b)=>['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);let fd;
 try{fd=io.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=io.fstatSync(fd);need(s.isFile()&&s.uid===0&&(s.mode&511)===384&&s.nlink===1&&s.size>0&&s.size<=16384,'schema_public_binding_private');const b=io.readFileSync(fd),after=io.lstatSync(dir);need(b.length===s.size&&sha(b)===expectedSha&&same(s,io.fstatSync(fd))&&same(s,io.lstatSync(file))&&after.dev===ds.dev&&after.ino===ds.ino&&after.uid===ds.uid&&after.mode===ds.mode,'schema_public_binding_changed');return validateBinding(JSON.parse(b),runtime,now);}finally{if(fd!==undefined)io.closeSync(fd);}
}
function configuration(env,binding,runtime,{readFile=file=>fs.readFileSync(file),now=Date.now()}={}){
 validateBinding(binding,runtime,now);
 need(env.DB_HOST===HOST&&String(env.DB_PORT||'3306')==='3306'&&env.DB_NAME===DATABASE&&env.DB_USERNAME===binding.expectedUsername&&typeof env.DB_PASSWORD==='string'&&env.DB_PASSWORD.length>=16&&env.DB_PASSWORD.length<=512&&env.DB_TLS_REQUIRED==='true'&&env.DB_TLS_CA_FILE===CA,'schema_public_configuration_mismatch');
 const tls=buildDatabaseTlsOptions(env,readFile);need(tls.ssl?.rejectUnauthorized===true&&tls.ssl.verifyIdentity===true&&tls.ssl.minVersion==='TLSv1.2'&&sha(tls.ssl.ca)===binding.caSha256,'schema_public_ca_or_tls_invalid');
 return{host:HOST,port:3306,user:env.DB_USERNAME,password:env.DB_PASSWORD,database:DATABASE,...tls,connectTimeout:5000,multipleStatements:false,supportBigNumbers:true,bigNumberStrings:true};
}
function close(connection){
 const raw=connection?.connection||connection;try{raw?.destroy?.();}catch{}try{raw?.stream?.destroy();}catch{}
 if(raw?.config)raw.config.password='';
 need(raw?.stream?.destroyed===true,'schema_public_physical_close_unproven');
}
async function connectCheck(env,binding,runtime,{createConnection,readFile,now=Date.now}={}){
 const config=configuration(env,binding,runtime,{...(readFile?{readFile}:{}),now:now()});let connection;
 try{
  const make=createConnection||require('mysql2/promise').createConnection;
  connection=await make(config);validateBinding(binding,runtime,now());const raw=connection.connection||connection;
  need(raw.stream&&raw.stream.destroyed!==true&&typeof raw.destroy==='function'&&typeof raw.stream.destroy==='function'&&raw.config?.host===HOST&&!raw.config.socketPath&&raw.config.ssl?.rejectUnauthorized===true&&raw.config.ssl.verifyIdentity===true&&raw.config.ssl.minVersion==='TLSv1.2'&&sha(raw.config.ssl.ca)===binding.caSha256,'schema_public_driver_tls_changed');
  const [rows]=await connection.query({sql:IDENTITY_SQL,timeout:5000});validateBinding(binding,runtime,now());
  need(Array.isArray(rows)&&rows.length===1,'schema_public_identity_shape');const id=rows[0];
  need(id.uuid===binding.serverUuid&&id.version===binding.engineVersion&&String(id.port)==='3306'&&id.database_name===DATABASE&&Number.isSafeInteger(Number(id.sid))&&Number(id.sid)>0&&String(Number(id.sid))===String(id.sid)&&Number(id.sid)===raw.threadId&&typeof id.account==='string'&&id.account===binding.expectedUsername+'@%'&&id.account.length<=256,'schema_public_live_identity_changed');
  const [status]=await connection.query({sql:TLS_SQL,timeout:5000});validateBinding(binding,runtime,now());need(Array.isArray(status)&&status.length===2&&new Set(status.map(x=>x.Variable_name)).size===2,'schema_public_live_tls_shape');const tls=Object.fromEntries(status.map(x=>[x.Variable_name,x.Value]));
  need(['TLSv1.2','TLSv1.3'].includes(tls.Ssl_version)&&typeof tls.Ssl_cipher==='string'&&tls.Ssl_cipher.length>0,'schema_public_live_tls_required');
  return{connection,proof:{mode:'RDS_APP_METADATA_ONLY',serverUuid:id.uuid,version:id.version,strictTls:true,hostnameVerified:true,caSha256:binding.caSha256,accountSha256:sha(id.account),sessionId:Number(id.sid),bindingExpiresAtEpochMs:binding.expiresAtEpochMs}};
 }catch(e){if(connection)close(connection);throw e;}finally{config.password='';}
}
module.exports={HOST,DATABASE,VERSION,CA,CA_SHA,USERS,BINDING_KEYS,IDENTITY_SQL,TLS_SQL,sha,validateBinding,readBinding,configuration,close,connectCheck};
