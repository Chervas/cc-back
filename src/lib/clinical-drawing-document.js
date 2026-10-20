'use strict';

const VIEWS = {
  facial: ['front', 'left', 'right'],
  corporal: ['front', 'back'],
  capilar: ['front', 'back', 'left', 'right', 'top', 'crown'],
  image: ['original'],
};
const COLORS = new Set(['#4f46e5', '#dc2626', '#059669', '#0f172a', '#f59e0b']);
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400, code: 'clinical_drawing_invalid' }); };
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => typeof v === 'string' && !v.includes('\0') && Array.from(v).length <= max ? v : fail('El texto del modelo no es válido.');
// Do not coerce arrays/objects into IDs or write magic properties onto a view.
const identity = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v)
  && !['__proto__', 'constructor', 'prototype'].includes(v) ? v : fail('La referencia del modelo no es válida.');
function point(p) {
  if (!record(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) fail('El dibujo contiene coordenadas fuera de la imagen.');
  return { x: p.x, y: p.y };
}

// Data only: no SVG, HTML, data URLs, binary embeds or executable markup.
// Coordinates are normalized to the unmodified image/model, independent of zoom.
function validateDrawingDocument(input, templateKey) {
  const allowed = Object.hasOwn(VIEWS, templateKey) ? VIEWS[templateKey] : null;
  if (!allowed || !record(input) || input.version !== 1 || !record(input.views)) fail('El formato del modelo no es válido.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 512 * 1024) fail('El dibujo es demasiado grande. Divide las anotaciones en otro modelo.');
  const result = { version: 1, views: {} };
  let totalPoints = 0;
  for (const [key, view] of Object.entries(input.views)) {
    if (!(allowed.includes(key) || (templateKey === 'image' && /^page-([1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(key))) || !record(view)) fail('La vista anatómica no es válida.');
    const strokes = view.strokes === undefined ? [] : view.strokes, notes = view.notes === undefined ? [] : view.notes,
      photos = view.photos === undefined ? [] : view.photos, regions = view.regions === undefined ? {} : view.regions;
    if (!Array.isArray(strokes) || strokes.length > 400 || !Array.isArray(notes) || notes.length > 100 || !Array.isArray(photos) || photos.length > 50 || !record(regions) || Object.keys(regions).length > 80) fail('Hay demasiadas anotaciones en esta vista.');
    const ids = new Set();
    const unique = id => { const value = identity(id); if (ids.has(value)) fail('Hay anotaciones duplicadas.'); ids.add(value); return value; };
    const out = { strokes: [], notes: [], photos: [], regions: {} };
    for (const stroke of strokes) {
      if (!record(stroke) || !['pen', 'line', 'arrow', 'ellipse'].includes(stroke.type)
        || !COLORS.has(stroke.color) || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 12
        || !Array.isArray(stroke.points) || stroke.points.length < (stroke.type === 'pen' ? 1 : 2)
        || stroke.points.length > 4096 || (stroke.type !== 'pen' && stroke.points.length !== 2)) fail('Uno de los trazos no es válido.');
      totalPoints += stroke.points.length;
      if (totalPoints > 30000) fail('El dibujo tiene demasiados puntos.');
      out.strokes.push({ id: unique(stroke.id), type: stroke.type, color: stroke.color, width: stroke.width, points: stroke.points.map(point) });
    }
    for (const note of notes) {
      if (!record(note)) fail('La anotación no es válida.');
      out.notes.push({ id: unique(note.id), ...point(note), text: text(note.text, 2000) });
    }
    for (const [region, note] of Object.entries(regions)) out.regions[identity(region)] = text(note, 4000);
    for (const photo of photos) {
      if (!record(photo)) fail('La foto no es válida.');
      out.photos.push({ id: identity(photo.id), region: photo.region === undefined || photo.region === null ? null : identity(photo.region),
        caption: photo.caption === undefined || photo.caption === null ? null : text(photo.caption, 500) });
    }
    result.views[key] = out;
  }
  return result;
}
module.exports = { VIEWS, COLORS, validateDrawingDocument };
