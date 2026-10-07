'use strict';

// Offline evidence, not a catalogue mutation package or clinical configuration.
const { norm, hash, stableJson } = require('./adapter');
const { buildCatalogPlan, grossPrice } = require('./catalog');
const { clientReplies } = require('./catalog-replies');

const WORKBOOK_SHA = 'cc1beeda3e882f2811f08a0111b5ddab660dff973b7d79d1bec48367ef0705aa';
const REPLIES_SHA = 'a60440cf19a69c5bc352351321e54b58d708c5390fe1033e666c694b11186775';
const ARCHIVE_SHA = '055c78f49197774f242bd86e15aa720738e2d565ee4a459e7b9daed4f17aadfa';
const PDF_SOURCES = [
    ['Tarifa-2026-Corporal.pdf', 'corporal', 'tariff', 6, '57137efdbc73c6aacc03e817165e0a984dbf72b8bffd8c6120b2c0914d7a6068'],
    ['Tarifa-2026-Capilar (1).pdf', 'capilar', 'tariff', 6, '55081499fbb0338bc356fbc2534f6ac8c468f356071ebf0f536be5dc28e8793d'],
    ['Tarifa-2026-Facial.pdf', 'facial', 'tariff', 8, 'd913b9c1f0ef41df495bdf82fa46b0a93c58cc8f9e1d744a040e2be0dfc219c3'],
    ['Tarifa-2026-Obesidad (2).pdf', 'obesidad', 'tariff', 6, 'e5f1158c07ead27bfbcf2139d2011f657bc547a4f8a6944011347911fd3bc136'],
    ['Tarifa-2026-Cirugia-Plastica (1).pdf', 'cirugia', 'tariff', 7, '0d47372c2902f448222890dd98d8d051163ed38365ea9019f5dd4d2eca3587e9'],
    ['BS-Medical-V4-Obesidad-Tarifa-2026-coherente.pdf', 'obesidad', 'tariff', 8, 'ab66730b9a9784118a4c71c01c8e73d629143425854e36e836a4daa2f29b6913'],
    ['BS-Medical-V2-Facial-Tarifa-2026-coherrente.pdf', 'facial', 'tariff', 8, '9912feebdb219857cfe013ef966cba7e318be0234191e140d96a27244bdfb9b2'],
    ['BS-Medical-Protocolos-V1-Corporal (2) - copia.pdf', 'corporal', 'manual', 34, '5361917f6de9b68d52c18befcde09789fbeb674b7bbb2ec78c2aed27aa7000fc'],
    ['BS-Medical-Protocolos-V2-Facial (1).pdf', 'facial', 'manual', 81, '0f60f89771c425e9c91d468b3684fc1606c343207d39d8a521d6732b42b3cfae'],
    ['BS-Medical-Protocolos-V3-Capilar.pdf', 'capilar', 'manual', 44, '472dfeecb86324553bbf56e23b2541ee34af2884b46b77c8640cb83b61baeb50'],
    ['BS-Medical-Protocolos-V4-Obesidad.pdf', 'obesidad', 'manual', 45, 'ec28b4ea7bdfcb204afd6af0b2e638f8db1f570e3dc743fc82cec25e0c768672'],
].map(([file, area, role, pages, sha256]) => ({ file, area, role, pages, sha256 }));

const COLUMNS = ['record_type', 'matrix_key', 'code', 'clinic', 'area', 'kind', 'name', 'scope', 'proposed_action',
    'source_price_raw', 'source_gross_amount', 'source_price_mode', 'october_price_raw', 'october_gross_amount',
    'october_price_mode', 'effective_from', 'vat_rate', 'gross_includes_tax', 'quantity', 'duration_raw',
    'duration_json', 'october_duration_evidence_json', 'room_raw', 'staff_raw', 'equivalence_status', 'equivalent_new_name',
    'source_references_json', 'pending_json', 'notes'];

// Reviewed source-to-source links, NOT old-treatment ID equivalences. No name
// similarity matching. Pinned workbook hash protects the meaning of each row.
function reviewedBindings() {
    const links = [];
    const add = (sheet, row, file, page, label, units = null) => links.push({ sheet, row, file, page, label, units, role: units ? 'voucher' : 'primary' });
    const body = 'Tarifa-2026-Corporal.pdf';
    const bodyLabels = [
        [3, 1, 'CONSULTA DE VALORACIÓN CORPORAL'], [4, 1, 'CONSULTA DE PRESUPUESTO Y FINANCIACIÓN'],
        [5, 1, 'ESTUDIO CORPORAL BS'], [6, 1, 'VALORACIÓN DE LINFEDEMA POR SEGMENTOS'],
        [8, 3, 'DRENAJE LINFÁTICO MÉDICO'], [9, 3, 'POSTOPERATORIO COMBINADO CON INDIBA'],
        [11, 4, 'SESIÓN DE TRATAMIENTO DE LINFEDEMA'], [12, 5, 'LINFEDEMA · 1 SESIÓN'],
        [14, 4, 'SESIÓN ESTÁNDAR DE LIPEDEMA'], [16, 5, 'LIPEDEMA · 1 SESIÓN CADA 2-4 SEMANAS'],
        [15, 4, 'SESIÓN AMPLIADA DE LIPEDEMA · FASE DE ATAQUE'], [18, 3, 'INDIBA CORPORAL'],
        [19, 3, 'INDIBA · DOLOR PRE Y POST CIRUGÍA'], [21, 3, 'EXION BODY'],
        [22, 3, 'EXION BODY + INDIBA PREMIUM NS'], [24, 3, 'CYCLONE · SESIÓN COMPLETA'],
        [25, 3, 'HIFU CORPORAL AISLADO · 1 ZONA'], [26, 3, 'CAVITACIÓN Y RADIOFRECUENCIA SIN HIFU'],
        [28, 3, 'ONDAS ACÚSTICAS · 1 ZONA'], [29, 3, 'ONDAS ACÚSTICAS + RADIOFRECUENCIA'],
        [31, 4, 'EMSHAPE PRO · 1 ZONA'], [33, 4, 'EMSHAPE PRO · SUELO PÉLVICO'],
        [35, 4, 'CARBOXITERAPIA CORPORAL · 500 A 800 CC'], [36, 4, 'MESOTERAPIA LIPOLÍTICA Y ANTICELULÍTICA'],
        [37, 4, 'BIOESTIMULACIÓN CORPORAL · POR ZONA'], [38, 4, 'ESTRÍAS Y CICATRICES'],
    ];
    bodyLabels.forEach(([row, page, label]) => {
        add('Tratamientos individuales', row, body, page, label);
        [5, 10].forEach(units => add('Tratamientos individuales', row, body, page, label, units));
    });
    add('Programas y mantenimientos', 16, body, 1, 'ESTUDIO CORPORAL BS');
    [[23, 'CONTORNO · 1 SESIÓN AL MES'], [25, 'FIRMEZA · 1 SESIÓN CADA 6-8 SEMANAS'],
        [27, 'CELULITIS · 1 SESIÓN AL MES'], [29, 'TONO · 1 SESIÓN CADA 4-6 SEMANAS'],
        [31, 'LIPEDEMA · 1 SESIÓN CADA 2-4 SEMANAS'], [32, 'LINFEDEMA · 1 SESIÓN'],
        [33, 'SUELO PÉLVICO · 1 SESIÓN CADA 3 MESES']]
        .forEach(([row, label]) => add('Programas y mantenimientos', row, body, 5, label));
    const hair = 'Tarifa-2026-Capilar (1).pdf';
    [
        [3, 1, 'VALORACIÓN CAPILAR · ENFERMERÍA'], [4, 1, 'VALORACIÓN CAPILAR · MÉDICA'],
        [5, 1, 'DIAGNÓSTICO CAPILAR CON TRICOSCOPIA'],
        [6, 1, 'CONSULTA DE REVISIÓN'], [7, 1, 'CONSULTA DE ALTA'], [8, 1, 'LAVADO POSTQUIRÚRGICO'],
        [9, 1, 'ANALÍTICA CAPILAR PREQUIRÚRGICA'], [10, 1, 'ANALÍTICA HORMONAL'], [11, 1, 'RECETA MÉDICA INDIVIDUAL'],
        [15, 1, 'INJERTO CAPILAR · UNA SESIÓN'], [16, 1, 'INJERTO CAPILAR · SESIÓN Y MEDIA'],
        [17, 1, 'INJERTO CAPILAR · DOS SESIONES'], [18, 1, 'INJERTO DE BARBA'], [19, 1, 'INJERTO DE CEJAS'],
        [22, 3, 'MESOTERAPIA CON DUTASTERIDE'], [24, 3, 'PRP · PLASMA RICO EN PLAQUETAS'],
        [26, 3, 'VITAMINAS Y AMINOÁCIDOS'], [29, 3, 'HAIR FILLER'], [31, 3, 'DR. CYJ HAIR FILLER'],
        [33, 3, 'DERMAPEN CON FACTORES DE CRECIMIENTO'], [36, 3, 'CARBOXITERAPIA CAPILAR'],
        [39, 3, 'INDIBA CAPILAR · RADIOFRECUENCIA 448 KHZ'], [43, 3, 'FOTORREGENERACIÓN LED'],
        [45, 3, 'FOTORREGENERACIÓN LED · 6 SESIONES'], [46, 3, 'FOTORREGENERACIÓN LED · 9 SESIONES'],
    ].forEach(([row, page, label]) => add('Capilar · sesiones y bonos', row, hair, page, label));
    [[23, 'MESOTERAPIA CON DUTASTERIDE', 3], [25, 'PRP · PLASMA RICO EN PLAQUETAS', 3],
        [27, 'VITAMINAS Y AMINOÁCIDOS', 3], [30, 'HAIR FILLER', 4], [32, 'DR. CYJ HAIR FILLER', 4],
        [34, 'DERMAPEN CON FACTORES DE CRECIMIENTO', 4], [37, 'CARBOXITERAPIA CAPILAR', 3],
        [38, 'CARBOXITERAPIA CAPILAR', 6], [40, 'INDIBA CAPILAR · RADIOFRECUENCIA 448 KHZ', 3],
        [41, 'INDIBA CAPILAR · RADIOFRECUENCIA 448 KHZ', 6], [42, 'INDIBA CAPILAR · RADIOFRECUENCIA 448 KHZ', 10],
        [44, 'FOTORREGENERACIÓN LED', 3]].forEach(([row, label, units]) => add('Capilar · sesiones y bonos', row, hair, 3, label, units));
    const face = 'Tarifa-2026-Facial.pdf';
    [[3, 'CONSULTA DE VALORACIÓN MÉDICA'], [6, 'ÁCIDO HIALURÓNICO · 6 MESES'],
        [7, 'ÁCIDO HIALURÓNICO · 9 MESES'], [8, 'ÁCIDO HIALURÓNICO · 12 MESES'], [9, 'ÁCIDO HIALURÓNICO BODY'],
        [11, 'VISTABEL · 1 ZONA'], [12, 'VISTABEL · 3 ZONAS'],
        [13, 'NUCEIVA Y BOCOUTURE · 1 ZONA'], [14, 'NUCEIVA Y BOCOUTURE · 3 ZONAS'],
        [15, 'NUCEIVA Y BOCOUTURE · 1 ZONA'], [16, 'NUCEIVA Y BOCOUTURE · 3 ZONAS'],
        [18, 'RADIESSE'], [19, 'FACETEM'], [22, 'MESOTERAPIA VITAMINAS Y AH · 1 ZONA'],
        [24, 'MESOTERAPIA VITAMINAS Y AH · 3 ZONAS'], [28, 'MONOFILAMENTO'], [29, 'MONOFILAMENTO'],
        [30, 'MONOFILAMENTO'], [31, 'ESPICULADO'], [32, 'ESPICULADO']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 1, label));
    [[23, 'MESOTERAPIA VITAMINAS Y AH · 1 ZONA'], [25, 'MESOTERAPIA VITAMINAS Y AH · 3 ZONAS']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 1, label, 3));
    [[41, 'LESIONES CUTÁNEAS'], [42, 'BLEFAROPLASTIA COMPLETA'], [43, 'BLEFAROPLASTIA · PÁRPADO SUPERIOR'],
        [44, 'BLEFAROPLASTIA · PÁRPADO INFERIOR'], [45, 'PERIBUCAL COMPLETO'], [46, 'LABIO SUPERIOR'],
        [47, 'MEJILLAS'], [73, 'COSMELAN'], [74, 'DERMAMELAN']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 3, label));
    add('Facial · tratamientos', 79, face, 3, 'ÁCIDO GLICÓLICO');
    [[81, 'ÁCIDO SALICÍLICO · ROSTRO'], [83, 'ÁCIDO SALICÍLICO · ESPALDA'], [85, 'ÁCIDO MANDÉLICO']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 4, label));
    [[82, 'ÁCIDO SALICÍLICO · ROSTRO'], [84, 'ÁCIDO SALICÍLICO · ESPALDA'], [86, 'ÁCIDO MANDÉLICO']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 4, label, 4));
    [[49, 'PRP FACIAL'], [52, 'POLINUCLEÓTIDOS NORMALES'], [54, 'POLINUCLEÓTIDOS REJURAN'], [57, 'EXOSOMAS']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 2, label));
    [[50, 'PRP FACIAL'], [53, 'POLINUCLEÓTIDOS NORMALES'], [55, 'POLINUCLEÓTIDOS REJURAN'], [58, 'EXOSOMAS']]
        .forEach(([row, label]) => add('Facial · tratamientos', row, face, 2, label, 3));
    [[34, 3, 'EXION · CARA COMPLETA'], [36, 3, 'EXION · DOS TERCIOS INFERIORES'], [38, 3, 'EXION · CUELLO Y ESCOTE'],
        [61, 5, 'ONA ACNÉ · ROSTRO'], [63, 5, 'ONA ACNÉ · ESPALDA'], [65, 5, 'ONA HIGIENE PROFUNDA 4 EN 1']]
        .forEach(([row, page, label]) => add('Facial · tratamientos', row, face, page, label));
    [[35, 3, 'EXION · CARA COMPLETA', 3], [37, 3, 'EXION · DOS TERCIOS INFERIORES', 3],
        [39, 3, 'EXION · CUELLO Y ESCOTE', 3], [62, 5, 'ONA ACNÉ · ROSTRO', 4],
        [64, 5, 'ONA ACNÉ · ESPALDA', 4], [66, 5, 'ONA HIGIENE PROFUNDA 4 EN 1', 3]]
        .forEach(([row, page, label, units]) => add('Facial · tratamientos', row, face, page, label, units));
    const obesity = 'BS-Medical-V4-Obesidad-Tarifa-2026-coherente.pdf';
    [[5, 'Sesión de nutrición'], [6, 'Sesión de psicología'], [7, 'Sesión psiconutricional'],
        [11, 'Analítica de cirugía de obesidad'], [12, 'Pruebas cruzadas'], [13, 'Gastroscopia']]
        .forEach(([row, label]) => add('Obesidad · tarifa', row, obesity, 3, label));
    const obesityGeneral = 'Tarifa-2026-Obesidad (2).pdf';
    [[3, 'PRIMERA VISITA MÉDICA'], [4, 'PRIMERA VISITA MÉDICA'], [10, 'ANALÍTICA DE OBESIDAD'],
        [15, 'RECETA MÉDICA GLP-1'], [16, 'RECETA MÉDICA GLP-1 CON SEGUIMIENTO']]
        .forEach(([row, label]) => add('Obesidad · tarifa', row, obesityGeneral, 1, label));
    [[28, 'BALÓN INGERIBLE · 4 MESES'], [29, 'BALÓN ENDOSCÓPICO · 6 MESES'],
        [30, 'BALÓN ENDOSCÓPICO · 12 MESES'], [31, 'PUESTA Y RETIRADA'], [40, 'GASTRECTOMÍA TUBULAR · MANGA GÁSTRICA'],
        [41, 'BYPASS GÁSTRICO EN Y DE ROUX']]
        .forEach(([row, label]) => add('Obesidad · tarifa', row, obesityGeneral, 4, label));
    const surgery = 'Tarifa-2026-Cirugia-Plastica (1).pdf';
    [[3, 'PRIMERA VISITA · ENFERMERÍA'], [4, 'PRIMERA VISITA · CIRUJANO PLÁSTICO'],
        [5, 'CONSULTA DE PREANESTESIA'], [6, 'CONSULTA DE REVISIÓN'], [7, 'CONSULTA DE CURAS'],
        [10, 'ANALÍTICA PREQUIRÚRGICA'], [11, 'ELECTROCARDIOGRAMA'], [12, 'ECOGRAFÍA LATERAL O BILATERAL'],
        [13, 'MAMOGRAFÍA'], [14, 'PLACA DE TÓRAX']]
        .forEach(([row, label]) => add('Cirugía plástica · tarifa', row, surgery, 1, label));
    [[16, 'AUMENTO MAMARIO · PRÓTESIS REDONDAS'], [17, 'AUMENTO MAMARIO · PRÓTESIS ERGONÓMICAS'],
        [18, 'PEXIA + AUMENTO · PRÓTESIS REDONDAS'], [19, 'PEXIA + AUMENTO · PRÓTESIS ERGONÓMICAS'],
        [20, 'REDUCCIÓN MAMARIA · TIPO I'], [21, 'REDUCCIÓN MAMARIA · TIPO II'], [22, 'RECAMBIO DE PRÓTESIS'],
        [23, 'GINECOMASTIA'], [25, 'ABDOMINOPLASTIA CLÁSICA'], [26, 'ABDOMINOPLASTIA CLÁSICA + LIPOSUCCIÓN'],
        [27, 'ABDOMINOPLASTIA CIRCULAR EN T'], [28, 'ABDOMINOPLASTIA CIRCULAR'], [29, 'BRAQUIOPLASTIA · LIFTING DE BRAZOS'],
        [30, 'CRUROPLASTIA · LIFTING DE MUSLOS'], [32, 'LIPOSUCCIÓN · 1 ZONA'], [33, 'LIPOSUCCIÓN · 2 ZONAS'],
        [34, 'LIPOSUCCIÓN + LIPOFILLING · 1 ZONA'], [35, 'LIPOSUCCIÓN + LIPOFILLING · 2 ZONAS']]
        .forEach(([row, label]) => add('Cirugía plástica · tarifa', row, surgery, 2, label));
    [[38, 'LÓBULO RASGADO · 1 LÓBULO'], [39, 'LÓBULO RASGADO · 2 LÓBULOS'], [40, 'RETOQUE DE CICATRIZ · PEQUEÑA'],
        [41, 'RETOQUE DE CICATRIZ · MEDIANA'], [42, 'RETOQUE DE CICATRIZ · GRANDE'], [43, 'OTOPLASTIA BILATERAL'],
        [44, 'BLEFAROPLASTIA SUPERIOR'], [45, 'BLEFAROPLASTIA COMPLETA']]
        .forEach(([row, label]) => add('Cirugía plástica · tarifa', row, surgery, 3, label));
    return links;
}

function labelKey(text) {
    // Only typography and a trailing explicit duration; never synonyms/regions.
    return norm(text).replace(/\s*\(\d+(?:[-–]\d+)? MINUTOS\)\s*$/, '').replace(/[·]/g, ' ').replace(/\s+/g, ' ').trim();
}
const MONEY = /(?:Desde\s+)?[+−-]?\d+(?:[.,]\d+)*\s*€/gi;
function tariffEvidence(pdf) {
    const observations = [];
    pdf.pages.forEach((page, pageIndex) => {
        let heading = '';
        const lines = page.split('\n');
        lines.forEach((raw, index) => {
            const text = raw.trim();
            if (!text || /^BS Medical ·|^TARIFA 2026$/.test(text)) return;
            const matches = [...text.matchAll(MONEY)];
            const coded = /^(FAC|OBE)-\d+\s{2,}/.test(text);
            const cells = coded ? text.split(/\s{2,}/) : [];
            const special = /\b(Gratuit[ao]|Incluid[ao])\s*$/i.exec(text);
            const codedSpecial = coded && /^(?:Gratuit[ao]|Incluid[ao])$/i.test(cells[3] || '');
            if (!matches.length && !special && !codedSpecial) {
                if (text === text.toLocaleUpperCase('es') && /[A-ZÁÉÍÓÚÑ]/.test(text)) heading = text;
                return;
            }
            const prefix = matches.length ? text.slice(0, matches[0].index).trim() : special ? text.slice(0, special.index).trim() : '';
            const inlineLabel = !coded && prefix && prefix === prefix.toLocaleUpperCase('es') && !/\bBONO\b/.test(prefix) ? prefix : '';
            const label = coded ? cells[1] : inlineLabel || heading;
            const durationRaw = coded ? cells[2] || '' : /\(([^)]+\bMINUTOS)\)\s*$/i.exec(label)?.[1] || '';
            const ref = { file: pdf.file, file_sha256: pdf.sha256, page: pageIndex + 1, page_sha256: hash(page), line: index + 1, label, quote: raw };
            const id = hash([pdf.sha256, ref.page, ref.line, raw]);
            const offers = [...text.matchAll(/bono\s*(?:de\s*)?(\d+)\s*(?:sesiones)?\s*:\s*(\d+(?:[.,]\d+)*\s*€)/gi)]
                .map(m => ({ role: 'voucher', units: Number(m[1]), price_raw: m[2], price: grossPrice(m[2]) }));
            let primary = null;
            if (coded && cells.length >= 5 && /^(?:\d+(?:[.,]\d+)*\s*€|Desde \d+(?:[.,]\d+)*\s*€|Gratuit[ao]|Incluid[ao])$/i.test(cells[3])) primary = cells[3];
            else if (special) primary = special[1];
            else if (matches.length === 1 && (inlineLabel || !prefix || /^Desde\s*$/i.test(prefix)) && !/^[+−-]/.test(matches[0][0])) primary = matches[0][0];
            observations.push({ id, ref, label, duration_raw: durationRaw, primary: primary ? { role: 'primary', units: null, price_raw: primary, price: grossPrice(primary) } : null, offers });
            if (inlineLabel) heading = inlineLabel;
        });
    });
    return observations;
}

function assertCatalogueOnly(sheets) {
    if (!Array.isArray(sheets)) throw new Error('MATRIX_SHEETS_REQUIRED');
    for (const sheet of sheets) {
        if (/pacientes|appointments|citas|contactos|historial|servicios realizados/i.test(sheet.name)) throw new Error('MATRIX_PATIENT_SOURCE_FORBIDDEN');
        for (const row of sheet.rows || []) if (Object.keys(row).some(k => /patient|paciente|appointment|id_usuario|phone|email/i.test(k))) throw new Error('MATRIX_PATIENT_SOURCE_FORBIDDEN');
    }
}
function sourceRef(row, filename) { return { file: filename, ...row.provenance }; }
function baseRow(recordType, key) { return Object.fromEntries(COLUMNS.map(column => [column, column === 'record_type' ? recordType : column === 'matrix_key' ? key : ''])); }
function json(value) { return stableJson(value); }
function areaOf(sheet) { return sheet.startsWith('Capilar') ? 'capilar' : sheet.startsWith('Facial') ? 'facial' : sheet.startsWith('Obesidad') ? 'obesidad' : sheet.startsWith('Cirugía') ? 'cirugia' : 'corporal'; }

function buildCatalogMatrix({ sheets, workbookHash, replySheets = [], repliesHash = null, pdfs = [], bindings }) {
    assertCatalogueOnly(sheets); assertCatalogueOnly(replySheets);
    for (const pdf of pdfs) {
        if (!['tariff', 'manual'].includes(pdf.role) || !Array.isArray(pdf.pages) || !pdf.pages.length || pdf.pages.length > 250 || pdf.pages.some(p => typeof p !== 'string' || p.length > 2000000)) throw new Error('MATRIX_PDF_STRUCTURE_INVALID');
        if (workbookHash === WORKBOOK_SHA && !bindings) {
            const spec = PDF_SOURCES.find(s => s.file === pdf.file);
            if (!spec || spec.sha256 !== pdf.sha256 || spec.pages !== pdf.pages.length || spec.role !== pdf.role) throw new Error('MATRIX_PDF_SOURCE_REVISION_MISMATCH');
        }
    }
    const plan = buildCatalogPlan({ sheets, workbookHash, replies: clientReplies(replySheets, repliesHash), repliesHash });
    const rows = [];
    const evidence = pdfs.filter(p => p.role === 'tariff').flatMap(tariffEvidence);
    const usedEvidence = new Set();
    const links = bindings || (workbookHash === WORKBOOK_SHA ? reviewedBindings() : []);
    const coverage = { pdfs_extracted: pdfs.length, tariff_pdfs: pdfs.filter(p => p.role === 'tariff').length,
        tariff_pages: pdfs.filter(p => p.role === 'tariff').reduce((n, p) => n + p.pages.length, 0),
        manual_pages_inventoried: pdfs.filter(p => p.role === 'manual').reduce((n, p) => n + p.pages.length, 0),
        price_evidence_lines: evidence.length, concepts_with_october_price: 0, offers_with_october_price: 0 };
    function populate(source, offer = null) {
        const key = offer ? `${source.source_catalog_key}:voucher:${offer.units}` : source.source_catalog_key;
        const result = baseRow(offer ? 'voucher_offer' : 'concept', key);
        const price = offer ? offer.source_price : source.source_price;
        const refs = [sourceRef(source, 'BASE_DE_DATOS_TRATAMIENTOS_BS_MEDICAL_v2.xlsx'), ...source.client_reply_evidence.map(r => ({ file: 'Dudas importacion Mar (1).xlsx', ...r }))];
        const pending = [...source.issues];
        Object.assign(result, { code: offer ? '' : source.proposed_code, clinic: source.clinic_id === 66 ? 'BS Capilar' : 'BS Medical',
            area: areaOf(source.sheet), kind: offer ? 'voucher' : source.kind, name: offer ? `${source.display_name} · Bono ${offer.units}` : source.display_name,
            scope: source.kind === 'program' ? 'excluded_new_programs' : ['product', 'fee'].includes(source.kind) ? 'commercial_not_bookable' : 'review_catalogue_definition',
            proposed_action: 'preflight_required_no_write', source_price_raw: offer ? source.raw_cells[offer.units === 5 ? 'E' : 'F'] : source.price,
            source_gross_amount: price.gross_amount ?? '', source_price_mode: price.mode, gross_includes_tax: true,
            quantity: offer?.units || '', duration_raw: source.duration, duration_json: json(source.duration_info), room_raw: source.cabin, staff_raw: source.professional,
            equivalence_status: 'not_inferred', notes: source.client_reply_decisions.join(' | ') });
        const applicable = links.filter(b => b.sheet === source.sheet && b.row === source.source_row && (!offer || b.units === offer.units) && (offer || b.role === 'primary' || source.kind === 'voucher'));
        const matched = applicable.flatMap(b => evidence.filter(e => e.ref.file === b.file && e.ref.page === b.page && labelKey(e.label) === labelKey(b.label))
            .flatMap(e => (b.role === 'voucher' ? e.offers.filter(o => o.units === b.units) : e.primary ? [e.primary] : []).map(p => ({ ...p, evidence: e }))));
        const distinct = new Set(matched.map(m => json(m.price)));
        if (matched.length && distinct.size === 1 && ['fixed', 'from', 'included'].includes(matched[0].price.mode)) {
            const chosen = matched[0];
            Object.assign(result, { october_price_raw: chosen.price_raw, october_gross_amount: chosen.price.gross_amount ?? '', october_price_mode: chosen.price.mode,
                effective_from: '2026-10-01', vat_rate: 21 });
            matched.forEach(m => { usedEvidence.add(m.evidence.id); refs.push({ ...m.evidence.ref, field: 'october_price', role: m.role, units: m.units, precedence: 'october_tariff_over_september_workbook_and_replies' }); });
            const durations = [...new Set(matched.map(m => m.evidence.duration_raw).filter(Boolean))];
            result.october_duration_evidence_json = json(durations.map(raw => ({ raw, operational_duration_not_changed: true })));
            if (durations.length && (durations.length > 1 || durations.some(raw => {
                const fixed = /^(\d+)\s*(?:min|minutos)$/i.exec(raw);
                return !fixed || source.duration_info.mode !== 'fixed' || Number(fixed[1]) !== source.duration_info.minutes;
            }))) pending.push('OCTOBER_DOCUMENTED_DURATION_REQUIRES_RECONCILIATION');
            pending.splice(0, pending.length, ...pending.filter(p => p !== 'PRICE_REQUIRES_REVIEW'));
            if (chosen.price.mode === 'from') pending.push('QUOTATION_NOT_A_FIXED_PRICE');
            if (chosen.price.mode === 'included') pending.push('INCLUDED_IS_NOT_STANDALONE_FREE');
            coverage[offer ? 'offers_with_october_price' : 'concepts_with_october_price']++;
        } else pending.push(matched.length ? 'OCTOBER_PRICE_CONFLICT_OR_VARIANT' : 'OCTOBER_PRICE_ASSOCIATION_PENDING');
        if (source.sheet === 'Facial · tratamientos' && [75, 76, 99, 100, 101, 102, 103, 104, 105, 106].includes(source.source_row)) pending.push('OCTOBER_LED_OR_AREA_VARIANTS_NOT_AUTOMATICALLY_EQUIVALENT');
        if (source.sheet === 'Facial · tratamientos' && [77, 78].includes(source.source_row)) {
            const pdf = pdfs.find(p => p.file === 'Tarifa-2026-Facial.pdf');
            if (pdf && pdf.pages[3]?.includes('EASY TCA TIENE FICHA CLÍNICA Y TODAVÍA NO TIENE PRECIO')) {
                result.proposed_action = 'not_offered_pending_tariff_no_write';
                pending.push('CUSTOMER_OCTOBER_EASY_TCA_NOT_OFFERED_UNTIL_PRICED');
                refs.push({ file: pdf.file, file_sha256: pdf.sha256, page: 4, page_sha256: hash(pdf.pages[3]), field: 'commercial_offer', quote: 'EASY TCA TIENE FICHA CLÍNICA Y TODAVÍA NO TIENE PRECIO · HASTA QUE SE TARIFE, NO SE' });
            }
        }
        if (source.kind === 'program') pending.push('NEW_PROGRAMS_OUT_OF_IMPLEMENTATION_SCOPE');
        result.source_references_json = json(refs); result.pending_json = json([...new Set(pending)]);
        rows.push(result);
    }
    plan.rows.forEach(source => { populate(source); source.additional_voucher_offers.forEach(o => populate(source, o)); });
    const legacy = replySheets.find(s => s.name === 'Nombres antiguos');
    (legacy?.rows || []).filter(r => r.source_row > 4 && r.cells.B).forEach(r => {
        const result = baseRow('legacy_reference', hash(['legacy', repliesHash, r.source_row, r.cells]));
        const answer = (r.cells.D || '').trim(); const status = norm(r.cells.C || '');
        const withdrawn = /^(ELIMINAR|NO LO TENEMOS)$/.test(norm(answer)) || status === 'YA NO SE OFRECE';
        const previous = legacy.rows.find(prior => prior.source_row === r.source_row - 1);
        const continueSold = /QUEDAN 23 VENDIDOS/.test(norm(answer)) || (norm(answer) === 'LO MISMO' && /GROUPON/.test(norm(r.cells.B)) && /GROUPON/.test(norm(previous?.cells.B)) && /QUEDAN 23 VENDIDOS/.test(norm(previous?.cells.D)));
        Object.assign(result, { area: r.cells.A || '', kind: 'historical_reference', name: r.cells.B, scope: 'history_and_entitlements_preserved',
            proposed_action: withdrawn ? 'explicit_offer_retirement_requires_preflight' : continueSold ? 'stop_new_sales_keep_sold_entitlements_requires_preflight' : 'no_write',
            equivalence_status: status === 'TIENE EQUIVALENTE' && answer ? 'customer_explicit_name_requires_catalogue_preflight' : 'not_confirmed',
            equivalent_new_name: status === 'TIENE EQUIVALENTE' ? answer : '', notes: answer,
            source_references_json: json([{ file: 'Dudas importacion Mar (1).xlsx', file_sha256: repliesHash, sheet: legacy.name, source_row: r.source_row, row_sha256: hash(r.cells) }]),
            pending_json: json(answer && !withdrawn && !continueSold && status !== 'TIENE EQUIVALENTE' ? ['CUSTOMER_REPLY_NOT_AN_EQUIVALENCE'] : []) });
        rows.push(result);
    });
    evidence.filter(e => !usedEvidence.has(e.id)).forEach(e => {
        const result = baseRow('unlinked_tariff_evidence', e.id);
        Object.assign(result, { area: pdfs.find(p => p.file === e.ref.file).area, kind: 'source_evidence_not_catalogue_definition', name: e.label,
            scope: 'evidence_only', proposed_action: 'no_write', source_price_raw: e.ref.quote.trim(),
            source_price_mode: 'literal_unlinked_do_not_guess_column', effective_from: '2026-10-01',
            october_duration_evidence_json: json(e.duration_raw ? [{ raw: e.duration_raw, operational_duration_not_changed: true }] : []),
            source_references_json: json([e.ref]), pending_json: json(['EXACT_CONCEPT_AND_PRICE_COLUMN_ASSOCIATION_REQUIRED']) });
        rows.push(result);
    });
    pdfs.forEach(pdf => {
        const result = baseRow('source_manifest', pdf.sha256);
        Object.assign(result, { area: pdf.area, kind: pdf.role, name: pdf.file, scope: 'source_inventory', proposed_action: 'no_write',
            source_references_json: json([{ file: pdf.file, file_sha256: pdf.sha256, pages: pdf.pages.length, page_sha256: pdf.pages.map(hash) }]),
            notes: pdf.role === 'manual' ? 'Inventoried only: no clinical approval, timing or price inferred; corporal dates conflict.' : 'All pages extracted; final price only on verified modality links.' });
        rows.push(result);
    });
    if (new Set(rows.map(r => r.matrix_key)).size !== rows.length) throw new Error('MATRIX_DUPLICATE_IDENTITY');
    coverage.linked_price_evidence_lines = usedEvidence.size;
    coverage.unlinked_price_evidence_lines = evidence.length - usedEvidence.size;
    const summary = { rows: rows.length, by_record_type: rows.reduce((out, r) => { out[r.record_type] = (out[r.record_type] || 0) + 1; return out; }, {}), by_concept_kind: plan.summary.by_kind,
        coverage, ready_for_activation: false, database_read: false, database_written: false, patient_sources_read: false };
    return { version: 1, mode: 'offline_catalogue_evidence_only', rows, summary, matrix_sha256: hash(rows) };
}

function csvCell(value) {
    let text = String(value ?? '');
    // Spreadsheet formulas must never execute when opening a customer label.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}
function matrixCsv(matrix) { return '\ufeff' + [COLUMNS, ...matrix.rows.map(row => COLUMNS.map(c => row[c]))].map(cells => cells.map(csvCell).join(';')).join('\r\n') + '\r\n'; }

module.exports = { WORKBOOK_SHA, REPLIES_SHA, ARCHIVE_SHA, PDF_SOURCES, COLUMNS, reviewedBindings, tariffEvidence, buildCatalogMatrix, matrixCsv };
