import base64
import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).parents[1] / 'bs_convert_final_consents.py'
spec = importlib.util.spec_from_file_location('final_consents', MODULE)
convert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(convert)


def archive(entries):
    target = io.BytesIO()
    with zipfile.ZipFile(target, 'w') as output:
        for name, data in entries:
            output.writestr(name, data)
    return target.getvalue()


def png(width=1000, height=1400):
    return b'\x89PNG\r\n\x1a\n' + (13).to_bytes(4, 'big') + b'IHDR' + width.to_bytes(4, 'big') + height.to_bytes(4, 'big')


class ArchiveTests(unittest.TestCase):
    def test_deduplicates_bytes_not_names(self):
        source = archive([('one.pdf', b'%PDF-A'), ('copy.pdf', b'%PDF-A'), ('one.doc', b'other')])
        rows, counts = convert.read_sources(source, expected_count=2)
        self.assertEqual(counts['copies'], 3)
        self.assertEqual(sorted(len(row['aliases']) for row in rows), [1, 2])

    def test_preserves_same_name_different_bytes_in_different_archives(self):
        source = archive([('a.zip', archive([('one.pdf', b'%PDF-A')])), ('b.zip', archive([('one.pdf', b'%PDF-B')]))])
        rows, _ = convert.read_sources(source, expected_count=2)
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0]['source_sha256'], rows[1]['source_sha256'])

    def test_ignores_macos_metadata(self):
        rows, counts = convert.read_sources(archive([('__MACOSX/._one.pdf', b'meta'), ('one.pdf', b'%PDF-A')]), 1)
        self.assertEqual(counts['copies'], 1)
        self.assertEqual(rows[0]['source_name'], 'one.pdf')

    def test_rejects_traversal_absolute_and_windows_names(self):
        for name in ('../one.pdf', '/one.pdf', 'a/../one.pdf', 'C:/one.pdf', 'a\\one.pdf'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                convert.read_sources(archive([(name, b'x')]), 1)

    def test_rejects_symlink(self):
        info = zipfile.ZipInfo('one.pdf')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, 'SPECIAL'):
            convert.read_sources(archive([(info, b'/etc/passwd')]), 1)

    def test_rejects_extra_document_type(self):
        with self.assertRaisesRegex(ValueError, 'UNEXPECTED_DOCUMENT_TYPE'):
            convert.read_sources(archive([('one.exe', b'x')]), 1)

    def test_rejects_third_archive_level(self):
        nested = archive([('a.zip', archive([('b.zip', archive([('one.pdf', b'x')]))]))])
        with self.assertRaisesRegex(ValueError, 'NESTING'):
            convert.read_sources(nested, 1)

    def test_exact_expected_unique_count(self):
        with self.assertRaisesRegex(ValueError, 'UNIQUE_DOCUMENT_COUNT'):
            convert.read_sources(archive([('one.pdf', b'%PDF')]), 44)


class RenderingTests(unittest.TestCase):
    source = {'source_name': 'Source <document>.pdf'}

    def test_preserves_every_page_and_marks_auxiliary_text(self):
        pages = [{'number': n, 'png': png(), 'text': '<script>bad</script> {{no}}', 'text_method': 'ocr'} for n in (1, 2)]
        body = convert.build_html(self.source, pages)
        self.assertEqual(body.count('data:image/png;base64,'), 2)
        self.assertEqual(body.count(base64.b64encode(png()).decode()), 2)
        self.assertIn('width="100%"', body)
        self.assertIn('Texto de apoyo extraído automáticamente', body)
        self.assertIn('&lt;script&gt;', body)
        self.assertNotIn('<script>', body)
        self.assertIn('{{paciente.documento}}', body)
        self.assertNotIn('{{no}}', body)
        self.assertIn('&#123;&#123;no&#125;&#125;', body)
        self.assertIn('no lo sustituye', body)
        self.assertIn('Source &lt;document&gt;.pdf', body)

    def test_rejects_missing_or_reordered_pages(self):
        with self.assertRaisesRegex(ValueError, 'PAGE_SEQUENCE'):
            convert.build_html(self.source, [{'number': 2, 'png': png(), 'text': 'x', 'text_method': 'pdf_text'}])
        with self.assertRaisesRegex(ValueError, 'ALL_PAGES'):
            convert.build_html(self.source, [])

    def test_rejects_non_png_without_interpolation(self):
        with self.assertRaisesRegex(ValueError, 'NOT_PNG'):
            convert.image_dimensions(b'<svg onload="bad">')

    def test_review_hints_are_not_privacy_approval(self):
        flags = convert.text_flags('12345678Z 12/10/2026 contact@example.invalid')
        self.assertEqual(flags['document_identifier_patterns'], 1)
        self.assertEqual(flags['filled_date_patterns'], 1)
        self.assertTrue(flags['visual_review_required'])

    def test_private_output_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'proof.json'
            result = convert.write_private(path, 'proof')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(result['sha256'], convert.sha256(b'proof'))
            with self.assertRaises(FileExistsError):
                convert.write_private(path, 'changed')

    def test_rejects_public_output_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp).chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'NOT_OWNED_OR_PRIVATE'):
                convert.require_private_directory(temp)

    def test_authority_hash_required_before_any_conversion(self):
        with self.assertRaisesRegex(ValueError, 'AUTHORITY_HASH'):
            convert.prepare('/nonexistent', '0' * 64, '/nonexistent')


if __name__ == '__main__':
    unittest.main()
