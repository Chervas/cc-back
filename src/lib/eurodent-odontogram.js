'use strict';

/** Pure projection of Eurodent source evidence. No database writes, clinical inference or tariff activation. */
const FAMILY_NAMES = Object.freeze({0:'Cobros',1:'Endodoncia',2:'Obturación',3:'Extracción',4:'Inlay/Onlay',5:'Implante completo',6:'Reconstrucción',7:'Ortodoncia',8:'Muñón completo',9:'Corona',10:'Perno completo',11:'Puente',12:'Bracket',13:'Extracción raíz',14:'Extracción pieza sin raíz',18:'Perno',19:'Implante',20:'Muñón',21:'Rotación derecha',22:'Rotación izquierda',23:'Varios',24:'Prótesis',25:'Carilla estética',99:'Tratamientos ocultos'});
const FAMILY_VISUAL = Object.freeze({1:'endodoncia-uniradicular',2:'obturacion',3:'extraccion',4:'inlay',5:'implante-corona',6:'reconstruccion',7:'ortodoncia-rango',8:'munon-completo',9:'corona',10:'perno-completo',11:'puente',12:'bracket',13:'extraccion-raiz',14:'extraccion-corona',18:'perno',19:'implante',20:'munon',21:'rotacion-derecha',22:'rotacion-izquierda',24:'protesis-removible',25:'carilla'});
const PERMANENT_UPPER = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
const PERMANENT_LOWER = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];
const TEMPORARY_UPPER = [55,54,53,52,51,61,62,63,64,65];
const TEMPORARY_LOWER = [85,84,83,82,81,71,72,73,74,75];
const ALL_TEETH = [...PERMANENT_UPPER,...PERMANENT_LOWER,...TEMPORARY_UPPER,...TEMPORARY_LOWER];
const VALID_TEETH = new Set(ALL_TEETH);
const RANGE_FAMILIES = new Set(['7','11','12']);
// Eurodent asks for individual sectors for fillings/reconstructions, not for its Inlay family.
const SURFACE_FAMILIES = new Set(['2','6']);
const SOURCE_TABLES = new Set(['Historial','Primera_Visita','Trabajo_Pendiente','Presupuesto']);
const str = value => value === undefined || value === null ? '' : String(value).trim();
const bool = value => value === true || value === 1 || value === '1' || value === '-1';
const first = (...values) => values.find(value => value !== undefined && value !== null && str(value) !== '');
const isTemporary = number => number >= 51;
const isUpper = number => [1,2,5,6].includes(Math.floor(number / 10));
const isRight = number => [1,4,5,8].includes(Math.floor(number / 10));
const isAnterior = number => number % 10 <= 3;
const unique = values => [...new Set(values)];
function sourcePrimaryKey(value,record) {
  if (value && typeof value === 'object') {
    if (value.ID !== undefined && value.ID !== null) return str(value.ID);
    return JSON.stringify(Object.keys(value).sort().reduce((result,key) => {result[key]=value[key];return result;},{}));
  }
  return str(first(value,record.ID));
}

function normalizeEurodentCatalogItem(catalog = {}) {
  const rawFamily = str(first(catalog.family_id,catalog.Familia));
  const hidden = rawFamily === '99' || catalog.hidden === true;
  const family = hidden ? str(first(catalog.old_family_id,catalog.FamOldOcu,rawFamily)) : rawFamily;
  const source_id = str(first(catalog.source_id,catalog.id,catalog.ID));
  const code = str(first(catalog.code,catalog['Código']));
  const graphicRequested = bool(first(catalog.graphic,catalog.Grafico));
  let visual=FAMILY_VISUAL[family] || null;
  if (family==='1') {
    const name=str(first(catalog.name,catalog.Nombre)).toLowerCase();
    if (/poli.*radic/.test(name)) visual='endodoncia-poliradicular';
    else if (/bi.*radic/.test(name)) visual='endodoncia-biradicular';
  }
  return {
    source_id, code, name:str(first(catalog.name,catalog.Nombre)),
    family_id:family || null, family_name: FAMILY_NAMES[family] || str(catalog.family_name) || 'Familia sin identificar',
    original_family_id:rawFamily || null, hidden,
    graphic:graphicRequested && !!FAMILY_VISUAL[family],
    visual_type:graphicRequested ? visual : null,
    no_tooth:bool(first(catalog.no_tooth,catalog.SinPza)), all_teeth:bool(first(catalog.all_teeth,catalog.Todos)),
    classification:family === '0' || ['COBR','0213','0291'].includes(code.toUpperCase()) ? 'financial' : 'clinical',
  };
}

function expandEurodentRange(start,end) {
  const arch = [PERMANENT_UPPER,PERMANENT_LOWER,TEMPORARY_UPPER,TEMPORARY_LOWER].find(numbers => numbers.includes(start) && numbers.includes(end));
  if (!arch) return null;
  const a = arch.indexOf(start), b = arch.indexOf(end);
  const result = arch.slice(Math.min(a,b),Math.max(a,b)+1);
  return a <= b ? result : result.reverse();
}

/** Eurodent's 32 drawing positions allow an empty temporary endpoint (e.g.
 * slot38→78, slot48→88). Reproduced in its UI and saved DB, including 36–77.
 * These are scope positions, NOT extra deciduous teeth. Preserve both numbers.
 */
function slotEndpoint(number) {
  if (number>=51 && number<=88 && number%10>=1 && number%10<=8) return number-40;
  return VALID_TEETH.has(number) && !isTemporary(number) ? number : null;
}

/** Eurodent saves 10 + a physical sector mask, NOT a global anatomical surface mask.
 * Verified in its UI: 17/O=26,18/V=12,15/M=14,14/P=18,27/D=14,44/L=12,16/DMO=31.
 * Physical bits: left=1, top=2, right=4, bottom=8, centre=16.
 */
function decodeEurodentSurfaces(value,tooth) {
  const raw = str(value);
  if (!raw || raw === '0') return {surfaces:[],warnings:[]};
  if (!VALID_TEETH.has(tooth) || !/^\d+$/.test(raw)) return {surfaces:[],warnings:['surface_code_unresolved']};
  const number = Number(raw);
  // The original one-sector editor (reachable through “Modelo Antiguo”) uses
  // clockwise positions 1=top,2=right,3=bottom,4=left,5=centre. Verified by
  // reproducing source reconstruction cases: 35/5=O and 44/3=V in the demo.
  if (number >= 1 && number <= 5) {
    const old = {1:isUpper(tooth)?'V':'L',2:isRight(tooth)?'M':'D',3:isUpper(tooth)?'P':'V',4:isRight(tooth)?'D':'M',5:isAnterior(tooth)?'I':'O'};
    return {surfaces:[old[number]],warnings:[]};
  }
  if (number < 11 || number > 40) return {surfaces:[],warnings:['surface_code_unresolved']};
  const mask = number - 10;
  const sectors = [[1,isRight(tooth)?'D':'M'],[2,isUpper(tooth)?'V':'L'],[4,isRight(tooth)?'M':'D'],[8,isUpper(tooth)?'P':'V'],[16,isAnterior(tooth)?'I':'O']];
  return {surfaces:sectors.filter(([bit]) => (mask & bit) !== 0).map(([,surface]) => surface),warnings:[]};
}

function parseToothList(raw) {
  const text = str(raw);
  if (!text) return {teeth:[],warnings:[]};
  if (!/^\d+$/.test(text) || text.length % 2) return {teeth:[],warnings:['tooth_list_unresolved']};
  const teeth = text.match(/\d{2}/g).map(Number);
  if (teeth.some(tooth => !VALID_TEETH.has(tooth))) return {teeth:[],warnings:['tooth_list_unresolved']};
  return {teeth:unique(teeth),warnings:teeth.length === unique(teeth).length ? [] : ['duplicate_source_tooth']};
}

function normalizeEurodentDentalLocation(record = {},catalog = {}) {
  const normalized = normalizeEurodentCatalogItem(catalog);
  const registered = str(first(record['Nº Trat'],record.registered_family_id));
  const family = registered || normalized.family_id;
  const graphicFlag = first(record['Gráfico'],record.Grafico);
  const graphic = (graphicFlag === undefined ? normalized.graphic : bool(graphicFlag)) && !!FAMILY_VISUAL[family];
  const raw = {piece:str(record.Pieza),quadrant:str(record.Cuadrante),prosthesis:str(record.PzasProt),residual:str(record.ResPza)};
  const warnings = [];
  if (registered && normalized.family_id && registered !== normalized.family_id) warnings.push('registered_family_differs_from_current_catalog');
  let kind = 'none', teeth = [], root_teeth = [],slot_range=null,source_endpoints=null;
  if (family === '24' && raw.prosthesis) {
    const parsed = parseToothList(raw.prosthesis);teeth = parsed.teeth;warnings.push(...parsed.warnings);kind = teeth.length ? 'prosthesis' : 'unresolved';
  } else if (raw.piece && raw.piece !== '0') {
    if (/^\d{2}$/.test(raw.piece) && VALID_TEETH.has(Number(raw.piece))) {kind='single';teeth=[Number(raw.piece)];}
    else if (/^\d{4}$/.test(raw.piece) && RANGE_FAMILIES.has(family)) {
      const start=Number(raw.piece.slice(0,2)),end=Number(raw.piece.slice(2));
      const range=expandEurodentRange(start,end);
      if (range) {kind='range';teeth=range;}
      else {
        const a=slotEndpoint(start),b=slotEndpoint(end),slots=a&&b?expandEurodentRange(a,b):null;
        if(slots){kind='range';teeth=slots;source_endpoints=[start,end];slot_range={from:a,to:b,virtual:true};}
        else {kind='unresolved';warnings.push('tooth_range_unresolved');}
      }
    } else {kind='unresolved';warnings.push('tooth_code_unresolved');}
  }
  if (family === '24' && !raw.prosthesis && kind !== 'none') warnings.push('prosthesis_parts_not_recorded');
  // ResPza equals the complete encoded range in every source bridge that has it.
  // A range alone cannot establish individual abutment/pontic roles. Do not
  // reinterpret its endpoints as a clinically confirmed pair of abutments.
  let surfaces=[];
  if (SURFACE_FAMILIES.has(family) && teeth.length===1) {
    const decoded=decodeEurodentSurfaces(raw.quadrant,teeth[0]);surfaces=decoded.surfaces;warnings.push(...decoded.warnings);
    if (graphic && !surfaces.length) warnings.push('surface_not_recorded');
  }
  if (graphic && !teeth.length && !normalized.no_tooth) warnings.push('graphic_location_not_recorded');
  const type=graphic ? (family===normalized.family_id?normalized.visual_type || FAMILY_VISUAL[family]:FAMILY_VISUAL[family]) || null : null;
  return {version:1,family_id:family || null,family_name:FAMILY_NAMES[family] || 'Familia sin identificar',catalog_family_id:normalized.family_id,graphic,kind,teeth,surfaces,root_teeth,root_roles_recorded:false,slot_range,source_endpoints,raw,visual_type:type,needs_review:warnings.some(code => code !== 'registered_family_differs_from_current_catalog'),warnings:unique(warnings)};
}

const CP1252_TO_BYTE = {8364:128,8218:130,402:131,8222:132,8230:133,8224:134,8225:135,710:136,8240:137,352:138,8249:139,338:140,381:142,8216:145,8217:146,8220:147,8221:148,8226:149,8211:150,8212:151,732:152,8482:153,353:154,8250:155,339:156,382:158,376:159};
function decodeEurodentDentition(record = {},decodedFields = {}) {
  const text = str(first(decodedFields.Piezas,record.Piezas));
  if (!text) return {teeth:[],warnings:[]};
  const slots = [11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48];
  const warnings=[],teeth=[];
  if ([...text].length !== 32) warnings.push('dentition_layout_length_unresolved');
  [...text].forEach((char,index) => {
    const point=char.codePointAt(0),byte=CP1252_TO_BYTE[point] || point;
    if (byte === 100) return; // Empty drawing slot is NOT a diagnosis of a missing tooth.
    const tooth=byte-100,slot=slots[index];
    if (VALID_TEETH.has(tooth) && (tooth === slot || tooth === slot+40)) teeth.push(tooth);
    else warnings.push('dentition_slot_unresolved');
  });
  return {teeth:unique(teeth),warnings:unique(warnings)};
}

function sourceDate(value) {
  const text=str(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0,10);
  const match=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s/);
  if (!match) return text || null;
  let year=Number(match[3]);if(year<100)year+=year>=40?1900:2000;
  return `${year}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;
}

function projectEurodentOdontogram(envelopes = [],options = {}) {
  const teeth=new Map(ALL_TEETH.map(number => [number,{number,status:'unknown',marks:[]}]));
  const unresolved=[],warnings=[],layoutTeeth=[],items=[],catalog=[];
  const counts={prior:0,performed:0,pending:0,budget:0,financial:0,non_graphic:0,unresolved:0,state_rows:0};
  const configurationTables=[];
  for (const envelope of envelopes) {
    const record=envelope.record || envelope.raw || {},table=str(envelope.source_table);
    if (table==='Piezas' || table==='Piezas_pri') {
      counts.state_rows++;configurationTables.push(table);
      const result=decodeEurodentDentition(record,envelope.decoded_fields || {});layoutTeeth.push(...result.teeth);warnings.push(...result.warnings);continue;
    }
    if (!SOURCE_TABLES.has(table)) continue;
    const cat=envelope.catalog || {},location=normalizeEurodentDentalLocation(record,cat),normalized=normalizeEurodentCatalogItem(cat);
    if (normalized.source_id && !catalog.some(item => item.source_id===normalized.source_id)) catalog.push(normalized);
    const source_pk=sourcePrimaryKey(envelope.source_pk,record);
    const id=[str(envelope.source_instance || options.source_instance),str(envelope.source_database),table,source_pk].join(':');
    if (normalized.classification==='financial' || location.family_id==='0' || ['C','A'].includes(str(record.Tipolin))) {counts.financial++;continue;}
    const state=table==='Primera_Visita'?'prior':table==='Historial'?'performed':table==='Trabajo_Pendiente'?'pending':'budget';counts[state]++;
    const origin=state==='prior'?'existing':state==='performed'?'performed':'proposed';
    const label=str(first(cat.name,cat.Nombre,record.Obs)) || 'Tratamiento de origen';
    const item={id,visual_type:location.visual_type,origin,state,surfaces:location.surfaces,source_table:table,source_pk,date:sourceDate(record.Fecha),label,family_id:location.family_id,visible:true,location,budget_source_id:table==='Presupuesto'?str(record.IDPre):null};
    items.push(item);
    if (!location.graphic) {counts.non_graphic++;continue;}
    if (!location.teeth.length || location.needs_review) {unresolved.push({id,label,source_table:table,source_pk,warnings:location.warnings});counts.unresolved++;}
    for (const number of location.teeth) {
      const mark={...item};
      if (location.family_id==='11') {
        mark.root_role=location.root_teeth.length?(location.root_teeth.includes(number)?'abutment':'pontic'):'unspecified';
        if (mark.root_role==='pontic') mark.visual_type='puente-pontico';
      }
      const tooth=teeth.get(number);if(!location.slot_range?.virtual)tooth.status='observed';tooth.marks.push(mark);
    }
  }
  for (const tooth of teeth.values()) {
    tooth.marks.sort((a,b)=>(a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id,undefined,{numeric:true}));
    // Display latest evidence per layer/visual group; original rows remain inspectable.
    const latest=new Map();
    for (const mark of tooth.marks) {
      const layer=mark.origin==='proposed'?(mark.source_table==='Presupuesto'?`Presupuesto:${mark.budget_source_id}`:mark.source_table):'historical';
      const group=SURFACE_FAMILIES.has(mark.family_id)?`surface:${mark.surfaces.slice().sort().join('')}`:mark.visual_type;
      const key=`${layer}:${group}`;
      if (latest.has(key)) latest.get(key).visible=false;
      latest.set(key,mark);
      if (mark.origin!=='proposed' && ['3','13','14','19','5'].includes(mark.family_id)) {
        for (const previous of tooth.marks) {
          if (previous===mark) break;
          if (previous.origin!=='proposed') previous.visible=false;
        }
      }
    }
  }
  const observed=unique([...layoutTeeth,...[...teeth.values()].filter(tooth=>tooth.status==='observed').map(tooth=>tooth.number)]);
  const hasTemporary=observed.some(isTemporary),hasPermanent=observed.some(tooth=>!isTemporary(tooth));
  return {version:'eurodent_odontogram/1',read_only:true,source_instance:options.source_instance || str(envelopes.find(item=>item.source_instance)?.source_instance) || null,cutoff:options.cutoff || options.at || null,configuration:counts.state_rows?{dated:false,source_tables:unique(configurationTables)}:null,dentition:hasTemporary?(hasPermanent?'mixed':'temporary'):'permanent',teeth:[...teeth.values()],items,unresolved,warnings:unique(warnings),counts,catalog:options.catalog ? options.catalog.map(normalizeEurodentCatalogItem) : catalog};
}

module.exports={FAMILY_NAMES,normalizeEurodentCatalogItem,normalizeEurodentDentalLocation,decodeEurodentSurfaces,decodeEurodentDentition,expandEurodentRange,projectEurodentOdontogram};
