#!/usr/bin/env python3
"""Append PHI-free review sheets to a copy of the supplied workbook; preserve every original sheet.

Uses the XLSX/ZIP standard library only. The original export is never overwritten.
"""
import argparse
import csv
import hashlib
import json
import os
import re
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
ET.register_namespace('', MAIN)
ET.register_namespace('r', REL)

ISSUES = {
    'PHYSICAL_CABIN_MAP_NOT_CONFIRMED': ('Técnico', 'Vincular la cabina física al identificador de Clinicaclick; reutilizar antes de crear.'),
    'PROFESSIONAL_MEMBERSHIP_MAP_NOT_CONFIRMED': ('Técnico / identidad', 'Completar alta o asociación del profesional. No equiparar personas por semejanza del nombre.'),
    'MULTI_CABIN_PHASE_DISTRIBUTION_REQUIRED': ('Clínico', 'Precisar duración de cada fase/cabina, usando el tratamiento individual o una variante explícita.'),
    'DURATION_REQUIRES_CONFIGURATION': ('Clínico', 'Completar duración del acto. No afecta a bienes ni honorarios sin cita.'),
    'INJECTABLE_STAFF_REQUIRES_CLINICAL_VALIDATION': ('Clínico', 'Confirmar responsable del acto; no asignar inyectables a Ainhoa/Piedad por inferencia.'),
    'PROGRAM_APPOINTMENTS_AND_CADENCE_REQUIRED': ('Clínico', 'Confirmar composición, orden y separación de las citas del programa; no crear sesiones LED ya incluidas.'),
    'VOUCHER_BASE_TREATMENT_LINK_REQUIRED': ('Catálogo', 'Elegir el tratamiento individual y el número de unidades; no duplicar la contabilidad.'),
    'INDIVIDUAL_QUOTATION_REQUIRED': ('Comercial', 'Precio desde/presupuesto individual: no convertirlo en un precio fijo ficticio.'),
    'QUANTITY_AND_PREPARATION_TIME_REQUIRED': ('Clínico', 'Tiempo por hilo/unidad más preparación y cierre pendientes; no usar duración fija para cualquier cantidad.'),
    'PROFESSIONAL_NOT_SPECIFIED': ('Clínico', 'Indicar profesional habilitado y, si hay alternativas, el prioritario.'),
    'CABIN_NOT_SPECIFIED': ('Clínico', 'Indicar dónde se realiza; Hospital para cirugía de estómago y C7 para Plexr según decisiones.'),
}

def column(index):
    result = ''
    while index:
        index, rem = divmod(index - 1, 26)
        result = chr(65 + rem) + result
    return result

def sheet(rows):
    root = ET.Element('{%s}worksheet' % MAIN)
    views = ET.SubElement(root, '{%s}sheetViews' % MAIN)
    view = ET.SubElement(views, '{%s}sheetView' % MAIN, {'workbookViewId': '0'})
    ET.SubElement(view, '{%s}pane' % MAIN, {'ySplit': '1', 'topLeftCell': 'A2', 'activePane': 'bottomLeft', 'state': 'frozen'})
    cols = ET.SubElement(root, '{%s}cols' % MAIN)
    ET.SubElement(cols, '{%s}col' % MAIN, {'min': '1', 'max': str(max(map(len, rows))), 'width': '28', 'customWidth': '1'})
    data = ET.SubElement(root, '{%s}sheetData' % MAIN)
    for row_index, values in enumerate(rows, 1):
        node = ET.SubElement(data, '{%s}row' % MAIN, {'r': str(row_index)})
        for col_index, value in enumerate(values, 1):
            cell = ET.SubElement(node, '{%s}c' % MAIN, {'r': '%s%d' % (column(col_index), row_index), 't': 'inlineStr'})
            inline = ET.SubElement(cell, '{%s}is' % MAIN)
            text = ET.SubElement(inline, '{%s}t' % MAIN)
            text.text = '' if value is None else str(value)
    ET.SubElement(root, '{%s}autoFilter' % MAIN, {'ref': 'A1:%s%d' % (column(max(map(len, rows))), len(rows))})
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)

def append_xml_children(original, local_name, children):
    # Preserve namespace declarations used by mc:Ignorable/Choice Requires values.
    # Re-serializing the original workbook with ElementTree would drop prefixes
    # referenced only in those attribute values, making Excel repair the workbook.
    closing = rb'(</(?:[A-Za-z_][\w.-]*:)?' + local_name.encode('ascii') + rb'\s*>)'
    inserted = b''.join(ET.tostring(child, encoding='utf-8') for child in children)
    result, count = re.subn(closing, lambda match: inserted + match.group(1), original, count=1)
    if count != 1:
        raise ValueError('No se encontró el cierre XML esperado: ' + local_name)
    return result

def build(source, plan_path, target, equivalences=None):
    if target.resolve() == source.resolve() or target.exists():
        raise ValueError('El destino debe ser una copia nueva; nunca se sobrescribe el original ni una revisión existente.')
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    if plan.get('workbook_sha256') != digest:
        raise ValueError('El plan no corresponde a esta versión del Excel.')
    overview = [
        ['Punto', 'Decisión / estado', 'Responsable'],
        ['Este archivo', 'Copia íntegra del Excel original con hojas de revisión añadidas. No acredita una importación ejecutada.', 'Clinicaclick'],
        ['Clínicas', 'BS Medical (72) y BS Capilar (66) separadas. Tratamientos capilares en Capilar.', 'Aprobado'],
        ['Precios', 'Precios fuente con IVA incluido. Conservar precio final; no aplicar 21% indiscriminadamente.', 'Aprobado / fiscalidad por acto'],
        ['Facial 14 precios propuestos', 'Aprobados para cargar; revisar comercialmente cuando convenga.', 'Cliente: revisión no bloqueante'],
        ['Prioridad', 'Con un profesional actúa por defecto; al añadir un segundo se elige prioritario. Loza + Ainhoa obligatorios en cirugía capilar.', 'Aprobado'],
        ['PRP capilar', 'Dr. Camacho / C7 según individual. No identificar automáticamente a Camacho con Dra. Celia.', 'Identidad pendiente si no coincide plantilla'],
        ['Recepción informal C1', 'No reservar C1 antes del tratamiento C2; las consultas propias de C1 sí reservan su duración.', 'Aprobado'],
        ['Instalaciones', 'Cabinas físicas compartidas; sin entidad nueva de maquinaria. Hospital para cirugía de estómago. Plexr C7.', 'Aprobado'],
        ['Programas', 'Citas ordenadas con duración del tratamiento base; variantes explícitas si cambia la duración; precio global independiente.', 'Aprobado'],
        ['BS Esencial', 'No duplicar LED incluido en PRP/dutasteride; pauta restante por confirmar.', 'Clínico'],
        ['Protocolos', 'Solo contenido aportado, con procedencia y versión. Lo que falta queda vacío, no se genera pauta clínica.', 'Aprobado'],
        ['Automatizaciones', 'No se han activado envíos por generar este archivo. Activación requiere confirmación posterior.', 'Pendiente de autorización'],
        ['Datos de pacientes', 'No incluidos en este libro de revisión.', 'Privacidad'],
        ['SHA256 Excel fuente', digest, 'Trazabilidad'],
        ['SHA256 plan catálogo', plan.get('plan_sha256', ''), 'Trazabilidad'],
    ]
    catalog = [['Hoja origen', 'Fila', 'Clínica', 'Clasificación', 'Tratamiento / concepto', 'Detalle', 'Duración fuente', 'Precio fuente (IVA incl.)', 'Cabina fuente', 'Profesional fuente', 'Pendientes', 'Confirmación / corrección del cliente']]
    pending = [['Hoja', 'Fila', 'Clínica', 'Tratamiento / concepto', 'Tipo de revisión', 'Qué falta / propuesta', 'Respuesta del cliente']]
    staff = {}; cabins = {}
    for row in plan.get('rows', []):
        clinic = 'BS Capilar' if row.get('clinic_id') == 66 else 'BS Medical'
        kind_label = {'treatment': 'Tratamiento', 'addon': 'Complemento', 'program': 'Programa / concepto compuesto', 'voucher': 'Bono', 'fee': 'Honorarios', 'product': 'Producto'}.get(row.get('kind'), row.get('kind'))
        catalog.append([row.get('sheet'), row.get('source_row'), clinic, kind_label, row.get('name'), row.get('detail'), row.get('duration'), row.get('price'), row.get('cabin'), row.get('professional'), '; '.join(ISSUES.get(code, ('Revisión', code))[1] for code in row.get('issues', [])), ''])
        for code in row.get('issues', []):
            category, text = ISSUES.get(code, ('Revisión', code))
            if category.startswith('Técnico'):
                continue  # Technical mappings are grouped once in Cabinas y personal.
            pending.append([row.get('sheet'), row.get('source_row'), clinic, row.get('name'), category, text, ''])
        for person in row.get('professional_resolution', []):
            key = (clinic, person.get('label'))
            staff[key] = ', '.join('%s (ID %s)' % (item.get('name', item.get('nombre', '')), item.get('id')) for item in person.get('candidates', []))
        for room in row.get('installation_resolution', []):
            key = (clinic, room.get('key'))
            cabins[key] = ', '.join('%s (ID %s, %s)' % (item.get('name', ''), item.get('id'), 'activa' if item.get('active') else 'inactiva') for item in room.get('candidates', []))
    resources = [['Tipo', 'Clínica', 'Nombre en Excel', 'Candidatos en Clinicaclick (no confirmación)', 'Corrección / nombre completo / observaciones']]
    for (clinic, name), candidates in sorted(staff.items()): resources.append(['Profesional', clinic, name, candidates, ''])
    for (clinic, name), candidates in sorted(cabins.items()): resources.append(['Cabina física', clinic, name, candidates, ''])
    additions = [('Resumen revisión', overview), ('Catálogo para revisión', catalog), ('Pendientes por acto', pending), ('Cabinas y personal', resources)]
    if equivalences:
        with equivalences.open(encoding='utf-8-sig', newline='') as source_csv:
            sample = source_csv.read(4096)
            source_csv.seek(0)
            dialect = csv.Sniffer().sniff(sample, delimiters=';,\t')
            equivalence_rows = list(csv.reader(source_csv, dialect))
        additions.append(('Equivalencias obsoletos', equivalence_rows))
        overview.append(['Equivalencias obsoletos', 'Copia de las sugerencias previas, sin convertirlas en equivalencias aprobadas ni sobrescribir respuestas.', 'Cliente / revisión de catálogo'])
    with zipfile.ZipFile(source, 'r') as original:
        workbook = ET.fromstring(original.read('xl/workbook.xml'))
        relationships = ET.fromstring(original.read('xl/_rels/workbook.xml.rels'))
        content_types = ET.fromstring(original.read('[Content_Types].xml'))
        sheets = workbook.find('{%s}sheets' % MAIN)
        next_id = max(int(item.attrib['sheetId']) for item in sheets) + 1
        existing_names = {item.attrib['name'] for item in sheets}
        relationships_ids = {item.attrib['Id'] for item in relationships}
        new_parts = {}
        new_sheets, new_relationships, new_types = [], [], []
        for name, rows in additions:
            if name in existing_names: raise ValueError('Ya existe una hoja de revisión con ese nombre.')
            relation_id = 'rIdClinicCloudReview%d' % next_id
            if relation_id in relationships_ids: raise ValueError('Relación XLSX duplicada.')
            entry = 'xl/worksheets/cliniccloud-review-%d.xml' % next_id
            new_sheets.append(ET.Element('{%s}sheet' % MAIN, {'name': name, 'sheetId': str(next_id), '{%s}id' % REL: relation_id}))
            new_relationships.append(ET.Element('{%s}Relationship' % PKG, {'Id': relation_id, 'Type': REL + '/worksheet', 'Target': entry[3:]}))
            new_types.append(ET.Element('{%s}Override' % CT, {'PartName': '/' + entry, 'ContentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'}))
            new_parts[entry] = sheet(rows)
            next_id += 1
        replacements = {
            'xl/workbook.xml': append_xml_children(original.read('xl/workbook.xml'), 'sheets', new_sheets),
            'xl/_rels/workbook.xml.rels': append_xml_children(original.read('xl/_rels/workbook.xml.rels'), 'Relationships', new_relationships),
            '[Content_Types].xml': append_xml_children(original.read('[Content_Types].xml'), 'Types', new_types),
        }
        with target.open('xb') as out_file:
            os.chmod(target, 0o600)
            with zipfile.ZipFile(out_file, 'w', compression=zipfile.ZIP_DEFLATED) as output:
                for item in original.infolist(): output.writestr(item, replacements.get(item.filename, original.read(item.filename)))
                for name, data in new_parts.items(): output.writestr(name, data)
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
        assert after.testzip() is None
        for name in ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']:
            ET.fromstring(after.read(name))
        assert all(before.read(name) == after.read(name) for name in before.namelist() if name.startswith('xl/worksheets/'))
    return {'output': str(target), 'original_sheets_unchanged': True, 'review_sheets': len(additions), 'commercial_rows': len(catalog) - 1, 'pending_items': len(pending) - 1, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--equivalences', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.source, args.plan, args.output, args.equivalences), ensure_ascii=False))
