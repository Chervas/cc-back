import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('protocol_pdf', Path(__file__).resolve().parents[1] / 'cliniccloud_extract_protocol_pdf.py')
pdf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pdf)


class ProtocolPdfTest(unittest.TestCase):
    def test_literal_pages_and_layout_are_not_reinterpreted(self):
        pages = ['  Tabla   Dato\n  1       2\n', '<script>not HTML</script>\n# Source heading\n', '']
        text = '\f'.join(pages) + '\f'
        result = pdf.paginate(text, 'Synthetic.pdf', 'a' * 64)
        self.assertEqual(result['page_count'], 3)
        self.assertFalse(result['clinical_approval'])
        self.assertFalse(result['images_and_graphics_extracted'])
        self.assertEqual(result['page_sha256'], [hashlib.sha256(p.encode()).hexdigest() for p in pages])
        content = result['parts'][0]['content']
        for page in pages:
            self.assertIn('```pdf-text\n' + page + '\n```', content)

    def test_split_only_between_complete_pages_and_never_drop_text(self):
        text = '\f'.join(('PAGE ' + str(i) + '\n' + 'x' * 500) for i in range(1, 6)) + '\f'
        result = pdf.paginate(text, 'Synthetic.pdf', 'a' * 64, max_units=1500)
        self.assertGreater(len(result['parts']), 1)
        self.assertEqual([n for p in result['parts'] for n in p['pages']], list(range(1, 6)))
        for part in result['parts']:
            self.assertLessEqual(pdf.utf16_units(part['content']), 1500)
            self.assertEqual(part['total_parts'], len(result['parts']))

    def test_rejects_oversize_page_and_ambiguous_or_corrupt_text(self):
        for text in ['x' * 2000, 'literal ``` fence', 'bad\ufffd', 'bad\x00', '\f' * 251]:
            with self.subTest(text=text[:20]), self.assertRaises(ValueError):
                pdf.paginate(text, 'Synthetic.pdf', 'a' * 64, max_units=1000)

    def test_limit_counts_utf16_and_preserves_last_page_without_separator(self):
        result = pdf.paginate('😀' * 300, 'Synthetic.pdf', 'b' * 64, max_units=1000)
        self.assertEqual(result['page_count'], 1)
        self.assertEqual(result['page_sha256'][0], hashlib.sha256(('😀' * 300).encode()).hexdigest())
        with self.assertRaises(ValueError):
            pdf.paginate('😀' * 500, 'Synthetic.pdf', 'b' * 64, max_units=1000)

    def test_invalid_pdf_stops_before_poppler(self):
        with self.assertRaises(ValueError):
            pdf.extract(b'not a pdf', 'Synthetic.pdf')


if __name__ == '__main__':
    unittest.main()
