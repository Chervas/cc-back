'use strict';
// Pure compiler for one schema-only experiment. Not a general SQL runner.
const crypto = require('node:crypto');
const SOURCE_SCHEMA = 'clinicaclick';
const TARGET_SCHEMA = 'cc_schema_compat_20261018';
const EXPECTED_TABLES = 305;
const EXPECTED_BODY_SHA256 = '4d73f93344d76cb2c8375605bad8a74d56870d9ecbc6e023c054d4bfa5f68dc8';
const SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const approved = new WeakSet();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function refuse(code) { throw Object.assign(new Error(code), {safeCode: code}); }
function need(ok, code) { if (!ok) refuse(code); }
function identifier(name) { need(typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name), 'identifier_not_reviewed'); return '`'+name+'`'; }
function quotedEnd(sql, start) {
  const quote=sql[start]; let i=start+1;
  while(i<sql.length) {
    if(sql[i]==='\\' && quote!=='`') {i+=2; continue;}
    if(sql[i]===quote) {if(sql[i+1]===quote){i+=2;continue;}return i+1;}
    i++;
  }
  refuse('unterminated_sql_quote');
}
function stripComments(sql) {
  const chunks=[];let i=0,start=0;
  while(i<sql.length) {
    if("'\"`".includes(sql[i])) {i=quotedEnd(sql,i);continue;}
    if(sql[i]==='#'||sql.slice(i,i+2)==='--' && /\s/.test(sql[i+2]||'')) {
      chunks.push(sql.slice(start,i),' ');const end=sql.indexOf('\n',i);i=end<0?sql.length:end;start=i;continue;
    }
    if(sql.slice(i,i+2)==='/*') {
      chunks.push(sql.slice(start,i));
      const end=sql.indexOf('*/',i+2);need(end>=0,'unterminated_sql_comment');
      if(sql[i+2]==='!') {
        const inner=sql.slice(i+3,end);const version=/^([0-9]{5,6})(?:\s|$)/.exec(inner);
        need(version && Number(version[1])<=80042,'executable_comment_version_not_reviewed');
        chunks.push(' '+stripComments(inner.slice(version[0].length))+' ');
      } else chunks.push(' ');
      i=end+2;start=i;continue;
    }
    i++;
  }
  chunks.push(sql.slice(start));return chunks.join('');
}
function tokenize(sql) {
  const tokens=[];let i=0;
  while(i<sql.length) {
    if(/\s/.test(sql[i])){i++;continue;}
    const start=i;let kind='symbol';
    if("'\"`".includes(sql[i])) {kind=sql[i]==='`'?'identifier':'string';i=quotedEnd(sql,i);}
    else {
      const number=/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
      const word=/^[A-Za-z_@$][A-Za-z0-9_$@]*/.exec(sql.slice(i));
      const operator=/^(?:->>|->|>=|<=|<>|!=|:=|&&|\|\||<<|>>)/.exec(sql.slice(i));
      if(number){kind='number';i+=number[0].length;}
      else if(word){kind='word';i+=word[0].length;}
      else i+=operator?operator[0].length:1;
    }
    const raw=sql.slice(start,i);
    tokens.push({kind,raw,start,end:i,value:kind==='identifier'?raw.slice(1,-1).replace(/``/g,'`'):raw});
  }
  return tokens;
}
function split(sql) {
  const clean=stripComments(sql);const all=tokenize(clean);let start=0;const statements=[];
  for(let i=0;i<=all.length;i++) {
    if(i===all.length || all[i].kind==='symbol' && all[i].raw===';') {
      const tokens=all.slice(start,i);
      if(tokens.length) {
        const offset=tokens[0].start;const text=clean.slice(offset,tokens.at(-1).end);
        statements.push({text,tokens:tokens.map(t=>({...t,start:t.start-offset,end:t.end-offset}))});
      }
      start=i+1;
    }
  }
  return statements;
}
function safeDumpSet(tokens) {
  const text=tokens.map(t=>t.raw).join('').toUpperCase();
  const names=['CHARACTER_SET_CLIENT','CHARACTER_SET_RESULTS','COLLATION_CONNECTION','TIME_ZONE','UNIQUE_CHECKS','FOREIGN_KEY_CHECKS','SQL_MODE','SQL_NOTES'];
  for(const name of names) {
    if(text===`SET@OLD_${name}=@@${name}`||text===`SET${name}=@OLD_${name}`)return true;
  }
  return ['SETNAMESUTF8MB4','SETTIME_ZONE=\'+00:00\'',
    'SET@OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS,UNIQUE_CHECKS=0',
    'SET@OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS,FOREIGN_KEY_CHECKS=0',
    'SET@OLD_SQL_MODE=@@SQL_MODE,SQL_MODE=\'NO_AUTO_VALUE_ON_ZERO\'',
    'SET@OLD_SQL_NOTES=@@SQL_NOTES,SQL_NOTES=0',
    'SET@SAVED_CS_CLIENT=@@CHARACTER_SET_CLIENT','SETCHARACTER_SET_CLIENT=@SAVED_CS_CLIENT',
    'SETCHARACTER_SET_CLIENT=UTF8MB4','SETCHARACTER_SET_CLIENT=UTF8'].includes(text);
}
function objectName(tokens,start) {
  const first=tokens[start];need(first && ['identifier','word'].includes(first.kind),'table_identifier_missing');identifier(first.value);
  if(tokens[start+1]?.raw==='.') {
    const second=tokens[start+2];need(first.value===SOURCE_SCHEMA && second && ['identifier','word'].includes(second.kind),'foreign_schema_reference');
    identifier(second.value);return {name:second.value,end:start+3,start:first.start,stop:second.end,dot:start+1};
  }
  return {name:first.value,end:start+1,start:first.start,stop:first.end,dot:null};
}
function approvedStatement(kind,name,sql,sourceSha) {
  const statement=Object.freeze({kind,name,sql,sourceSha256:sourceSha,targetSha256:sha(sql)});approved.add(statement);return statement;
}
function assertApproved(statement) {need(approved.has(statement) && Object.isFrozen(statement),'statement_not_compiled_by_schema_only_policy');return statement;}
function compileTables(dump,expectedNames) {
  const expectedCount=EXPECTED_TABLES;
  need(typeof dump==='string' && Buffer.byteLength(dump)<=16*1024*1024,'schema_dump_limit_exceeded');
  need(expectedNames.length===expectedCount && new Set(expectedNames).size===expectedCount,'source_table_inventory_changed');
  for(const name of expectedNames)identifier(name);
  const expected=new Set(expectedNames),seen=new Set(),out=[];
  for(const {text,tokens} of split(dump)) {
    const words=tokens.map(t=>t.raw.toUpperCase());
    if(words[0]==='SET') {need(safeDumpSet(tokens),'dump_session_statement_not_reviewed');continue;}
    need(words[0]==='CREATE' && words[1]==='TABLE','non_table_ddl_or_data_statement_forbidden');
    const object=objectName(tokens,2);need(tokens[object.end]?.raw==='(','explicit_table_definition_required');
    need(expected.has(object.name) && !seen.has(object.name),'unexpected_or_duplicate_table');seen.add(object.name);
    const replacements=[{start:object.start,end:object.stop,text:identifier(TARGET_SCHEMA)+'.'+identifier(object.name)}];
    const allowedDots=new Set(object.dot===null?[]:[object.dot]);let depth=0,bodyEnd=-1;
    for(let i=object.end;i<tokens.length;i++) {
      const t=tokens[i];if(t.kind!=='symbol')continue;
      if(t.raw==='(')depth++;if(t.raw===')'){depth--;need(depth>=0,'table_parentheses_invalid');if(depth===0&&bodyEnd<0)bodyEnd=i;}
    }
    need(depth===0&&bodyEnd>=0,'table_parentheses_invalid');
    const forbidden=new Set(['SELECT','LOAD','INFILE','OUTFILE','DUMPFILE','DATABASE','DEFINER','DELIMITER','TABLESPACE','DIRECTORY','CONNECTION','GRANT','REVOKE','CALL','DROP']);
    for(let i=0;i<tokens.length;i++) {
      const t=tokens[i],word=words[i];
      if(t.kind==='word')need(!forbidden.has(word),'unsafe_table_clause');
      if(i>bodyEnd && t.kind==='word')need(word!=='AS'&&word!=='LIKE','create_table_copy_forbidden');
      if(t.kind==='word'&&word==='REFERENCES') {
        const reference=objectName(tokens,i+1);need(expected.has(reference.name),'foreign_table_outside_inventory');
        if(reference.dot!==null)allowedDots.add(reference.dot);
        replacements.push({start:reference.start,end:reference.stop,text:identifier(TARGET_SCHEMA)+'.'+identifier(reference.name)});
      }
    }
    tokens.forEach((t,i)=>need(t.raw!=='.'||t.kind!=='symbol'||allowedDots.has(i),'qualified_expression_not_reviewed'));
    const engines=tokens.map((t,i)=>t.kind==='word'&&words[i]==='ENGINE'&&tokens[i+1]?.raw==='='?words[i+2]:null).filter(Boolean);
    need(engines.length===1&&engines[0]==='INNODB','innodb_definition_required');
    let sql=text;
    for(const replacement of replacements.sort((a,b)=>b.start-a.start))sql=sql.slice(0,replacement.start)+replacement.text+sql.slice(replacement.end);
    out.push(approvedStatement('create_table',object.name,sql,sha(text)));
  }
  need(out.length===expectedCount && seen.size===expected.size,'table_definition_inventory_incomplete');
  return out;
}
function validateSourceMeta(meta) {
  need(/^8\.0\.42(?:-|$)/.test(meta.version) && Number(meta.lower_case_table_names)===0,'source_engine_not_reviewed');
  need(meta.sql_mode.split(',').sort().join(',')===SQL_MODE.split(',').sort().join(','),'source_sql_mode_changed');
  need(['views','routines','events'].every(name=>meta[name]===0),'source_secondary_object_inventory_changed');
}
function compileTriggers(triggers) {
  const expectedBodySha256=EXPECTED_BODY_SHA256;
  need(triggers.length===2,'trigger_inventory_changed');const seen=new Set();const out=[];
  const names={guard_whatsapp_catalog_insert:'INSERT',guard_whatsapp_catalog_update:'UPDATE'};
  for(const trigger of triggers) {
    need(names[trigger.name]===trigger.event && trigger.table==='ClinicMetaAssets'&&trigger.timing==='BEFORE'&&!seen.has(trigger.name),'trigger_identity_changed');seen.add(trigger.name);
    need(typeof trigger.body==='string' && sha(trigger.body)===expectedBodySha256 && trigger.body_sha256===expectedBodySha256,'trigger_body_changed');
    need(trigger.sql_mode.split(',').sort().join(',')===SQL_MODE.split(',').sort().join(','),'trigger_sql_mode_changed');
    need(trigger.character_set_client==='utf8mb4'&&trigger.collation_connection==='utf8mb4_0900_ai_ci'&&trigger.database_collation==='utf8mb4_0900_ai_ci','trigger_charset_not_reviewed');
    const sql='CREATE DEFINER=CURRENT_USER TRIGGER '+identifier(TARGET_SCHEMA)+'.'+identifier(trigger.name)+' BEFORE '+trigger.event+' ON '+identifier(TARGET_SCHEMA)+'.`ClinicMetaAssets` FOR EACH ROW '+trigger.body;
    out.push(approvedStatement('create_trigger',trigger.name,sql,expectedBodySha256));
  }
  return out;
}
module.exports={SOURCE_SCHEMA,TARGET_SCHEMA,EXPECTED_TABLES,EXPECTED_BODY_SHA256,SQL_MODE,sha,
  compileTables,compileTriggers,validateSourceMeta,assertApproved,need,refuse};
