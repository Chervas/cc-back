'use strict';
const crypto = require('node:crypto');
function error(status,code,message,details=null) { return Object.assign(Error(message),{statusCode:status,code,details}); }
const clean = (value,max=500) => String(value??'').replace(/\s+/g,' ').trim().slice(0,max);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash = value => crypto.createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(canonical(value))).digest('hex');
function cents(value) {
  if ((typeof value!=='number'&&typeof value!=='string')||String(value).trim()===''||!Number.isFinite(Number(value))) throw error(400,'bank_amount_invalid','Indica un importe válido.');
  const amount=Number(value),integer=Math.round(amount*100);
  if (!Number.isSafeInteger(integer)||Math.abs(integer)>999999999999||Math.abs(amount*100-integer)>0.00001) throw error(400,'bank_amount_invalid','El importe admite dos decimales.');
  return integer;
}
function aggregateCents(value) {
  const match=String(value??'').match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if(!match)throw error(500,'bank_aggregate_invalid','No se pudo verificar el resumen bancario.');
  const integer=(BigInt(match[2])*100n+BigInt((match[3]??'').padEnd(2,'0')))*(match[1]?-1n:1n);
  if(integer>BigInt(Number.MAX_SAFE_INTEGER)||integer<BigInt(Number.MIN_SAFE_INTEGER))throw error(400,'bank_aggregate_amount_too_large','Acota el periodo para consultar este resumen.');
  return Number(integer);
}
function csv(text, delimiter) {
  if (![';',',','\t'].includes(delimiter)) throw error(400,'bank_csv_delimiter_invalid','Selecciona el separador del extracto.');
  const rows=[];let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) { if(ch==='"') { if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;} }else cell+=ch; }
    else if(ch==='"'&&!cell&&!closed) quoted=true;
    else if(ch===delimiter){row.push(cell);cell='';closed=false;}
    else if(ch==='\n'||ch==='\r') { if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(x=>x.trim()))rows.push(row);row=[];cell='';closed=false; }
    else {if(closed||ch==='"')throw error(400,'bank_csv_quotes_invalid','El CSV contiene comillas incompletas.');cell+=ch;}
    if(cell.length>10000||rows.length>2001)throw error(413,'bank_csv_rows_limit','El extracto admite hasta 2.000 movimientos.');
  }
  if(quoted)throw error(400,'bank_csv_quotes_invalid','El CSV contiene comillas incompletas.');
  row.push(cell);if(row.some(x=>x.trim()))rows.push(row);
  if(rows.length>2001)throw error(413,'bank_csv_rows_limit','El extracto admite hasta 2.000 movimientos.');
  return rows;
}
function date(value,format) {
  let v=String(value??'').trim();
  if(format==='DD/MM/YYYY') {const m=v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);if(!m)return null;v=`${m[3]}-${m[2]}-${m[1]}`;}
  else if(format!=='YYYY-MM-DD')return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return null;
  const parsed=new Date(`${v}T00:00:00Z`);return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===v?v:null;
}
function amount(value,decimal) {
  let v=String(value??'').trim().replace(/\u00a0/g,' ');
  if(decimal===','){if(!/^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(v))return null;v=v.replace(/\./g,'').replace(',','.');}
  else if(decimal==='.') {if(!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/.test(v))return null;v=v.replace(/,/g,'');}
  else return null;
  try{return cents(v);}catch{return null;}
}
function parse(input) {
  if(typeof input.content_base64!=='string'||input.content_base64.length>2800000||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64))throw error(400,'bank_csv_required','Adjunta un extracto CSV válido.');
  const buffer=Buffer.from(input.content_base64,'base64');
  if(!buffer.length||buffer.length>2*1024*1024)throw error(413,'bank_csv_size_invalid','El extracto admite hasta 2 MB.');
  if(buffer.toString('base64')!==input.content_base64)throw error(400,'bank_csv_invalid','El contenido del CSV no es válido.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');}catch{throw error(400,'bank_csv_encoding_invalid','Guarda el extracto en UTF-8.');}
  if(text.includes('\u0000'))throw error(400,'bank_csv_invalid','Adjunta un extracto CSV de texto.');
  const currency=clean(input.currency,3).toUpperCase(), account=clean(input.account_ref,80);
  if(!/^[A-Z]{3}$/.test(currency)||String(input.currency??'').trim().length!==3)throw error(400,'bank_currency_required','Indica explícitamente la moneda del extracto.');
  if(!account||String(input.account_ref??'').replace(/\s+/g,' ').trim().length>80)throw error(400,'bank_account_required','Indica una referencia estable para esta cuenta.');
  const config={delimiter:input.delimiter??';',decimal_separator:input.decimal_separator??',',date_format:input.date_format??'DD/MM/YYYY',mapping:input.mapping??{date:'date',description:'description',amount:'amount'}};
  if(![',','.'].includes(config.decimal_separator)||!['YYYY-MM-DD','DD/MM/YYYY'].includes(config.date_format))throw error(400,'bank_csv_format_invalid','Revisa el formato de fechas e importes.');
  const rows=csv(text,config.delimiter),headers=rows.shift()?.map(x=>x.trim())??[];
  if(headers.length<3||new Set(headers).size!==headers.length||headers.some(x=>!x))throw error(400,'bank_csv_headers_invalid','El CSV necesita cabeceras únicas.');
  const fields=['date','description','amount',...(config.mapping.transaction_id?['transaction_id']:[])];
  if(fields.some(k=>typeof config.mapping[k]!=='string'||!headers.includes(config.mapping[k])))throw error(400,'bank_csv_mapping_required','Selecciona las columnas de fecha, concepto e importe.',{headers,row_count:rows.length});
  const positions=Object.fromEntries(fields.map(k=>[k,headers.indexOf(config.mapping[k])]));
  const occurrences=new Map(),identities=new Map(),errors=[],items=[];
  rows.forEach((row,i)=>{
    const get=k=>row[positions[k]], d=date(get('date'),config.date_format),a=amount(get('amount'),config.decimal_separator),description=clean(get('description'),500),external=positions.transaction_id!==undefined?clean(get('transaction_id'),160):null;
    const invalid=[];if(row.length!==headers.length)invalid.push('columns');if(!d)invalid.push('date');if(a===null||a===0)invalid.push('amount');if(!description||String(get('description')??'').replace(/\s+/g,' ').trim().length>500)invalid.push('description');if(positions.transaction_id!==undefined&&(!external||String(get('transaction_id')??'').replace(/\s+/g,' ').trim().length>160))invalid.push('transaction_id');
    if(invalid.length){errors.push({row:i+2,fields:invalid});return;}
    const fingerprint=hash([d,description,a,currency]),occurrence=(occurrences.get(fingerprint)??0)+1;occurrences.set(fingerprint,occurrence);
    const key=hash(external?['external',external]:['fingerprint',fingerprint,occurrence]);
    if(identities.has(key)){errors.push({row:i+2,fields:['transaction_id_duplicate']});return;}identities.set(key,true);
    items.push({source_row:i+2,date:d,description,currency,direction:a>0?'incoming':'outgoing',amount:Math.abs(a)/100,row_key:key});
  });
  if(!rows.length)throw error(400,'bank_csv_empty','El extracto no contiene movimientos.');
  return {buffer,account_ref:account,currency,configuration:config,content_hash:hash(buffer),headers,row_count:rows.length,items,errors,can_confirm:errors.length===0,warnings:positions.transaction_id===undefined?['identity_uses_date_description_amount_occurrence']:[]};
}
function limit(value) {const n=Number(value??50);if(!Number.isInteger(n)||n<1||n>100)throw error(400,'bank_page_limit_invalid','El tamaño de página debe estar entre 1 y 100.');return n;}
function cursor(value,scope) {if(!value)return null;try {const p=JSON.parse(Buffer.from(value,'base64url'));if(p.scope!==hash(scope)||typeof p.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(p.id))throw Error();return p.id;}catch{throw error(400,'bank_cursor_invalid','La página pertenece a otra búsqueda.');}}
const nextCursor=(id,scope)=>Buffer.from(JSON.stringify({id,scope:hash(scope)})).toString('base64url');
module.exports={error,clean,hash,cents,aggregateCents,parse,limit,cursor,nextCursor};
