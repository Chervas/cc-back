import importlib.util
import io
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('protocol_docx', Path(__file__).parents[1] / 'cliniccloud_extract_protocol_docx.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def docx(body):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>')
    return data.getvalue()


def p(text):
    return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'


class ProtocolExtractionTests(unittest.TestCase):
    def test_preserves_clinical_columns_and_headings(self):
        table = '<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>'
        for row in [('INDICADO', 'CONTRAINDICADO'), ('Sí 0,5 | unidad', 'No &lt;script&gt;')]:
            table += '<w:tr>' + ''.join('<w:tc>' + p(cell) + '</w:tc>' for cell in row) + '</w:tr>'
        table += '</w:tbl>'
        heading = '<w:p><w:pPr><w:pStyle w:val="Ttulo2"/></w:pPr><w:r><w:t>Ficha</w:t></w:r></w:p>'
        out = module.extract(docx(heading + table))
        self.assertEqual(out['paragraphs'], 5)
        self.assertEqual(out['tables'], 1)
        self.assertIn('## Ficha', out['content'])
        self.assertIn('| Sí 0,5 \\| unidad | No &lt;script&gt;'.replace('&lt;', '<').replace('&gt;', '>'), out['content'])

    def test_layout_change_keeps_two_logical_tables_in_order(self):
        rows = ''
        for spans, cells in [([2, 1], ['Indicado', 'No']), ([1, 1, 1], ['Fase', 'Tiempo', 'Acción'])]:
            rows += '<w:tr>' + ''.join('<w:tc><w:tcPr><w:gridSpan w:val="'+str(s)+'"/></w:tcPr>'+p(t)+'</w:tc>' for s, t in zip(spans, cells)) + '</w:tr>'
        out = module.extract(docx('<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>' + rows + '</w:tbl>'))
        self.assertEqual(out['table_segments'], 2)
        self.assertEqual(out['table_layouts'], [[[2, 1], [1, 1, 1]]])
        self.assertIn('| Indicado | No |\n| --- | --- |\n\n| Fase | Tiempo | Acción |', out['content'])

    def test_unknown_clinical_media_and_tracked_edits_stop(self):
        for tag in ['drawing', 'ins', 'del', 'vMerge', 'footnoteReference']:
            with self.assertRaisesRegex(ValueError, 'REQUIRES_MANUAL_REVIEW'):
                module.extract(docx(p('Text') + '<w:' + tag + '/>'))

    def test_over_limit_is_not_silently_truncated(self):
        with self.assertRaisesRegex(ValueError, 'TOO_LONG_DO_NOT_TRUNCATE'):
            module.extract(docx(p('a' * 100001)))

    def test_content_control_preserves_table_of_contents_and_cell_paragraphs(self):
        body = '<w:sdt><w:sdtPr/><w:sdtContent>' + p('Índice') + p('Sección') + '</w:sdtContent></w:sdt>'
        out = module.extract(docx(body))
        self.assertEqual(out['paragraphs'], 2)
        self.assertEqual(out['content'], 'Índice\n\nSección')


if __name__ == '__main__':
    unittest.main()
