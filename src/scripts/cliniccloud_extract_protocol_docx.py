#!/usr/bin/env python3
"""Read-only, bounded DOCX text/table extraction; never infer clinical rules.

Writes JSON to stdout for the calling private operator, not to a public asset.
Word tables with different column layouts are separated at layout boundaries;
cell and paragraph order remain unchanged. Unsupported content stops extraction.
"""
import hashlib
import io
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
UNSUPPORTED = {'drawing', 'object', 'altChunk', 'del', 'ins', 'vMerge', 'sym',
               'footnoteReference', 'endnoteReference', 'commentReference', 'sdtPrChange'}


def paragraph_text(p):
    parts = []
    for child in p.iter():
        if child.tag == W + 't':
            parts.append(child.text or '')
        elif child.tag == W + 'tab':
            parts.append('\t')
        elif child.tag in (W + 'br', W + 'cr'):
            parts.append('\n')
    return ''.join(parts)


def escape(text):
    # Escape Markdown punctuation only; preserve words, signs and clinical data.
    return re.sub(r'([\\|*`_\[\]#!])', r'\\\1', text)


def extract(source):
    if not source or len(source) > 5 * 1024 * 1024:
        raise ValueError('DOCX_SIZE_INVALID')
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        matches = [x for x in archive.infolist() if x.filename == 'word/document.xml']
        if len(matches) != 1 or matches[0].file_size > 10 * 1024 * 1024:
            raise ValueError('DOCX_DOCUMENT_PART_INVALID')
        xml = archive.read(matches[0])
    if b'<!DOCTYPE' in xml or b'<!ENTITY' in xml:
        raise ValueError('DOCX_XML_ENTITIES_NOT_SUPPORTED')
    root = ET.fromstring(xml)
    body = root.find(W + 'body')
    if body is None:
        raise ValueError('DOCX_BODY_MISSING')
    for child in body.iter():
        if child.tag.startswith(W) and child.tag[len(W):] in UNSUPPORTED:
            raise ValueError('DOCX_CONTENT_REQUIRES_MANUAL_REVIEW')
    expected = [paragraph_text(p) for p in body.iter(W + 'p')]
    consumed, blocks, layouts = [], [], []

    def consume(p):
        text = paragraph_text(p)
        consumed.append(text)
        return text

    def add_paragraph(p):
        text = consume(p)
        if not text.strip():
            return
        style_node = p.find(W + 'pPr/' + W + 'pStyle')
        style = style_node.get(W + 'val', '') if style_node is not None else ''
        heading = re.fullmatch(r'(?:Ttulo|Heading)([1-6])', style)
        prefix = '#' * int(heading[1]) + ' ' if heading else '- ' if style in ('Prrafodelista', 'ListParagraph') else ''
        blocks.append(prefix + escape(text))

    def add_table(table):
        if len(list(table.iter(W + 'tbl'))) != 1:
            raise ValueError('DOCX_NESTED_TABLE_REQUIRES_REVIEW')
        table_layouts, segments, rows, previous = [], [], [], None
        grid = table.find(W + 'tblGrid')
        if grid is None:
            raise ValueError('DOCX_TABLE_GRID_MISSING')
        for row in table.findall(W + 'tr'):
            cells, spans = [], []
            for cell in row.findall(W + 'tc'):
                span = cell.find(W + 'tcPr/' + W + 'gridSpan')
                spans.append(int(span.get(W + 'val')) if span is not None else 1)
                if any(c.tag not in (W+'tcPr', W+'p') for c in cell):
                    raise ValueError('DOCX_COMPLEX_CELL_REQUIRES_REVIEW')
                cells.append('<br>'.join(escape(consume(p)).replace('\n', '<br>') for p in cell.findall(W + 'p')))
            if not spans or sum(spans) != len(grid) or any(s < 1 for s in spans):
                raise ValueError('DOCX_TABLE_GRID_MISMATCH')
            if previous is not None and spans != previous:
                segments.append(rows)
                rows = []
            if spans != previous:
                table_layouts.append(spans)
            rows.append(cells)
            previous = spans
        if rows:
            segments.append(rows)
        for segment in segments:
            # Keep source first row as table header. No generated clinical labels.
            lines = ['| ' + ' | '.join(row) + ' |' for row in segment]
            lines.insert(1, '| ' + ' | '.join('---' for _ in segment[0]) + ' |')
            blocks.append('\n'.join(lines))
        layouts.append(table_layouts)

    def visit(container):
        for child in container:
            if child.tag == W + 'p':
                add_paragraph(child)
            elif child.tag == W + 'tbl':
                add_table(child)
            elif child.tag == W + 'sdt':
                content = child.find(W + 'sdtContent')
                if content is None:
                    raise ValueError('DOCX_CONTENT_CONTROL_INVALID')
                visit(content)
            elif child.tag != W + 'sectPr':
                raise ValueError('DOCX_BODY_BLOCK_REQUIRES_REVIEW')
    visit(body)
    if expected != consumed:
        raise ValueError('DOCX_PARAGRAPH_SEQUENCE_MISMATCH')
    content = '\n\n'.join(blocks).strip()
    # JS/API limit is UTF-16 code units, not Python Unicode code points.
    if len(content.encode('utf-16-le')) // 2 > 100000:
        raise ValueError('DOCX_PROTOCOL_TOO_LONG_DO_NOT_TRUNCATE')
    return {'version': 1, 'source_sha256': hashlib.sha256(source).hexdigest(),
            'source_bytes': len(source), 'content': content,
            'content_sha256': hashlib.sha256(content.encode()).hexdigest(),
            'paragraphs': len(consumed), 'nonempty_paragraphs': sum(bool(p.strip()) for p in consumed),
            'paragraphs_sha256': hashlib.sha256(json.dumps(consumed, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest(),
            'tables': len(layouts), 'table_segments': sum(map(len, layouts)), 'table_layouts': layouts,
            'preserved': 'body paragraph/cell text in source order; table layout transitions split; no clinical rewriting',
            'not_imported': 'DOCX page layout, typography, field instructions and hyperlink targets; original retained privately'}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('DOCX_SOURCE_PATH_REQUIRED')
        with open(sys.argv[1], 'rb') as handle:
            result = extract(handle.read(5 * 1024 * 1024 + 1))
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch('[A-Z_]+', code) else 'DOCX_EXTRACTION_FAILED', file=sys.stderr)
        sys.exit(1)
