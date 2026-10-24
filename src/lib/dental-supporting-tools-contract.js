'use strict';
const crypto = require('node:crypto');
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code: 'dental_tools_' + code, message, statusCode }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value, max = 1000, required = false) {
  if ((value === undefined || value === null || value === '') && !required) return '';
  if (typeof value !== 'string' || value.includes('\0') || value.trim().length > max || required && !value.trim()) fail('text_invalid', 'Revisa el texto de la herramienta.');
  return value.trim();
}
function id(value) { const result = text(value, 80, true); if (!/^[a-zA-Z0-9_:-]+$/.test(result)) fail('identifier_invalid', 'La referencia no es válida.'); return result; }
function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('number_invalid', 'Revisa el número indicado.'); return value; }
function number(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('number_invalid', 'Revisa la medición indicada.'); return value; }
function bool(value) { if (typeof value !== 'boolean') fail('boolean_invalid', 'Indica expresamente la opción.'); return value; }
function choice(value, values) { if (!values.includes(value)) fail('option_invalid', 'Selecciona una opción válida.'); return value; }
function list(value, max = 100) { if (!Array.isArray(value) || value.length > max) fail('list_invalid', 'La lista de registros no es válida.'); return value; }
function ids(value = [], max = 100) { const out = list(value, max).map(id); if (new Set(out).size !== out.length) fail('duplicate_reference', 'Hay una referencia repetida.'); return out; }
function date(value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('date_invalid', 'Indica una fecha válida.');
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('date_invalid', 'Indica fecha y hora con su zona horaria.');
  const iso = new Date(value).toISOString(); date(value.slice(0,10)); return iso;
}
function tooth(value) { integer(value, 11, 85); const q = Math.floor(value / 10), p = value % 10; if (!(q <= 4 && p >= 1 && p <= 8 || q >= 5 && q <= 8 && p >= 1 && p <= 5)) fail('tooth_invalid', 'La pieza dental no es válida.'); return value; }
const SURFACES = ['M','O','D','V','P','L','I'];
function surfaces(value = []) { const result = list(value, 7).map(v => choice(v, SURFACES)); if (new Set(result).size !== result.length) fail('surface_duplicate', 'Hay una superficie repetida.'); return result; }
function targets(value = []) { return list(value, 100).map(target => {
  if (!object(target)) fail('target_invalid', 'Indica el alcance clínico.');
  const kind = choice(target.kind, ['tooth','arch','general']);
  if (kind === 'tooth') return { kind, tooth: tooth(target.tooth), surfaces: surfaces(target.surfaces), ...(target.bridgeRole ? { bridgeRole: choice(target.bridgeRole, ['pillar','pontic']) } : {}) };
  return kind === 'arch' ? { kind, arch: choice(target.arch, ['upper','lower','both']) } : { kind, label: text(target.label, 160, true) };
}); }
function relations(value = {}) {
  return { targets: targets(value.targets), act_ids: ids(value.act_ids), session_ids: ids(value.session_ids), appointment_ids: list(value.appointment_ids || [], 100).map(value => integer(value)) };
}
function emptyState() { return { schema_version: 1, odontogram: null, periodontal_records: [], evidences: [], lab_orders: [], messages: [] }; }
function point(value) {
  if (!object(value)) fail('periodontal_point_invalid', 'Falta un punto del sondaje.');
  return { profundidad: number(value.profundidad, 0, 15), sangrado: bool(value.sangrado), supuracion: bool(value.supuracion),
    ...(value.nivelInsercion === undefined ? {} : { nivelInsercion: number(value.nivelInsercion, -15, 30) }),
    ...(value.recesion === undefined ? {} : { recesion: number(value.recesion, -15, 20) }) };
}
function periodontal(value, ctx, previous) {
  if (!object(value)) fail('periodontal_invalid', 'Revisa el periodontograma.');
  const mediciones = list(value.mediciones, 52).map(m => {
    if (!object(m)) fail('periodontal_invalid', 'Revisa los valores del sondaje.');
    const side = input => { if (!object(input)) fail('periodontal_point_invalid', 'Completa los seis puntos por pieza.'); return Object.fromEntries(['distal','medio','mesial'].map(k => [k, point(input[k])])); };
    return { numero: tooth(m.numero), vestibular: side(m.vestibular), lingual: side(m.lingual), movilidad: integer(m.movilidad, 0, 3),
      ...(m.furca === undefined ? {} : { furca: integer(m.furca, 0, 3) }), placa: bool(m.placa), calculo: bool(m.calculo) };
  });
  if (!mediciones.length || new Set(mediciones.map(m => m.numero)).size !== mediciones.length) fail('periodontal_invalid', 'Indica piezas distintas con mediciones.');
  return { id: previous?.id || ctx.newId(), pacienteId: String(ctx.patientId), fecha: timestamp(value.fecha), profesionalId: String(ctx.actorId), profesionalNombre: ctx.actorName,
    mediciones, notas: text(value.notas, 5000), version: (previous?.version || 0) + 1, created_at: previous?.created_at || ctx.at, updated_at: ctx.at,
    ...(value.indiceGingival === undefined ? {} : { indiceGingival: number(value.indiceGingival, 0, 100) }),
    ...(value.indicePlaca === undefined ? {} : { indicePlaca: number(value.indicePlaca, 0, 100) }) };
}
function odontogram(value, ctx) {
  if (!object(value)) fail('odontogram_invalid', 'Revisa el odontograma inicial.');
  const dentition = choice(value.dentition, ['permanent','temporary','mixed']);
  const pieces = list(value.pieces, 52).map(piece => {
    if (!object(piece)) fail('odontogram_invalid', 'La pieza del odontograma no es válida.');
    const numero = tooth(piece.numero), q = Math.floor(numero / 10), pos = numero % 10, quadrant = q > 4 ? q - 4 : q;
    if (dentition === 'permanent' && q > 4 || dentition === 'temporary' && q < 5) fail('dentition_invalid', 'La pieza no corresponde a la dentición elegida.');
    const surfaceValues = list(piece.superficies, 7).map(s => ({ superficie: choice(s.superficie, SURFACES), estado: choice(s.estado, ['sano','caries','empaste','empaste_programado','fractura']) }));
    if (new Set(surfaceValues.map(s=>s.superficie)).size !== surfaceValues.length) fail('surface_duplicate', 'Hay una superficie repetida.');
    const tratamientos = list(piece.tratamientos || [], 100).map(t => {
      if (!object(t) || t.origen && !['existente','ausente'].includes(t.origen) || ['pendiente','programado','en_curso'].includes(t.estado)) fail('baseline_execution_invalid', 'El odontograma inicial sólo registra observaciones previas. Planifica y realiza actos desde el plan.');
      return { id: id(t.id), nombre: text(t.nombre, 160, true), icono: /^heroicons_(outline|solid):[a-z-]+$/.test(t.icono) ? t.icono : 'heroicons_outline:document-text',
        estado: choice(t.estado, ['completado','cancelado']), orden: integer(t.orden, 0, 100), superficies: surfaces(t.superficies),
        ...(t.tipoVisual ? { tipoVisual: id(t.tipoVisual) } : {}), origen: t.origen || 'existente', ...(t.fechaRealizacion ? { fechaRealizacion: timestamp(t.fechaRealizacion) } : {}) };
    });
    return { numero, tipo: pos >= 6 || q > 4 && pos >= 4 ? 'molar' : pos >= 4 ? 'premolar' : pos === 3 ? 'canino' : pos === 2 ? 'incisivo_lateral' : 'incisivo_central',
      arcada: quadrant <= 2 ? 'superior' : 'inferior', cuadrante: quadrant, estado: choice(piece.estado, ['sano','caries','empaste','endodoncia','corona','implante','ausente','extraccion_indicada','protesis','puente_pilar','puente_pontico']),
      superficies: surfaceValues, tratamientos, notas: text(piece.notas, 2000) };
  });
  if (new Set(pieces.map(p=>p.numero)).size !== pieces.length) fail('tooth_duplicate', 'Hay una pieza repetida.');
  return { dentition, pieces, observed_at: timestamp(value.observed_at || ctx.at), author_id: ctx.actorId, updated_at: ctx.at };
}
const CLINICAL_COMMANDS = new Set(['odontogram.save','periodontal.save','evidence.annotate','evidence.review','lab.review','lab.rework']);
const COMMANDS = new Set([...CLINICAL_COMMANDS,'evidence.add','evidence.update','evidence.archive','lab.create','lab.update','lab.request','lab.receive','lab.attach','lab.delivery','message.add']);
function find(list, identifier, kind) { const item = list.find(item => item.id === id(identifier)); if (!item) fail(kind + '_not_found', 'El registro no está disponible en este plan.', 404); return item; }
function applyCommand(previous, command, ctx) {
  if (!object(command) || !COMMANDS.has(command.type)) fail('command_invalid', 'La acción dental no está disponible.');
  if (CLINICAL_COMMANDS.has(command.type) && !ctx.clinical) fail('clinical_forbidden', 'Esta acción requiere revisión del profesional clínico.', 403);
  const state = clone(previous || emptyState());
  if (command.type === 'odontogram.save') state.odontogram = odontogram(command.odontogram, ctx);
  if (command.type === 'periodontal.save') {
    const existing = command.record?.id && command.record.id!=='nuevo' ? find(state.periodontal_records, command.record.id, 'periodontal') : null;
    const record = periodontal(command.record, ctx, existing);
    state.periodontal_records = [...state.periodontal_records.filter(item=>item.id!==record.id), record];
  }
  if (command.type === 'evidence.add') {
    const source = command.evidence; if (!object(source)) fail('evidence_invalid', 'Revisa la prueba clínica.');
    const kind = choice(source.kind, ['rx','photo','stl','physical','pdf']);
    const assetId = source.asset_id ? id(source.asset_id) : null;
    if (kind !== 'physical' && !assetId || kind === 'physical' && assetId) fail('evidence_asset_invalid', 'La prueba necesita su archivo original; un modelo físico se registra sin archivo.');
    state.evidences.push({ id: ctx.newId(), title: text(source.title, 180, true), kind, asset_id: assetId, ...relations(source), notes: text(source.notes, 5000),
      required: source.required === undefined ? false : bool(source.required), clinical_status: 'pending',
      annotations: [], observed_on: date(source.observed_on || ctx.at.slice(0,10)), author_id: ctx.actorId, created_at: ctx.at, status: 'active' });
  }
  if (command.type === 'evidence.update') {
    const item = find(state.evidences, command.id, 'evidence'), patch = command.patch;
    if (!object(patch) || item.status !== 'active') fail('evidence_invalid', 'La prueba no se puede editar.');
    if(!ctx.clinical&&item.required&&['targets','act_ids','session_ids','appointment_ids'].some(key=>Object.hasOwn(patch,key)))fail('clinical_forbidden','El profesional debe revisar el alcance de una prueba requerida.',403);
    for (const key of Object.keys(patch)) if (!['title','notes','targets','act_ids','session_ids','appointment_ids'].includes(key)) fail('evidence_field_invalid', 'No se puede sustituir el archivo original de una prueba.');
    if (patch.title !== undefined) item.title = text(patch.title, 180, true);
    if (patch.notes !== undefined) item.notes = text(patch.notes, 5000);
    Object.assign(item, relations({ ...item, ...patch }), { updated_at: ctx.at, updated_by: ctx.actorId });
    item.clinical_status='pending';delete item.reviewed_by;delete item.reviewed_at;
  }
  if (command.type === 'evidence.archive') {
    const item = find(state.evidences, command.id, 'evidence');
    if (state.lab_orders.some(order=>order.evidence_ids.includes(item.id))) fail('evidence_in_use', 'La prueba está referenciada por un pedido. Conserva su procedencia o desvincúlala antes de archivar.', 409);
    item.status = 'archived'; item.archived_at = ctx.at; item.archived_by = ctx.actorId;
  }
  if (command.type === 'evidence.annotate') {
    const item = find(state.evidences, command.id, 'evidence');
    if (!['photo','rx'].includes(item.kind) || item.status !== 'active') fail('annotation_invalid', 'Sólo se anotan imágenes clínicas activas.');
    item.annotations = list(command.annotations,100).map(a => ({ id: a.id ? id(a.id) : ctx.newId(), x: number(a.x,0,1), y: number(a.y,0,1), text: text(a.text,500,true), author_id: ctx.actorId, updated_at: ctx.at }));
  }
  if (command.type === 'evidence.review') {
    const item=find(state.evidences,command.id,'evidence');if(item.status!=='active')fail('evidence_invalid','La prueba está archivada.');
    item.clinical_status=choice(command.decision,['approved','rejected']);item.review_notes=text(command.notes,2000,item.clinical_status==='rejected');item.reviewed_by=ctx.actorId;item.reviewed_at=ctx.at;
  }
  if (command.type === 'lab.create') {
    const order = command.order; if (!object(order)) fail('lab_invalid','Revisa el pedido de laboratorio.');
    state.lab_orders.push({ id: ctx.newId(), title: text(order.title,180,true), laboratory: text(order.laboratory,180,true), supplier_id: order.supplier_id ? id(order.supplier_id) : null, instructions: text(order.instructions,5000), ...relations(order),
      request_session_id: order.request_session_id ? id(order.request_session_id) : null, needed_session_id: order.needed_session_id ? id(order.needed_session_id) : null,
      appointment_id: order.appointment_id == null ? null : integer(order.appointment_id), request_before: date(order.request_before,true), needed_on: date(order.needed_on,true), expected_delivery_on: date(order.expected_delivery_on,true),
      evidence_ids: ids(order.evidence_ids), status: 'draft', events: [{ type: 'created', actor_id: ctx.actorId, at: ctx.at }], created_by: ctx.actorId, created_at: ctx.at });
  }
  if (command.type === 'lab.update') {
    const order = find(state.lab_orders,command.id,'lab'), patch=command.patch;
    if (order.status !== 'draft' || !object(patch)) fail('lab_state','Sólo se edita un pedido todavía en borrador.',409);
    if(!ctx.clinical&&['targets','act_ids','session_ids','appointment_ids','request_session_id','needed_session_id','appointment_id'].some(key=>Object.hasOwn(patch,key)))fail('clinical_forbidden','El profesional debe revisar el alcance clínico del pedido.',403);
    for (const key of Object.keys(patch)) if (!['title','laboratory','supplier_id','instructions','targets','act_ids','session_ids','appointment_ids','request_session_id','needed_session_id','appointment_id','request_before','needed_on','expected_delivery_on'].includes(key)) fail('lab_field_invalid','El estado del pedido requiere su propia acción.');
    if (Object.hasOwn(patch,'supplier_id')) order.supplier_id = patch.supplier_id ? id(patch.supplier_id) : null;
    else if (patch.laboratory !== undefined && patch.laboratory !== order.laboratory) order.supplier_id = null;
    for(const key of ['title','laboratory']) if(patch[key]!==undefined)order[key]=text(patch[key],180,true);
    if(patch.instructions!==undefined)order.instructions=text(patch.instructions,5000);
    Object.assign(order,relations({...order,...patch}));
    for(const key of ['request_session_id','needed_session_id'])if(patch[key]!==undefined)order[key]=patch[key]===null?null:id(patch[key]);
    if(patch.appointment_id!==undefined)order.appointment_id=patch.appointment_id===null?null:integer(patch.appointment_id);
    for(const key of ['request_before','needed_on','expected_delivery_on'])if(patch[key]!==undefined)order[key]=date(patch[key],true);
    order.events.push({type:'edited',actor_id:ctx.actorId,at:ctx.at});
  }
  if (command.type === 'lab.request') { const order=find(state.lab_orders,command.id,'lab');if(order.status!=='draft')fail('lab_state','El pedido ya se ha solicitado.',409);order.status='requested';order.requested_on=date(command.requested_on||ctx.at.slice(0,10));order.events.push({type:'requested',actor_id:ctx.actorId,at:ctx.at,notes:text(command.notes,2000)}); }
  if (command.type === 'lab.delivery') { const order=find(state.lab_orders,command.id,'lab');if(!['draft','requested'].includes(order.status))fail('lab_state','El pedido ya está recibido; consulta su fecha registrada.',409);order.expected_delivery_on=date(command.expected_delivery_on);order.events.push({type:'delivery_estimated',actor_id:ctx.actorId,at:ctx.at,expected_delivery_on:order.expected_delivery_on,notes:text(command.notes,2000)}); }
  if (command.type === 'lab.receive') { const order=find(state.lab_orders,command.id,'lab');if(order.status!=='requested')fail('lab_state','Registra la recepción de un pedido solicitado.',409);const received=date(command.received_on||ctx.at.slice(0,10));if(received<order.requested_on)fail('lab_date','La recepción no puede ser anterior a la solicitud.');order.status='received';order.received_on=received;order.events.push({type:'received',actor_id:ctx.actorId,at:ctx.at,notes:text(command.notes,2000)}); }
  if (command.type === 'lab.review') { const order=find(state.lab_orders,command.id,'lab');if(order.status!=='received')fail('lab_state','La conformidad clínica requiere recepción física previa.',409);order.status=choice(command.decision,['approved','rejected']);const notes=text(command.notes,2000,order.status==='rejected');order.reviewed_at=ctx.at;order.reviewed_by=ctx.actorId;order.events.push({type:order.status,actor_id:ctx.actorId,at:ctx.at,notes}); }
  if (command.type === 'lab.rework') { const order=find(state.lab_orders,command.id,'lab');if(order.status!=='rejected')fail('lab_state','El ajuste requiere una revisión clínica que rechace el trabajo.',409);const notes=text(command.notes,2000,true);order.status='requested';order.requested_on=ctx.at.slice(0,10);if(command.instructions!==undefined)order.instructions=text(command.instructions,5000);if(command.needed_on!==undefined)order.needed_on=date(command.needed_on,true);delete order.received_on;delete order.reviewed_at;delete order.reviewed_by;order.events.push({type:'rework_requested',actor_id:ctx.actorId,at:ctx.at,notes}); }
  if (command.type === 'lab.attach') { const order=find(state.lab_orders,command.id,'lab');order.evidence_ids=ids(command.evidence_ids);if(order.status==='approved'||order.status==='rejected'){order.status='received';delete order.reviewed_at;delete order.reviewed_by;}order.events.push({type:'evidence_linked',actor_id:ctx.actorId,at:ctx.at}); }
  if (command.type === 'message.add') {
    const context=command.context||{kind:'plan'};const kind=choice(context.kind,['plan','session','evidence','lab_order']);
    state.messages.push({id:ctx.newId(),text:text(command.text,5000,true),context:{kind,...(kind==='plan'?{}:{id:id(context.id)})},author_id:ctx.actorId,author_name:ctx.actorName,created_at:ctx.at});
  }
  for(const collection of [state.periodontal_records,state.evidences,state.lab_orders,state.messages]) if(collection.length>1000)fail('limit','Este plan supera el límite de registros de la herramienta.',413);
  if(Buffer.byteLength(JSON.stringify(state),'utf8')>3*1024*1024)fail('size','El contenido de las herramientas es demasiado extenso.',413);
  return state;
}
function validateFile({filename,content_type,data_base64}) {
  filename=text(filename,180,true).replace(/[\\/]/g,'-');
  const mime=choice(content_type,['application/pdf','image/jpeg','image/png','image/webp','model/stl','application/sla','application/octet-stream']);
  // 18 MiB occupies 24 MiB as base64 and remains within the existing API
  // JSON body limit, without raising it for every other route.
  if(typeof data_base64!=='string'||data_base64.length>24*1024*1024||!data_base64.length||data_base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data_base64))fail('file_invalid','El archivo no tiene una codificación válida.');
  const buffer=Buffer.from(data_base64,'base64');if(!buffer.length||buffer.length>18*1024*1024)fail('file_size','El archivo supera el máximo de 18 MB.',413);
  let type=mime;
  if(mime==='application/pdf'&&!buffer.subarray(0,5).equals(Buffer.from('%PDF-')))fail('file_signature','El archivo no corresponde a un PDF.');
  if(mime==='image/png'&&!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('file_signature','El archivo no corresponde a una imagen PNG.');
  if(mime==='image/jpeg'&&!(buffer[0]===255&&buffer[1]===216&&buffer[2]===255))fail('file_signature','El archivo no corresponde a una imagen JPEG.');
  if(mime==='image/webp'&&!(buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP'))fail('file_signature','El archivo no corresponde a una imagen WEBP.');
  if(['model/stl','application/sla','application/octet-stream'].includes(mime)) {
    if(!/\.stl$/i.test(filename))fail('stl_filename','El modelo debe ser un archivo STL.');
    let triangles=0;
    if(buffer.length>=84&&84+buffer.readUInt32LE(80)*50===buffer.length){triangles=buffer.readUInt32LE(80);if(!triangles||triangles>300000)fail('stl_size','El modelo STL supera el límite de triángulos.');for(let offset=84;offset<buffer.length;offset+=50)for(let i=0;i<12;i++)if(!Number.isFinite(buffer.readFloatLE(offset+i*4)))fail('stl_coordinate','El modelo contiene coordenadas no válidas.');}
    else {
      const ascii=buffer.toString('latin1'),header=/^solid[^\r\n]*[\r\n]+/.exec(ascii),footer=/\s*endsolid[^\r\n]*(?:[\r\n]+\s*)?$/.exec(ascii);
      if(!header||!footer||/[^\x09\x0a\x0d\x20-\x7e]/.test(ascii))fail('stl_invalid','El modelo STL no es válido.');
      const body=ascii.slice(header[0].length,footer.index);
      const facet=/facet\s+normal\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+outer\s+loop\s+vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+endloop\s+endfacet/g;
      const facets=[...body.matchAll(facet)];triangles=facets.length;
      if(!triangles||triangles>300000||facets.some(f=>f.slice(1).some(n=>!Number.isFinite(Number(n))))||body.replace(facet,'').trim())fail('stl_invalid','El modelo STL no contiene triángulos válidos.');
    }
    type='application/octet-stream';
  }
  return {filename,contentType:type,buffer,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
}
module.exports={fail,object,clone,hash,text,id,integer,date,targets,relations,emptyState,periodontal,odontogram,CLINICAL_COMMANDS,COMMANDS,applyCommand,validateFile};
