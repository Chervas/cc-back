#!/usr/bin/env python3
"""Offline, standard-library-only reader for ClinicCloud's Alertas workbook.

The caller captures stdout in memory. It contains clinical data and must never
be logged or written outside the private import area. No files are written.
"""
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REQUIRED = {'Nivel', 'Estado', 'Fecha', 'Tipo', 'Privada', 'Detalles'}
MAX_BYTES = 128 * 1024 * 1024


def read_alerts(filename):
    with zipfile.ZipFile(filename) as archive:
        if sum(info.file_size for info in archive.infolist()) > MAX_BYTES:
            raise ValueError('XLSX_SIZE_LIMIT')

        def xml(name):
            content = archive.read(name)
            if b'<!DOCTYPE' in content or b'<!ENTITY' in content:
                raise ValueError('XLSX_UNSAFE_XML')
            return ET.fromstring(content)

        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(node.itertext()) for node in xml('xl/sharedStrings.xml').findall('s:si', NS)]
        book = xml('xl/workbook.xml')
        properties = book.find('s:workbookPr', NS)
        epoch = datetime(1904, 1, 1) if properties is not None and properties.get('date1904') in ('1', 'true') else datetime(1899, 12, 30)
        relationships = {node.get('Id'): node.get('Target') for node in xml('xl/_rels/workbook.xml.rels')}
        sheets = book.findall('s:sheets/s:sheet', NS)
        if len(sheets) != 1:
            raise ValueError('XLSX_EXPECTED_SINGLE_ALERT_SHEET')
        target = relationships[sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
        member = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
        if not member.startswith('xl/') or '..' in member.split('/'):
            raise ValueError('XLSX_INVALID_SHEET_PATH')
        header = None
        results = []
        for source_row in xml(member).findall('s:sheetData/s:row', NS):
            cells, cell_types = {}, {}
            for cell in source_row.findall('s:c', NS):
                column = re.sub(r'\d', '', cell.get('r', ''))
                value = cell.find('s:v', NS)
                text = value.text or '' if value is not None else ''.join(node.text or '' for node in cell.findall('.//s:t', NS))
                kind = cell.get('t', '')
                if kind == 's' and text:
                    text = strings[int(text)]
                if cell.find('s:f', NS) is not None and value is None:
                    raise ValueError('XLSX_UNCACHED_FORMULA')
                cells[column] = text
                cell_types[column] = kind
            if not header:
                if REQUIRED.issubset(set(cells.values())):
                    if len(set(cells.values())) != len(cells):
                        raise ValueError('XLSX_DUPLICATE_HEADERS')
                    header = {column: name for column, name in cells.items() if name}
                continue
            if not any(cells.values()):
                continue
            values = {name: cells.get(column, '') for column, name in header.items()}
            date_column = next(column for column, name in header.items() if name == 'Fecha')
            if values['Fecha'] and cell_types.get(date_column, '') not in ('s', 'inlineStr', 'str'):
                values['Fecha'] = (epoch + timedelta(days=float(values['Fecha']))).strftime('%d/%m/%Y %H:%M:%S')
            results.append({'source_row': int(source_row.get('r')), 'values': values})
        if header is None:
            raise ValueError('XLSX_ALERT_HEADERS_NOT_FOUND')
        return results


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('XLSX_PATH_REQUIRED')
        print(json.dumps(read_alerts(sys.argv[1]), ensure_ascii=False))
    except Exception:
        # Never echo cell contents, source filenames or exception payloads.
        sys.stderr.write('CLINICCLOUD_ALERTS_XLSX_READ_FAILED\n')
        sys.exit(1)
