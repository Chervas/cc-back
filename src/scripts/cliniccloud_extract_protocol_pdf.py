#!/usr/bin/env python3
"""Literal paginated PDF text for the private BS import, not clinical rewriting.

Poppler supplies page order/layout. Preserve all extracted characters except
CRLF normalization and page separators. Image/vector content is not extracted;
the original PDF remains the authoritative document. Never OCR, infer tables,
remove repeated footers, truncate a page, approve or associate a treatment.
"""
import hashlib
import json
import subprocess
import sys

MAX_PART_UNITS = 90000
FENCE = '```pdf-text'


def utf16_units(text):
    return len(text.encode('utf-16-le')) // 2


def paginate(text, source_name, source_sha256, max_units=MAX_PART_UNITS):
    if not text or len(text) > 2000000 or '\ufffd' in text or '\x00' in text:
        raise ValueError('PDF_TEXT_REQUIRES_REVIEW')
    if not isinstance(max_units, int) or not 1000 <= max_units <= MAX_PART_UNITS:
        raise ValueError('PDF_PART_LIMIT_INVALID')
    text = text.replace('\r\n', '\n').replace('\r', '\n')
    pages = text.split('\f')
    if pages[-1] == '':
        pages.pop()  # Poppler's terminal separator, not a discarded page.
    if not 1 <= len(pages) <= 250 or any('```' in page for page in pages):
        raise ValueError('PDF_PAGE_STRUCTURE_REQUIRES_REVIEW')
    lead = ('Texto extraído por páginas del PDF aportado. Se conservan las columnas '
            'como texto literal; imágenes, firmas gráficas y diseño no se reproducen. '
            'Consultar el PDF original para esos elementos. Borrador sin aprobación clínica.\n\n')
    parts, blocks, included, size = [], [], [], utf16_units(lead)
    for number, page in enumerate(pages, 1):
        block = f'## Página {number} del PDF\n\n{FENCE}\n{page}\n```\n\n'
        units = utf16_units(block)
        if units + utf16_units(lead) > max_units:
            raise ValueError('PDF_SINGLE_PAGE_TOO_LONG_DO_NOT_TRUNCATE')
        if blocks and size + units > max_units:
            parts.append({'pages': included, 'content': lead + ''.join(blocks)})
            blocks, included, size = [], [], utf16_units(lead)
        blocks.append(block)
        included.append(number)
        size += units
    parts.append({'pages': included, 'content': lead + ''.join(blocks)})
    for i, part in enumerate(parts, 1):
        part.update(part=i, total_parts=len(parts),
                    content_sha256=hashlib.sha256(part['content'].encode()).hexdigest())
    return {'version': 1, 'format': 'literal_pdf_pages_v1', 'source_file': source_name,
            'source_sha256': source_sha256, 'page_count': len(pages),
            'extracted_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'page_sha256': [hashlib.sha256(page.encode()).hexdigest() for page in pages],
            'images_and_graphics_extracted': False, 'clinical_approval': False, 'parts': parts}


def extract(source, source_name):
    if not source.startswith(b'%PDF-') or len(source) > 10 * 1024 * 1024:
        raise ValueError('PDF_SOURCE_INVALID')
    result = subprocess.run(['pdftotext', '-layout', '-enc', 'UTF-8', '-', '-'],
                            input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=30, check=True)
    return paginate(result.stdout.decode('utf-8', errors='strict'), source_name,
                    hashlib.sha256(source).hexdigest())


if __name__ == '__main__':
    # Stdin bytes let the private ZIP operator avoid shell interpolation and
    # extraction of unrelated ZIP entries to the filesystem.
    if len(sys.argv) != 2 or '/' in sys.argv[1] or '\\' in sys.argv[1] or len(sys.argv[1]) > 180:
        raise SystemExit('PDF_SOURCE_NAME_INVALID')
    print(json.dumps(extract(sys.stdin.buffer.read(10 * 1024 * 1024 + 1), sys.argv[1]), ensure_ascii=False))
