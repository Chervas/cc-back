'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),L=require('../../lib/accountingBank');
const input=(text,patch={})=>({content_base64:Buffer.from(text).toString('base64'),account_ref:'QA cuenta',currency:'EUR',delimiter:';',decimal_separator:',',date_format:'DD/MM/YYYY',mapping:{date:'Fecha',description:'Concepto',amount:'Importe',transaction_id:'ID'},...patch});
test('bank CSV parses quoted multi-line concepts, escaped quotes, explicit locale and signed cents',()=>{
 const p=L.parse(input('Fecha;Concepto;Importe;ID\r\n25/10/2026;"Entrada; \"\"QA\"\"\nsegunda línea";1.234,56;one\r\n26/10/2026;Salida;-20,00;two'));
 assert.equal(p.can_confirm,true);assert.equal(p.items[0].amount,1234.56);assert.equal(p.items[1].direction,'outgoing');assert.equal(p.items[0].description,'Entrada; "QA" segunda línea');assert.equal(p.items[1].amount,20);
});
test('missing currency, malformed shape, invalid dates, precision and duplicate transaction IDs never become zero/EUR',()=>{
 assert.throws(()=>L.parse(input('Fecha;Concepto;Importe;ID\n25/10/2026;A;1,00;x',{currency:null})),{code:'bank_currency_required'});
 for(const row of ['31/02/2026;A;1,00;x','25/10/2026;A;1,001;x','25/10/2026;A;0,00;x','25/10/2026;A;;x','25/10/2026;A;1,00;x;extra'])assert.equal(L.parse(input('Fecha;Concepto;Importe;ID\n'+row)).can_confirm,false);
 const duplicate=L.parse(input('Fecha;Concepto;Importe;ID\n25/10/2026;A;1,00;x\n26/10/2026;B;2,00;x'));assert.equal(duplicate.can_confirm,false);
 assert.throws(()=>L.parse(input('Fecha;Concepto;Importe;ID\n25/10/2026;"unfinished;1,00;x')),{code:'bank_csv_quotes_invalid'});
 assert.throws(()=>L.cents(null),{code:'bank_amount_invalid'});assert.throws(()=>L.cents(1.001),{code:'bank_amount_invalid'});
});
test('identity without external IDs remains stable across imports and distinguishes identical occurrences explicitly',()=>{
 const p=L.parse(input('Fecha;Concepto;Importe\n25/10/2026;A;1,00\n25/10/2026;A;1,00',{mapping:{date:'Fecha',description:'Concepto',amount:'Importe'}}));
 assert.equal(p.items.length,2);assert.notEqual(p.items[0].row_key,p.items[1].row_key);assert.equal(p.warnings.length,1);
 assert.equal(L.parse(input('Fecha;Concepto;Importe\n25/10/2026;A;1,00',{mapping:{date:'Fecha',description:'Concepto',amount:'Importe'}})).items[0].row_key,p.items[0].row_key);
});
test('pagination is pinned to clinic, filters and payroll visibility',()=>{
 const scope={clinicId:72,q:'x',includePayroll:false},cursor=L.nextCursor('payment-a',scope);assert.equal(L.cursor(cursor,scope),'payment-a');
 for(const patch of [{clinicId:73},{q:'y'},{includePayroll:true}])assert.throws(()=>L.cursor(cursor,{...scope,...patch}),{code:'bank_cursor_invalid'});
});

test('aggregate sums preserve cents beyond the per-row monetary maximum',()=>{
 assert.equal(L.aggregateCents('19999999999.98'),1999999999998);
 assert.equal(L.aggregateCents('0.00'),0);assert.equal(L.aggregateCents('-1.05'),-105);
 assert.throws(()=>L.aggregateCents('90071992547409.92'),{code:'bank_aggregate_amount_too_large'});
 assert.equal(L.hash({b:2,a:{z:3,y:4}}),L.hash({a:{y:4,z:3},b:2}));
});
test('2,000-row CSV limit is exact with or without the final newline',()=>{
 const rows=Array.from({length:2001},(_,i)=>`25/10/2026;A${i};1,00;tx${i}`),header='Fecha;Concepto;Importe;ID\n';
 for(const ending of ['', '\n']){
  assert.equal(L.parse(input(header+rows.slice(0,2000).join('\n')+ending)).items.length,2000);
  assert.throws(()=>L.parse(input(header+rows.join('\n')+ending)),{code:'bank_csv_rows_limit'});
 }
});
