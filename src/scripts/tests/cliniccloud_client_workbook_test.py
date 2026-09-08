"""Offline workbook contract; synthetic inputs only, no database/API/patients."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location('workbook', Path(__file__).parents[1] / 'cliniccloud-client-workbook.py')
workbook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workbook)


class WorkbookContract(unittest.TestCase):
    def fixture(self, directory):
        source, plan = directory / 'source.xlsx', directory / 'plan.json'
        with zipfile.ZipFile(source, 'w') as archive:
            archive.writestr('xl/workbook.xml', '<workbook xmlns="%s" xmlns:r="%s" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15="urn:fixture-x15" mc:Ignorable="x15"><sheets><sheet name="Original" sheetId="1" r:id="rId1"/></sheets></workbook>' % (workbook.MAIN, workbook.REL))
            archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' % (workbook.PKG, workbook.REL))
            archive.writestr('[Content_Types].xml', '<Types xmlns="%s"><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' % workbook.CT)
            archive.writestr('xl/worksheets/sheet1.xml', workbook.sheet([['Contenido original'], ['=no_formula']]))
        plan.write_text(json.dumps({'workbook_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'rows': []}), encoding='utf-8')
        return source, plan

    def test_preserves_original_and_namespaces_and_adds_valid_sheets(self):
        with tempfile.TemporaryDirectory(prefix='cliniccloud-workbook-test-') as directory:
            source, plan = self.fixture(Path(directory))
            target = Path(directory) / 'review.xlsx'
            result = workbook.build(source, plan, target)
            self.assertTrue(result['original_sheets_unchanged'])
            self.assertEqual(result['review_sheets'], 4)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
                self.assertEqual(before.read('xl/worksheets/sheet1.xml'), after.read('xl/worksheets/sheet1.xml'))
                self.assertIn(b'xmlns:x15="urn:fixture-x15"', after.read('xl/workbook.xml'))
                self.assertIn(b'mc:Ignorable="x15"', after.read('xl/workbook.xml'))
                for name in after.namelist():
                    ET.fromstring(after.read(name))
                self.assertEqual(len(ET.fromstring(after.read('xl/workbook.xml')).find('{%s}sheets' % workbook.MAIN)), 5)

    def test_no_overwrite_and_mismatched_source_rejected(self):
        with tempfile.TemporaryDirectory(prefix='cliniccloud-workbook-test-') as directory:
            source, plan = self.fixture(Path(directory))
            original = source.read_bytes()
            with self.assertRaises(ValueError): workbook.build(source, plan, source)
            target = Path(directory) / 'review.xlsx'
            workbook.build(source, plan, target)
            with self.assertRaises(ValueError): workbook.build(source, plan, target)
            plan.write_text('{"workbook_sha256":"wrong"}', encoding='utf-8')
            with self.assertRaises(ValueError): workbook.build(source, plan, Path(directory) / 'mismatched.xlsx')
            self.assertFalse((Path(directory) / 'mismatched.xlsx').exists())
            self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
