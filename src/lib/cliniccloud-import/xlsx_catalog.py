#!/usr/bin/env python3
"""Read the supplied treatment workbook without dependencies or side effects."""
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def read_workbook(filename):
    with zipfile.ZipFile(filename) as archive:
        if sum(info.file_size for info in archive.infolist()) > 128 * 1024 * 1024:
            raise ValueError('XLSX_SIZE_LIMIT')

        def xml(name):
            raw = archive.read(name)
            if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
                raise ValueError('XLSX_UNSAFE_XML')
            return ET.fromstring(raw)

        shared = [''.join(item.itertext()) for item in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in archive.namelist() else []
        relations = {item.get('Id'): item.get('Target') for item in xml('xl/_rels/workbook.xml.rels')}
        sheets = []
        for sheet in xml('xl/workbook.xml').findall('m:sheets/m:sheet', NS):
            target = relations[sheet.get('{%s}id' % REL)]
            member = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
            if not member.startswith('xl/') or '..' in member.split('/'):
                raise ValueError('XLSX_INVALID_SHEET_PATH')
            rows = []
            for row in xml(member).findall('m:sheetData/m:row', NS):
                cells = {}
                for cell in row.findall('m:c', NS):
                    val = cell.find('m:v', NS)
                    text = val.text or '' if val is not None else ''.join(item.text or '' for item in cell.findall('.//m:t', NS))
                    if cell.get('t') == 's' and text:
                        text = shared[int(text)]
                    if cell.find('m:f', NS) is not None and val is None:
                        raise ValueError('XLSX_UNCACHED_FORMULA')
                    if text:
                        cells[re.sub(r'\d+$', '', cell.get('r', ''))] = text
                rows.append({'source_row': int(row.get('r')), 'cells': cells})
            sheets.append({'name': sheet.get('name'), 'rows': rows})
        return sheets


if __name__ == '__main__':
    try:
        print(json.dumps(read_workbook(sys.argv[1]), ensure_ascii=False))
    except Exception:
        sys.stderr.write('CLINICCLOUD_CATALOG_XLSX_READ_FAILED\n')
        sys.exit(1)
