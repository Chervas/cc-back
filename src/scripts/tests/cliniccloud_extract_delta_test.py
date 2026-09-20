import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('extract_delta', Path(__file__).parents[1] / 'cliniccloud-extract-delta.py')
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)

class ExtractDeltaTests(unittest.TestCase):
    def test_archive_paths_are_never_output_paths_and_outputs_are_private(self):
        with tempfile.TemporaryDirectory(prefix='qa-delta-', dir='/home/ubuntu/secure-imports') as directory:
            root = Path(directory)
            output = root / 'out'
            output.mkdir(mode=0o700)
            archive = root / 'source.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('../../BACKUP_CONTACTOS_2026-09-20.csv', 'IDCONTACTO;NOMBRE\n1;Ficticio')
                z.writestr('folder/BACKUP_CITAS_2026-09-01_2026-12-31.csv', 'IDCONTACTO;FECHA\n1;21/09/2026')
                z.writestr('clinical-history.txt', 'must not be extracted')
            result = subject.extract(archive, output)
            self.assertEqual(len(result['files']), 2)
            self.assertEqual(len(list(output.iterdir())), 3)
            self.assertTrue(all(path.stat().st_mode & 0o077 == 0 for path in output.iterdir()))
            with self.assertRaises(FileExistsError):
                subject.extract(archive, output)

    def test_duplicate_contact_files_reject_before_any_output(self):
        with tempfile.TemporaryDirectory(prefix='qa-delta-', dir='/home/ubuntu/secure-imports') as directory:
            root = Path(directory)
            output = root / 'out'
            output.mkdir(mode=0o700)
            archive = root / 'source.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                for name in ['BACKUP_CONTACTOS_2026-09-20.csv', 'BACKUP_CONTACTOS_2026-09-13.csv', 'BACKUP_CITAS_2026-09-01_2026-12-31.csv']:
                    z.writestr(name, 'synthetic')
            with self.assertRaisesRegex(ValueError, 'EXACTLY_ONE'):
                subject.extract(archive, output)
            self.assertEqual(list(output.iterdir()), [])

if __name__ == '__main__':
    unittest.main()
