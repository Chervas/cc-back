#!/usr/bin/env python3
"""Prepare editable HTML only; originals/page images stay private QA evidence.

No database/API/bootstrap/delivery. Office HTML is sanitized without rewriting
its wording. PDF paragraphs retain page/text order. OCR candidates are always
marked for visual review and never silently certified as literal legal text.
"""
import argparse
import base64
import csv
from html.parser import HTMLParser
import html
import io
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote

import bs_convert_final_consents as common


ALLOWED = {'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'i', 'em',
           'u', 'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr',
           'th', 'td', 'blockquote', 'pre', 'hr', 'span', 'div', 'section', 'dl', 'dt', 'dd'}
VOID = {'br', 'hr', 'img'}
# Visually reviewed reusable-template exclusion: a static professional name /
# registration stamp must not impersonate the actual signing professional.
EXCLUDED_GRAPHICS = {
    '74dd66ccda5894ecf7e0dd48ff62d70b7edec0a3514ce4d757b4d048dc03aaab':
        'static_professional_name_and_registration_stamp_not_actual_signature',
    'e0a9c05501f45cc8be47117759a8811841a6b5cfc2f39d0f1ff19d35466831dd':
        'decorative_word_shape_exported_as_black_rectangle_not_clinical_content',
}


def normalized_text(value):
    return re.sub(r'\s+', '', html.unescape(value).replace('\u00ad', ''))


def editable_escape(value):
    # Word's long underscore placeholders must wrap on tablet/mobile. WBR does
    # not add/remove a visible character or change the legal/source wording.
    return re.sub(r'(_{16})(?=_)', r'\1<wbr>', common.source_escape(value))


def intrinsic_dimensions(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw) >= 24:
        return int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')
    if raw.startswith((b'GIF87a', b'GIF89a')) and len(raw) >= 10:
        return int.from_bytes(raw[6:8], 'little'), int.from_bytes(raw[8:10], 'little')
    # JPEGs in this archive already have explicit Word dimensions.
    return 0, 0


class OfficeHtml(HTMLParser):
    def __init__(self, directory):
        super().__init__(convert_charrefs=True)
        self.directory = directory.resolve()
        self.body = False
        self.ignored = 0
        self.parts, self.text, self.images = [], [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'body':
            self.body = True
            return
        if tag in ('script', 'style', 'head', 'iframe', 'object'):
            self.ignored += 1
            return
        if not self.body or self.ignored:
            return
        if tag == 'img':
            src = unquote(attrs.get('src', ''))
            target = (self.directory / src).resolve()
            if not src or target.parent != self.directory or not target.is_file() or target.is_symlink():
                raise ValueError('OFFICE_EXTERNAL_OR_UNSAFE_IMAGE')
            raw = target.read_bytes()
            target.chmod(0o600)
            width = int(re.sub(r'[^0-9]', '', attrs.get('width', '0')) or 0)
            height = int(re.sub(r'[^0-9]', '', attrs.get('height', '0')) or 0)
            native_width, native_height = intrinsic_dimensions(raw)
            if not width:
                width = native_width
            if not height:
                height = native_height
            exclusion_reason = EXCLUDED_GRAPHICS.get(common.sha256(raw))
            self.images.append({'path': str(target), 'bytes': len(raw), 'sha256': common.sha256(raw),
                                'width': width, 'height': height,
                                'excluded': bool(exclusion_reason),
                                'exclusion_reason': exclusion_reason})
            if exclusion_reason:
                return
            mime = 'image/png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg' if raw.startswith(b'\xff\xd8\xff') else 'image/gif' if raw.startswith((b'GIF87a', b'GIF89a')) else None
            if not mime:
                raise ValueError('OFFICE_IMAGE_TYPE_REQUIRES_REVIEW')
            # Logos/actual illustrations are content, not original-document
            # attachments. Full-page scans trigger OCR below and do not use
            # this Office HTML branch or publish any page-image gallery.
            size = ' width="%s"' % width if 0 < width < 400 else ' width="100%"'
            self.parts.append('<img%s alt="%s" src="data:%s;base64,%s">' %
                              (size, common.source_escape(attrs.get('alt', 'Ilustración del consentimiento')),
                               mime, base64.b64encode(raw).decode('ascii')))
            return
        if tag in ALLOWED:
            safe_attrs = []
            for key in ('colspan', 'rowspan'):
                if key in attrs and re.fullmatch(r'[1-9]\d?', attrs[key]):
                    safe_attrs.append('%s="%s"' % (key, attrs[key]))
            self.parts.append('<%s%s>' % (tag, (' ' + ' '.join(safe_attrs)) if safe_attrs else ''))

    def handle_endtag(self, tag):
        if tag == 'body':
            self.body = False
        elif tag in ('script', 'style', 'head', 'iframe', 'object'):
            self.ignored = max(0, self.ignored - 1)
        elif self.body and not self.ignored and tag in ALLOWED and tag not in VOID:
            self.parts.append('</%s>' % tag)

    def handle_data(self, data):
        if self.body and not self.ignored:
            self.parts.append(editable_escape(data))
            self.text.append(data)


class VisibleText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def office_html(source_path, work, tools):
    profile = work / 'html-profile'
    profile.mkdir(mode=0o700)
    user = profile / 'user'
    user.mkdir(mode=0o700)
    common.write_private(user / 'registrymodifications.xcu', '''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>''')
    common.run_tool([tools['unshare'], '--user', '--map-root-user', '--net', '--', tools['libreoffice'],
                     '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore', '--nodefault',
                     '--nolockcheck', '--nofirststartwizard', '--convert-to', 'html:HTML (StarWriter)',
                     '--outdir', str(work), str(source_path)], timeout=180)
    exported = work / (source_path.stem + '.html')
    exported.chmod(0o600)
    raw = exported.read_bytes()
    # LibreOffice emits a declared character encoding; never decode lossily.
    encoding = re.search(br'charset=([A-Za-z0-9_-]+)', raw[:2000], re.I)
    text = raw.decode(encoding[1].decode('ascii') if encoding else 'utf-8', errors='strict')
    parser = OfficeHtml(work)
    parser.feed(text)
    if not parser.parts or not ''.join(parser.text).strip():
        raise ValueError('OFFICE_HTML_NO_TEXT')
    body = ''.join(parser.parts)
    check = VisibleText()
    check.feed(body)
    if normalized_text(''.join(check.parts)) != normalized_text(''.join(parser.text)):
        raise ValueError('OFFICE_SANITIZATION_CHANGED_TEXT')
    return body, ''.join(parser.text), parser.images


def literal_page_html(text):
    """Conservative editable blocks. No clinical paraphrase/table inference."""
    result = []
    for block in re.split(r'\n[ \t]*\n+', text.strip()):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        short_heading = len(lines) == 1 and len(lines[0]) < 160 and any(c.isalpha() for c in lines[0]) and lines[0].isupper()
        tag = 'h3' if short_heading else 'p'
        result.append('<%s>%s</%s>' % (tag, '<br>'.join(editable_escape(line) for line in lines), tag))
    return '\n'.join(result)


def ocr_page(image, tools):
    # TSV adds literal low-confidence words + coordinates for human comparison.
    raw = common.run_tool([tools['tesseract'], str(image), 'stdout', '-l', 'spa', '--psm', '3', 'tsv'], timeout=180)
    rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8', errors='strict')), delimiter='\t'))
    paragraphs, lines, current_paragraph, current_line, flags = [], [], None, None, []
    words = []
    for row in rows:
        if row.get('level') != '5' or not row.get('text', '').strip():
            continue
        paragraph = (row['page_num'], row['block_num'], row['par_num'])
        line = paragraph + (row['line_num'],)
        if current_line is not None and line != current_line:
            lines.append(' '.join(words)); words = []
        if current_paragraph is not None and paragraph != current_paragraph:
            paragraphs.append('\n'.join(lines)); lines = []
        current_paragraph, current_line = paragraph, line
        word = row['text']
        words.append(word)
        confidence = float(row['conf'])
        if confidence < 70:
            flags.append({'word': word, 'confidence': confidence,
                          'box': {key: int(row[key]) for key in ('left', 'top', 'width', 'height')}})
    if words:
        lines.append(' '.join(words))
    if lines:
        paragraphs.append('\n'.join(lines))
    return '\n\n'.join(paragraphs), flags


def convert(source, output, evidence_root, tools):
    work = output / source['source_sha256']
    work.mkdir(mode=0o700)
    source_path = work / ('source' + source['extension'])
    common.write_private(source_path, source['data'])
    existing_pdf = evidence_root / source['source_sha256'] / ('source.pdf')
    pdf = existing_pdf if existing_pdf.is_file() else source_path if source['extension'] == '.pdf' else common.office_pdf(source_path, work, tools)
    count = common.pdf_page_count(pdf, tools)
    text = common.run_tool([tools['pdftotext'], '-layout', '-enc', 'UTF-8', str(pdf), '-']).decode('utf-8', errors='strict')
    pages = text.split('\f')
    if pages[-1] == '':
        pages.pop()
    if len(pages) != count:
        raise ValueError('TEXT_PAGE_COUNT_MISMATCH')
    exported_html, exported_text, office_images = None, None, []
    if source['extension'] in ('.doc', '.docx'):
        exported_html, exported_text, office_images = office_html(source_path, work, tools)
    # Image-bearing Word forms can contain legal wording in a scanned picture.
    # OCR all of their pages rather than silently deleting that wording.
    force_ocr = any(not image.get('excluded') and image['width'] >= 400 and image['height'] >= 500 for image in office_images)
    page_artifacts, page_html, expected_text, ocr_review = [], [], [], []
    for number, page in enumerate(pages, 1):
        method, flags = 'pdf_text', []
        if force_ocr or exported_html is None and len(re.sub(r'\s', '', page)) < 120:
            image = evidence_root / source['source_sha256'] / ('page-%03d.png' % number)
            if not image.is_file():
                prefix = work / ('qa-page-%03d' % number)
                common.run_tool([tools['pdftoppm'], '-f', str(number), '-l', str(number), '-singlefile',
                                 '-r', '180', '-png', str(pdf), str(prefix)], timeout=120)
                image = prefix.with_suffix('.png')
                image.chmod(0o600)
            page, flags = ocr_page(image, tools)
            method = 'ocr_spa'
            ocr_review.append({'page': number, 'image_path': str(image), 'low_confidence_words': flags,
                               'empty_text': not bool(page.strip())})
        expected_text.append(page)
        artifact = common.write_private(work / ('text-%03d.txt' % number), page)
        page_artifacts.append({'page': number, 'method': method, 'text': artifact,
                               'privacy_flags': common.text_flags(page)})
        page_html.append(literal_page_html(page))
    # Use Writer's actual paragraph/list/table structure wherever no source-page
    # picture needs OCR. PDF pages remain literal editable blocks otherwise.
    use_office = exported_html is not None and not force_ocr
    body = exported_html if use_office else '\n<hr>\n'.join(page_html)
    expected = exported_text if use_office else '\n'.join(expected_text)
    check = VisibleText(); check.feed(body)
    plain = ''.join(check.parts)
    if normalized_text(plain) != normalized_text(expected):
        raise ValueError('TEXT_HTML_LITERAL_COMPARISON_FAILED')
    if not plain.strip() or len(body.encode('utf-8')) > 2 * 1024 * 1024:
        raise ValueError('TEXT_HTML_EMPTY_OR_TOO_LARGE')
    # Only the source wording is here. Root adds the supported identity fields
    # and the existing engine's signature evidence; no simulated signatures.
    artifact = common.write_private(work / 'body-text.html', '<section lang="es">' + body + '</section>')
    return {
        **{key: value for key, value in source.items() if key != 'data'},
        'catalog_key': 'bs-final-20261015-' + source['source_sha256'],
        'body_html': artifact, 'body_format': 'editable_html_text', 'page_count': count,
        'pages': page_artifacts, 'method': 'libreoffice_html' if use_office else 'literal_pdf_ocr_blocks',
        'office_images': office_images, 'large_office_image_requires_ocr': force_ocr,
        'ocr_review': ocr_review, 'literal_comparison': {'equal_after_whitespace_only_normalization': True,
        'expected_text_sha256': common.sha256(normalized_text(expected).encode()),
        'html_text_sha256': common.sha256(normalized_text(plain).encode())},
        'is_lopd_source': source['source_sha256'] == common.LOPD_SHA256,
        'source_files_private_qa_only': True, 'published_source_attachments': [],
        'treatment_associations': [], 'publication_approved': False,
        'privacy_review': 'pending_visual_blank_patient_and_signature_fields',
        'ocr_visual_review_required': bool(ocr_review)}


def prepare(args):
    source_path = Path(args.source)
    raw = source_path.read_bytes()
    if args.expected_sha256 != common.SOURCE_SHA256 or common.sha256(raw) != common.SOURCE_SHA256:
        raise ValueError('FINAL_SOURCE_HASH_CHANGED')
    sources, counts = common.read_sources(raw)
    # LOPD first, so the intake integration can be validated independently.
    sources.sort(key=lambda item: (item['source_sha256'] != common.LOPD_SHA256, item['source_sha256']))
    tooling = common.tool_versions()
    parent = common.require_private_directory(Path(args.output).parent)
    output = common.require_private_directory(parent / Path(args.output).name, create=True)
    evidence = common.require_private_directory(args.evidence)
    documents = []
    for source in sources:
        document = convert(source, output, evidence, tooling['binaries'])
        documents.append(document)
        common.write_private(output / source['source_sha256'] / 'conversion.json', json.dumps(document, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'converted': len(documents), 'of': 44, 'source_sha256': source['source_sha256'],
                          'html_bytes': document['body_html']['bytes'], 'ocr_review': document['ocr_visual_review_required']}), flush=True)
    manifest = {'name': 'bs-final-consent-editable-html-conversion', 'version': 1,
        'source_sha256': common.SOURCE_SHA256, 'source_path': str(source_path), 'unique_documents': len(documents),
        'archive_counts': counts, 'tooling': tooling, 'documents': documents,
        'summary': {'unique_documents': len(documents), 'maximum_html_bytes': max(item['body_html']['bytes'] for item in documents),
                    'all_bodies_fit_text_65535': all(item['body_html']['bytes'] <= 65535 for item in documents),
                    'ocr_review_documents': sum(item['ocr_visual_review_required'] for item in documents)},
        'database_writes': 0, 'deliveries': 0, 'originals_uploaded': 0, 'publication_approved': False}
    artifact = common.write_private(output / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'manifest': artifact, 'summary': manifest['summary']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    try:
        prepare(args)
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'[A-Z_]+', code) else 'FINAL_TEXT_CONVERSION_FAILED', file=sys.stderr)
        sys.exit(1)
