'use strict';
const MIGRATION = '20261028110000-create-delegated-sessions.js';
const REQUIRED = ['SELECT', 'INSERT', 'UPDATE'];
// Read only. Do not grant privileges or emit raw grant/account strings. A
// role-only or column-restricted grant needs an explicit reviewed resolution.
function privileges(grants, database, tableName='DelegatedSessions') {
  if (!Array.isArray(grants) || typeof database !== 'string' || !/^[A-Za-z0-9_]+$/.test(database)
    ||typeof tableName!=='string'||!/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)) return [];
  const result = new Set();
  for (const row of grants) for (const statement of Object.values(row)) {
    if (typeof statement !== 'string') continue;
    const match = /^GRANT ([A-Z ,]+) ON (`[^`]+`|\*)\.(`[^`]+`|\*) TO /i.exec(statement);
    if (!match) continue;
    const scope = match[2].replace(/`/g, ''), table = match[3].replace(/`/g, '');
    if (!['*', database].includes(scope) || !['*', tableName].includes(table)) continue;
    const names = match[1].toUpperCase().split(',').map(value => value.trim());
    for (const name of REQUIRED) if (names.includes(name) || names.includes('ALL PRIVILEGES')) result.add(name);
  }
  return REQUIRED.filter(name => result.has(name));
}
async function check(query) {
  const [identity] = await query('SELECT DATABASE() AS database_name', []);
  const granted = privileges(await query('SHOW GRANTS FOR CURRENT_USER', []), identity?.database_name);
  const missing = REQUIRED.filter(name => !granted.includes(name));
  return { table: 'DelegatedSessions', required: REQUIRED.slice(), granted, missing, compatible: missing.length === 0 };
}
async function checkTables(query,tables){
  if(!Array.isArray(tables)||!tables.length||tables.some(table=>!/^[A-Za-z][A-Za-z0-9_]*$/.test(table)))throw Error('schema_privilege_tables_invalid');
  const [identity]=await query('SELECT DATABASE() AS database_name',[]),grants=await query('SHOW GRANTS FOR CURRENT_USER',[]);
  return tables.map(table=>{const granted=privileges(grants,identity?.database_name,table),missing=REQUIRED.filter(name=>!granted.includes(name));
    return {table,required:REQUIRED.slice(),granted,missing,compatible:missing.length===0};});
}
module.exports = { MIGRATION, REQUIRED, privileges, check, checkTables };
