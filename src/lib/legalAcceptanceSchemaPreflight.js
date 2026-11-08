'use strict';
// Publication metadata only. Contract evidence needs append/read privileges,
// never UPDATE/DELETE and never an automatic grant.
const { effectiveContract } = require('./securitySchemaContract');
const { privileges } = require('./delegatedSchemaPreflight');
const { TABLE } = require('./legalAcceptanceSchema');
const GROUP = 'legal_document_acceptances';
const MIGRATION = '20261108120000-create-legal-document-acceptances.js';
const REQUIRED = Object.freeze(['SELECT', 'INSERT']);
function selected(contract, env) {
    return env.RUNTIME_ROLE === 'api' && Boolean(contract?.featureGroups?.[GROUP]
        && effectiveContract(contract, env).tables[TABLE]);
}
async function check(query) {
    const [identity] = await query('SELECT DATABASE() AS database_name', []);
    const rawGrants = await query('SHOW GRANTS FOR CURRENT_USER', []);
    const granted = privileges(rawGrants, identity?.database_name, TABLE).filter(value => REQUIRED.includes(value));
    const missing = REQUIRED.filter(value => !granted.includes(value));
    return { table: TABLE, required: [...REQUIRED], granted, missing, compatible: missing.length === 0 };
}
module.exports = { GROUP, MIGRATION, REQUIRED, TABLE, selected, check };
