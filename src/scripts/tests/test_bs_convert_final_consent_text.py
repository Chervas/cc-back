import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT_DIR = Path(__file__).parents[1]
sys.path.insert(0, str(SCRIPT_DIR))
spec = importlib.util.spec_from_file_location('final_consent_text', SCRIPT_DIR / 'bs_convert_final_consent_text.py')
convert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(convert)


class EditableTextTests(unittest.TestCase):
    def test_paragraphs_headings_and_every_literal_word_preserved(self):
        source = 'TÍTULO DEL CONSENTIMIENTO\n\nPrimera línea\nSegunda línea\n\nRiesgo: <ninguno inventado> {{no_es_variable}}'
        body = convert.literal_page_html(source)
        self.assertIn('<h3>TÍTULO DEL CONSENTIMIENTO</h3>', body)
        self.assertIn('Primera línea<br>Segunda línea', body)
        self.assertNotIn('{{no_es_variable}}', body)
        self.assertIn('&lt;ninguno inventado&gt;', body)
        parser = convert.VisibleText(); parser.feed(body)
        self.assertEqual(convert.normalized_text(''.join(parser.parts)), convert.normalized_text(source))

    def test_office_sanitization_keeps_tables_lists_superscript_not_scripts(self):
        with tempfile.TemporaryDirectory() as directory:
            parser = convert.OfficeHtml(Path(directory))
            parser.feed('<html><head><style>not body</style></head><body><h2>Title</h2><p onclick="evil()">Exact <b>word</b> H<sup>2</sup>O</p><ul><li>First</li></ul><table><tr><td colspan="2">Cell</td></tr></table><script>bad()</script></body></html>')
            body = ''.join(parser.parts)
            self.assertNotIn('onclick', body)
            self.assertNotIn('script', body)
            self.assertNotIn('bad()', body)
            self.assertNotIn('not body', body)
            self.assertIn('<td colspan="2">Cell</td>', body)
            self.assertIn('<sup>2</sup>', body)
            self.assertEqual(''.join(parser.text), 'TitleExact word H2OFirstCell')

    def test_source_tokens_are_literal_not_engine_interpolation(self):
        with tempfile.TemporaryDirectory() as directory:
            parser = convert.OfficeHtml(Path(directory))
            parser.feed('<body><p>{{paciente.nombre}} literal source</p></body>')
            self.assertIn('&#123;&#123;paciente.nombre&#125;&#125;', ''.join(parser.parts))

    def test_external_office_image_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            parser = convert.OfficeHtml(Path(directory))
            with self.assertRaisesRegex(ValueError, 'EXTERNAL_OR_UNSAFE_IMAGE'):
                parser.feed('<body><img src="https://example.invalid/image.png"></body>')

    def test_ocr_keeps_exact_word_order_and_returns_ambiguous_word_coordinates(self):
        tsv = ('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
               '5\t1\t1\t1\t1\t1\t10\t20\t40\t15\t95\tTexto\n'
               '5\t1\t1\t1\t1\t2\t60\t20\t40\t15\t55\tdud0so\n'
               '5\t1\t1\t1\t2\t1\t10\t40\t40\t15\t90\tsiguiente\n'
               '5\t1\t2\t1\t1\t1\t10\t80\t40\t15\t99\tFinal\n')
        with mock.patch.object(convert.common, 'run_tool', return_value=tsv.encode()):
            text, flags = convert.ocr_page(Path('/qa/page.png'), {'tesseract': '/usr/bin/tesseract'})
        self.assertEqual(text, 'Texto dud0so\nsiguiente\n\nFinal')
        self.assertEqual(flags, [{'word': 'dud0so', 'confidence': 55.0,
                                  'box': {'left': 60, 'top': 20, 'width': 40, 'height': 15}}])

    def test_normalization_only_removes_whitespace_and_discretionary_hyphen(self):
        self.assertEqual(convert.normalized_text('ho\u00adla\n mundo'), 'holamundo')
        self.assertNotEqual(convert.normalized_text('10 mg'), convert.normalized_text('100 mg'))

    def test_long_blank_placeholders_wrap_without_changing_any_character(self):
        text = 'Paciente ' + '_' * 80 + ' Documento: ' + '_' * 30
        body = convert.literal_page_html(text)
        self.assertIn('<wbr>', body)
        parser = convert.VisibleText(); parser.feed(body)
        self.assertEqual(''.join(parser.parts), text)

    def test_gif_without_word_dimensions_keeps_intrinsic_size(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / 'logo.gif'
            image.write_bytes(b'GIF89a' + (53).to_bytes(2, 'little') + (5).to_bytes(2, 'little'))
            parser = convert.OfficeHtml(Path(directory))
            parser.feed('<body><p>Text</p><img src="logo.gif"></body>')
            self.assertIn('width="53"', ''.join(parser.parts))
            self.assertEqual(parser.images[0]['width'], 53)

    def test_native_office_html_does_not_ocr_blank_footer_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); output = root / 'out'; evidence = root / 'evidence'
            output.mkdir(); evidence.mkdir(); source_hash = 'a' * 64
            source_evidence = evidence / source_hash; source_evidence.mkdir()
            (source_evidence / 'source.pdf').write_bytes(b'%PDF-qa')
            source = {'source_sha256': source_hash, 'source_name': 'qa.docx', 'extension': '.docx', 'source_bytes': 1, 'aliases': ['qa.docx'], 'data': b'x'}
            with mock.patch.object(convert.common, 'pdf_page_count', return_value=2), \
                 mock.patch.object(convert.common, 'run_tool', return_value=b'Actual wording\f\f'), \
                 mock.patch.object(convert, 'office_html', return_value=('<p>Actual wording</p>', 'Actual wording', [])), \
                 mock.patch.object(convert, 'ocr_page') as ocr:
                document = convert.convert(source, output, evidence, {'pdftotext': 'test'})
            self.assertEqual(document['method'], 'libreoffice_html')
            self.assertFalse(document['ocr_visual_review_required'])
            self.assertEqual(document['page_count'], 2)
            ocr.assert_not_called()

    def test_full_page_word_scan_is_replaced_by_ocr_text_not_image_gallery(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); output = root / 'out'; evidence = root / 'evidence'
            output.mkdir(); evidence.mkdir(); source_hash = 'a' * 64
            source_evidence = evidence / source_hash; source_evidence.mkdir()
            (source_evidence / 'source.pdf').write_bytes(b'%PDF-qa')
            (source_evidence / 'page-001.png').write_bytes(b'private QA evidence')
            source = {'source_sha256': source_hash, 'source_name': 'qa.docx', 'extension': '.docx', 'source_bytes': 1, 'aliases': ['qa.docx'], 'data': b'x'}
            image = {'width': 800, 'height': 1100, 'bytes': 1000}
            with mock.patch.object(convert.common, 'pdf_page_count', return_value=1), \
                 mock.patch.object(convert.common, 'run_tool', return_value=b'Header only\f'), \
                 mock.patch.object(convert, 'office_html', return_value=('<p>Header only</p><img src="data:image/png;base64,qa">', 'Header only', [image])), \
                 mock.patch.object(convert, 'ocr_page', return_value=('Header and all source wording', [])):
                document = convert.convert(source, output, evidence, {'pdftotext': 'test'})
            body = Path(document['body_html']['path']).read_text()
            self.assertEqual(document['method'], 'literal_pdf_ocr_blocks')
            self.assertTrue(document['ocr_visual_review_required'])
            self.assertIn('Header and all source wording', body)
            self.assertNotIn('<img', body)
            self.assertTrue(document['literal_comparison']['equal_after_whitespace_only_normalization'])


if __name__ == '__main__':
    unittest.main()
