#!/usr/bin/env python3
"""Synthetic-only tests for the read-only bundle boundary and source parent ownership."""
import importlib.util, json, os, sqlite3, tempfile, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('bundle', Path(__file__).parents[1] / 'eurodent-patient-bundle.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='testonly-eurodent-bundle-')
        self.root = Path(self.temp.name); os.chmod(self.root, 0o700)
        (self.root / 'inventory').mkdir(mode=0o700)
        self.path = self.root / 'inventory/staging.sqlite'
        intake = {'source_instance': 'testonly-eurodent', 'zip_sha256': 'd' * 64}
        intake['manifest_sha256'] = module.digest(intake)
        (self.root / 'intake.json').write_text(json.dumps(intake)); os.chmod(self.root / 'intake.json', 0o600)
        c = sqlite3.connect(self.path)
        c.executescript('''CREATE TABLE metadata(key TEXT,value_json TEXT);CREATE TABLE source_databases(id INTEGER,source_path TEXT,sha256 TEXT);
          CREATE TABLE source_tables(id INTEGER,database_id INTEGER,table_name TEXT);
          CREATE TABLE source_rows(table_id INTEGER,source_ordinal INTEGER,raw_json TEXT,row_sha256 TEXT,source_pk_json TEXT,ambiguous_empty_columns_json TEXT);''')
        c.executemany('INSERT INTO metadata VALUES (?,?)', [(k,json.dumps(v)) for k,v in {'source_system':'eurodent2000','source_instance':'testonly-eurodent','operational_writes':False,'intake_sha256':intake['manifest_sha256']}.items()])
        c.execute('INSERT INTO source_databases VALUES (1,?,?)', [module.DATABASE, 'a'*64])
        records = {'Paciente':[{'ID':'1','Nombre':'TESTONLY ONE'},{'ID':'2','Nombre':'TESTONLY TWO'}],
          'Historial':[{'ID':'1','IDP':'1','IDT':'4','Nº Trat':'9','Pieza':'36'}],
          'Piezas':[{'ID':'1','IDP':'1','Piezas':'original'}],
          'Factura':[{'ID':'10','IDP':'1'},{'ID':'20','IDP':'2'}],
          'Factura2':[{'ID':'100','IDF':'10','IDH':'1'},{'ID':'200','IDF':'20','IDH':'2'}],
          'Recibo':[{'ID':'11','IDP':'1'},{'ID':'21','IDP':'2'}],
          'Recibo2':[{'ID':'110','IDF':'11'},{'ID':'210','IDF':'21'}],
          'Tratamiento':[{'ID':'4','Código':'TESTONLY','Nombre':'Restauración ficticia','Familia':'5','Grafico':'1'}],
          'FamTrat':[{'ID':'5','Familia':'Actual ficticia'},{'ID':'9','Familia':'Histórica ficticia'}]}
        for n,(table,rows) in enumerate(records.items(), 1):
            c.execute('INSERT INTO source_tables VALUES (?,1,?)',[n,table])
            for ordinal,row in enumerate(rows, 1):
                c.execute('INSERT INTO source_rows VALUES (?,?,?,?,?,?)',[n,ordinal,json.dumps(row),module.digest(row),json.dumps({'ID':row['ID']}),'[]'])
        c.commit();c.close();os.chmod(self.path,0o600)
    def tearDown(self):
        self.temp.cleanup()
    def test_private_readonly_bundle_keeps_linked_children_and_historical_family(self):
        before = self.path.read_bytes()
        bundle = module.build_bundle(self.path, ['1'], '2026-10-09')
        rows = bundle['patients'][0]['records']
        self.assertEqual({r['source_table'] for r in rows},{'Paciente','Historial','Piezas','Factura','Factura2','Recibo','Recibo2'})
        self.assertEqual(next(r for r in rows if r['source_table']=='Factura2')['record']['ID'],'100')
        self.assertEqual(next(r for r in rows if r['source_table']=='Recibo2')['record']['ID'],'110')
        historical = next(r for r in rows if r['source_table']=='Historial')
        self.assertEqual(historical['source_family']['name'], 'Histórica ficticia')
        self.assertEqual(historical['catalog']['family_name'], 'Actual ficticia')
        self.assertEqual(bundle['source_export_date'],'2026-10-09')
        self.assertEqual(bundle['source_zip_sha256'],'d'*64)
        self.assertEqual(self.path.read_bytes(),before)
    def test_missing_duplicate_oversized_selection_rejected(self):
        for selection in [['999'],['1','1'],[str(n) for n in range(1,52)]]:
            with self.assertRaises(ValueError):module.build_bundle(self.path,selection)
    def test_decoder_preserves_original_bytes_hash_and_binds_source_owner(self):
        decoder={'version':'eurodent_dentition_iso88591/1','charset':'ISO-8859-1','source_database_sha256':'a'*64,
                 'tables':{'Piezas':{'raw_export_sha256':'b'*64,'rows':[{'source_pk':'1','source_patient_id':'1','Piezas':'d'*32}]}}}
        bundle=module.build_bundle(self.path,['1'],dentition_sidecar=decoder)
        row=next(r for r in bundle['patients'][0]['records'] if r['source_table']=='Piezas')
        self.assertEqual(row['record']['Piezas'],'original')
        self.assertEqual(row['decoded_fields']['Piezas'],'d'*32)
        self.assertEqual(row['row_sha256'],module.digest(row['record']))
        decoder['source_database_sha256']='c'*64
        with self.assertRaisesRegex(ValueError,'OWNER_OR_SOURCE_MISMATCH'):module.build_bundle(self.path,['1'],dentition_sidecar=decoder)
    def test_inventory_requires_private_file_and_matching_intake_manifest(self):
        os.chmod(self.path,0o644)
        with self.assertRaisesRegex(ValueError,'PRIVATE_INVENTORY'):module.build_bundle(self.path,['1'])
        os.chmod(self.path,0o600)
        intake=json.loads((self.root/'intake.json').read_text());intake['zip_sha256']='c'*64
        (self.root/'intake.json').write_text(json.dumps(intake))
        with self.assertRaisesRegex(ValueError,'INTAKE_PROOF_INVALID'):module.build_bundle(self.path,['1'])

if __name__=='__main__':unittest.main()
