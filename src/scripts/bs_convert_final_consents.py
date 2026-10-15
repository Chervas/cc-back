#!/usr/bin/env python3
"""Private, offline source-faithful conversion of the client's final consents.

No application bootstrap, database, API, tokens or deliveries. Original bytes
are deduplicated by SHA256, never by title. Every PDF page remains an image;
extracted/OCR text is explicitly auxiliary, never the authoritative legal text.
Office files are rendered by a network-isolated, macro-disabled LibreOffice.
The resulting manifest is a preparation artifact, not authorization to publish.
"""
import argparse
import base64
import hashlib
import html
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import zipfile


MAX_ARCHIVE_BYTES = 40 * 1024 * 1024
MAX_TOTAL_BYTES = 160 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 500
MAX_PAGES = 40
MAX_HTML_BYTES = 8 * 1024 * 1024
EXTENSIONS = {'.pdf', '.doc', '.docx'}
SOURCE_SHA256 = '7aa5b5e1599c397aeac194dc1b5d74226d3b20d3f9125b12dc0cef60fc34d118'
LOPD_SHA256 = 'e31760491bf0929ca25a4976f4f2c463cece9af7a41ecb6c0e84508aaddb741f'


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_name(name):
    if not isinstance(name, str) or not name or '\\' in name or '\x00' in name:
        raise ValueError('ARCHIVE_NAME_UNSAFE')
    value = PurePosixPath(name)
    if value.is_absolute() or any(p in ('', '.', '..') for p in name.split('/')):
        raise ValueError('ARCHIVE_NAME_UNSAFE')
    if re.match(r'^[A-Za-z]:', name) or any(ord(c) < 32 for c in name):
        raise ValueError('ARCHIVE_NAME_UNSAFE')
    return value


def read_sources(raw, expected_count=44):
    """Bounded in-memory ZIP traversal. Does not extract archive paths."""
    if not raw or len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError('ARCHIVE_SIZE_INVALID')
    by_hash, seen_names, counts = {}, {}, {'entries': 0, 'bytes': 0, 'copies': 0}

    def visit(content, prefix='', depth=0):
        if depth > 1:
            raise ValueError('ARCHIVE_NESTING_INVALID')
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            for entry in archive.infolist():
                counts['entries'] += 1
                if counts['entries'] > MAX_ENTRIES:
                    raise ValueError('ARCHIVE_ENTRY_LIMIT')
                if entry.is_dir():
                    safe_name(entry.filename.rstrip('/'))
                    continue
                name = safe_name(entry.filename)
                mode = entry.external_attr >> 16
                if stat.S_ISLNK(mode) or entry.flag_bits & 1:
                    raise ValueError('ARCHIVE_SPECIAL_OR_ENCRYPTED_ENTRY')
                if '__MACOSX' in name.parts or name.name.startswith('._'):
                    continue
                if entry.file_size > MAX_MEMBER_BYTES:
                    raise ValueError('ARCHIVE_MEMBER_SIZE_INVALID')
                counts['bytes'] += entry.file_size
                if counts['bytes'] > MAX_TOTAL_BYTES:
                    raise ValueError('ARCHIVE_EXPANDED_SIZE_INVALID')
                data = archive.read(entry)
                if len(data) != entry.file_size:
                    raise ValueError('ARCHIVE_MEMBER_LENGTH_MISMATCH')
                full_name = prefix + entry.filename
                if full_name in seen_names:
                    raise ValueError('ARCHIVE_DUPLICATE_PATH')
                digest = sha256(data)
                seen_names[full_name] = digest
                if name.suffix.lower() == '.zip':
                    visit(data, full_name + '!/', depth + 1)
                    continue
                if name.suffix.lower() not in EXTENSIONS:
                    raise ValueError('ARCHIVE_UNEXPECTED_DOCUMENT_TYPE')
                counts['copies'] += 1
                existing = by_hash.get(digest)
                if existing:
                    if existing['extension'] != name.suffix.lower():
                        raise ValueError('IDENTICAL_CONTENT_EXTENSION_CONFLICT')
                    existing['aliases'].append(full_name)
                else:
                    by_hash[digest] = {'source_sha256': digest, 'source_name': name.name,
                                       'extension': name.suffix.lower(), 'source_bytes': len(data),
                                       'aliases': [full_name], 'data': data}

    visit(raw)
    if len(by_hash) != expected_count:
        raise ValueError('UNEXPECTED_UNIQUE_DOCUMENT_COUNT')
    return sorted(by_hash.values(), key=lambda row: row['source_sha256']), counts


def require_private_directory(directory, create=False):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError('PRIVATE_DIRECTORY_SYMLINK')
    if create:
        directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    info = directory.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('PRIVATE_DIRECTORY_NOT_OWNED_OR_PRIVATE')
    return directory.resolve(strict=True)


def write_private(path, content):
    raw = content.encode('utf-8') if isinstance(content, str) else content
    with open(path, 'xb') as handle:
        os.chmod(path, 0o600)
        handle.write(raw)
    return {'path': str(path), 'bytes': len(raw), 'sha256': sha256(raw)}


def run_tool(argv, timeout=120, capture_stderr=False):
    result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/bin:/snap/bin', 'LANG': 'C.UTF-8',
                                 'OMP_THREAD_LIMIT': '1'})
    if result.returncode:
        # Tool stderr can quote document text: never print it in shared logs.
        raise ValueError('CONVERSION_TOOL_FAILED_' + Path(argv[0]).name.upper())
    return result.stdout + result.stderr if capture_stderr else result.stdout


def tool_versions():
    required = ('pdfinfo', 'pdftotext', 'pdftoppm', 'libreoffice', 'tesseract', 'unshare')
    binaries = {name: shutil.which(name) for name in required}
    missing = [name for name, binary in binaries.items() if not binary]
    if missing:
        raise ValueError('MISSING_TOOLS_' + '_'.join(missing).upper())
    # A net namespace is a requirement, not a best-effort fallback.
    run_tool([binaries['unshare'], '--user', '--map-root-user', '--net', '--', '/bin/true'])
    langs = run_tool([binaries['tesseract'], '--list-langs']).decode('utf-8')
    if not re.search(r'^spa$', langs, re.M):
        raise ValueError('TESSERACT_SPANISH_REQUIRED')
    return {'binaries': binaries,
            'libreoffice': run_tool([binaries['libreoffice'], '--version']).decode().strip(),
            'tesseract': run_tool([binaries['tesseract'], '--version']).decode().splitlines()[0],
            'poppler': run_tool([binaries['pdfinfo'], '-v'], capture_stderr=True).decode().strip(),
            'office_network': 'unshare user+network namespace, no network interfaces',
            'office_macros': 'MacroSecurityLevel=3; DisableMacrosExecution=true'}


def office_pdf(source_path, work, tools):
    profile = work / 'office-profile'
    profile.mkdir(mode=0o700)
    user = profile / 'user'
    user.mkdir(mode=0o700)
    write_private(user / 'registrymodifications.xcu', '''<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item>
</oor:items>''')
    run_tool([tools['unshare'], '--user', '--map-root-user', '--net', '--', tools['libreoffice'],
              '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore',
              '--nodefault', '--nolockcheck', '--nofirststartwizard', '--convert-to',
              'pdf:writer_pdf_Export', '--outdir', str(work), str(source_path)], timeout=180)
    target = work / (source_path.stem + '.pdf')
    if not target.is_file() or target.is_symlink() or not target.read_bytes().startswith(b'%PDF-'):
        raise ValueError('OFFICE_PDF_NOT_CREATED')
    target.chmod(0o600)
    return target


def pdf_page_count(pdf_path, tools):
    info = run_tool([tools['pdfinfo'], str(pdf_path)]).decode('utf-8')
    match = re.search(r'^Pages:\s+(\d+)\s*$', info, re.M)
    if not match or not 1 <= int(match[1]) <= MAX_PAGES:
        raise ValueError('PDF_PAGE_COUNT_INVALID')
    # Some client originals have an empty opening password and explicitly
    # permit printing. Render those pages without changing the source PDF.
    # An opening password or a print prohibition is never bypassed.
    encryption = re.search(r'^Encrypted:\s+(.+)$', info, re.M)
    if encryption and encryption[1].startswith('yes') and 'print:yes' not in encryption[1]:
        raise ValueError('PDF_PRINTING_NOT_ALLOWED')
    return int(match[1])


def image_dimensions(raw):
    # Poppler PNG output. Avoid any third-party parser or implicit recompression.
    if len(raw) < 24 or raw[:8] != b'\x89PNG\r\n\x1a\n' or raw[12:16] != b'IHDR':
        raise ValueError('PAGE_IMAGE_NOT_PNG')
    width, height = int.from_bytes(raw[16:20], 'big'), int.from_bytes(raw[20:24], 'big')
    if not 500 <= width <= 10000 or not 500 <= height <= 15000:
        raise ValueError('PAGE_IMAGE_DIMENSIONS_INVALID')
    return width, height


def text_flags(text):
    # Review hints, not an automatic assertion that images contain no PII/signature.
    return {'document_identifier_patterns': len(re.findall(r'\b(?:\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b', text, re.I)),
            'email_patterns': len(re.findall(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', text)),
            'filled_date_patterns': len(re.findall(r'\b\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}\b', text)),
            'replacement_character': '\ufffd' in text,
            'visual_review_required': True}


def source_escape(value):
    # A literal {{...}} in a source or OCR result is not an engine variable.
    return html.escape(value, quote=True).replace('{', '&#123;').replace('}', '&#125;')


def build_html(source, pages, supplemental_identity=True):
    if not pages or len(pages) > MAX_PAGES:
        raise ValueError('HTML_REQUIRES_ALL_PAGES')
    blocks = ['<section class="bs-final-consent" lang="es">']
    blocks.append('''<style>.bs-final-consent img{display:block;width:100%;height:auto;max-width:100%}.bs-final-consent figure{margin:0 0 16px}.bs-final-consent details{margin:16px 0}.bs-final-consent pre{white-space:pre-wrap;overflow-wrap:anywhere}@media print{.bs-final-consent figure{break-inside:avoid;page-break-inside:avoid;break-before:page;page-break-before:always}.bs-final-consent img{max-height:264mm;object-fit:contain}.bs-final-consent details{display:none}}</style>''')
    for expected, page in enumerate(pages, 1):
        if page['number'] != expected or not page.get('png'):
            raise ValueError('HTML_PAGE_SEQUENCE_INVALID')
        raw = page['png']
        width, height = image_dimensions(raw)
        title = 'Página %s de %s · %s' % (expected, len(pages), source['source_name'])
        blocks.append('<figure data-source-page="%s"><img width="100%%" alt="%s" src="data:image/png;base64,%s"><figcaption>%s</figcaption></figure>' %
                      (expected, source_escape(title), base64.b64encode(raw).decode('ascii'), source_escape(title)))
        if width <= 0 or height <= 0:  # Explicit dimensions validation is not optional.
            raise ValueError('HTML_PAGE_DIMENSIONS_INVALID')
    if supplemental_identity:
        blocks.append('<section class="bs-final-consent-identity"><h3>Identificación de este documento</h3><p>Paciente: {{paciente.nombre_completo}} · Documento: {{paciente.documento}}</p><p>Centro: {{clinica.nombre}} · Profesional: {{profesional.nombre}}</p><p>Fecha de generación: {{fecha.generacion}}</p></section>')
    for page in pages:
        label = 'Texto de apoyo extraído automáticamente' if page['text_method'] == 'ocr' else 'Texto de apoyo extraído del documento'
        blocks.append('<details><summary>%s · página %s</summary><p>La página reproducida arriba conserva el contenido original. Este texto auxiliar puede contener errores de extracción y no lo sustituye.</p><pre>%s</pre></details>' % (label, page['number'], source_escape(page['text'])))
    blocks.append('</section>')
    result = '\n'.join(blocks)
    if len(result.encode('utf-8')) > MAX_HTML_BYTES:
        raise ValueError('HTML_EXCEEDS_PREPARATION_LIMIT_NO_TRUNCATION')
    return result


def convert_document(source, work, tools, dpi=150):
    work.mkdir(mode=0o700)
    source_path = work / ('source' + source['extension'])
    original = write_private(source_path, source['data'])
    pdf_path = source_path if source['extension'] == '.pdf' else office_pdf(source_path, work, tools)
    pdf = {'path': str(pdf_path), 'bytes': pdf_path.stat().st_size, 'sha256': sha256(pdf_path.read_bytes()),
           'method': 'original_pdf' if source['extension'] == '.pdf' else 'libreoffice_writer_pdf_export'}
    count = pdf_page_count(pdf_path, tools)
    text = run_tool([tools['pdftotext'], '-layout', '-enc', 'UTF-8', str(pdf_path), '-']).decode('utf-8', errors='strict')
    text_pages = text.split('\f')
    if text_pages[-1] == '':
        text_pages.pop()
    if len(text_pages) != count:
        raise ValueError('PDF_TEXT_PAGE_COUNT_MISMATCH')
    pages, metadata = [], []
    for number in range(1, count + 1):
        prefix = work / ('page-%03d' % number)
        run_tool([tools['pdftoppm'], '-f', str(number), '-l', str(number), '-singlefile',
                  '-r', str(dpi), '-png', str(pdf_path), str(prefix)], timeout=120)
        png_path = prefix.with_suffix('.png')
        png_path.chmod(0o600)
        png = png_path.read_bytes()
        width, height = image_dimensions(png)
        page_text, method = text_pages[number - 1], 'pdf_text'
        if len(re.sub(r'\s', '', page_text)) < 40:
            page_text = run_tool([tools['tesseract'], str(png_path), 'stdout', '-l', 'spa', '--psm', '3'], timeout=180).decode('utf-8', errors='strict')
            method = 'ocr'
        text_path = prefix.with_suffix('.txt')
        text_artifact = write_private(text_path, page_text)
        pages.append({'number': number, 'png': png, 'text': page_text, 'text_method': method})
        metadata.append({'number': number, 'image_path': str(png_path), 'image_bytes': len(png),
                         'image_sha256': sha256(png), 'width': width, 'height': height, 'dpi': dpi,
                         'text': text_artifact, 'text_method': method, 'empty_text_page': not bool(page_text.strip()),
                         'review_flags': text_flags(page_text)})
    body = build_html(source, pages)
    body_artifact = write_private(work / 'body.html', body)
    return {**{key: value for key, value in source.items() if key != 'data'},
        'catalog_key': 'bs-final-20261015-' + source['source_sha256'],
        'source_artifact': original, 'rendered_pdf': pdf, 'page_count': count, 'pages': metadata,
        'body_html': body_artifact, 'identity_tokens': ['paciente.nombre_completo', 'paciente.documento',
        'clinica.nombre', 'profesional.nombre', 'fecha.generacion'],
        'conversion_complete': True, 'all_source_pages_preserved': True,
        'is_lopd_source': source['source_sha256'] == LOPD_SHA256,
        'publication_approved': False, 'privacy_review': 'pending_visual_pages_and_blank_fields',
        'database_type_required': 'MEDIUMTEXT or LONGTEXT for body_html and snapshot_html',
        'treatment_associations': [], 'automatic_send': False}


def prepare(source_path, expected_sha256, output, dpi=150):
    if expected_sha256 != SOURCE_SHA256:
        raise ValueError('FINAL_ARCHIVE_AUTHORITY_HASH_MISMATCH')
    if not isinstance(dpi, int) or not 120 <= dpi <= 200:
        raise ValueError('RENDER_DPI_INVALID')
    source_path = Path(source_path)
    if source_path.is_symlink() or not source_path.is_file():
        raise ValueError('SOURCE_NOT_REGULAR_FILE')
    raw = source_path.read_bytes()
    if sha256(raw) != expected_sha256:
        raise ValueError('FINAL_ARCHIVE_SOURCE_CHANGED')
    sources, counts = read_sources(raw)
    tooling = tool_versions()
    parent = require_private_directory(Path(output).parent)
    output = require_private_directory(parent / Path(output).name, create=True)
    documents = []
    for index, source in enumerate(sources, 1):
        document = convert_document(source, output / source['source_sha256'], tooling['binaries'], dpi)
        documents.append(document)
        # Names and document contents never go to public console output.
        print(json.dumps({'converted': index, 'of': len(sources), 'source_sha256': source['source_sha256'],
                          'pages': document['page_count'], 'html_bytes': document['body_html']['bytes']}), flush=True)
    manifest = {'name': 'bs-final-consent-source-faithful-conversion', 'version': 1,
                'source_path': str(source_path), 'source_sha256': expected_sha256,
                'source_bytes': len(raw), 'archive_counts': counts, 'unique_documents': len(documents),
                'dpi': dpi, 'tooling': tooling, 'documents': documents,
                'summary': {'source_copies': counts['copies'], 'unique_documents': len(documents),
                'pages': sum(d['page_count'] for d in documents),
                'html_bytes': sum(d['body_html']['bytes'] for d in documents),
                'maximum_html_bytes': max(d['body_html']['bytes'] for d in documents)},
                'publication_approved': False, 'database_writes': 0, 'deliveries': 0,
                'treatment_associations': [], 'source_is_authoritative': True}
    manifest_artifact = write_private(output / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    return manifest_artifact, manifest['summary']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--dpi', type=int, default=150)
    args = parser.parse_args()
    try:
        artifact, summary = prepare(args.source, args.expected_sha256, args.output, args.dpi)
        print(json.dumps({'manifest': artifact, 'summary': summary}, ensure_ascii=False))
    except Exception as error:
        code = str(error)
        print(code if re.fullmatch(r'[A-Z_]+', code) else 'FINAL_CONSENT_PREPARATION_FAILED', file=sys.stderr)
        sys.exit(1)
