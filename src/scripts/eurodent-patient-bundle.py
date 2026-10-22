#!/usr/bin/env python3
"""Read-only, private preparation of selected Eurodent patients from the verified inventory."""
import argparse, hashlib, json, os, sqlite3, stat, sys
from pathlib import Path

DATABASE = 'datos/EDD00001.MDB'
PATIENT_TABLES = ['Paciente','Historial','Primera_Visita','Trabajo_Pendiente','Presupuestos','Presupuesto','Comentarios','Piezas','Piezas_pri','Factura','Factura2','Recibo','Recibo2','Hist_Borr']
CONTEXT_TABLES = ['Tratamiento','FamTrat','Doctor','Gabinete','FPago']

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True).encode()).hexdigest()

def build_bundle(inventory, patient_ids, source_export_date=None, dentition_sidecar=None):
    """Preserve raw JSON and source hashes. No clinical or financial commands are called."""
    p = Path(inventory).resolve()
    if not p.is_file() or p.stat().st_mode & 0o077:
        raise ValueError('EURODENT_PRIVATE_INVENTORY_REQUIRED')
    if len(patient_ids) != len(set(patient_ids)) or not 1 <= len(patient_ids) <= 50:
        raise ValueError('EURODENT_PATIENT_SELECTION_INVALID')
    inventory_sha = hashlib.sha256(p.read_bytes()).hexdigest()
    intake_file = p.parent.parent / 'intake.json'
    if not intake_file.is_file() or intake_file.stat().st_mode & 0o077:
        raise ValueError('EURODENT_INTAKE_PROOF_REQUIRED')
    intake = json.loads(intake_file.read_text())
    proof = intake.get('manifest_sha256')
    if proof != digest({k:v for k,v in intake.items() if k != 'manifest_sha256'}):
        raise ValueError('EURODENT_INTAKE_PROOF_INVALID')
    connection = sqlite3.connect('file:' + str(p) + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        metadata = {r['key']: json.loads(r['value_json']) for r in connection.execute('SELECT * FROM metadata')}
        if metadata.get('source_system') not in ['eurodent','eurodent2000'] or metadata.get('operational_writes') is not False:
            raise ValueError('EURODENT_VERIFIED_INVENTORY_REQUIRED')
        if metadata.get('intake_sha256') != proof or metadata.get('source_instance') != intake.get('source_instance'):
            raise ValueError('EURODENT_INVENTORY_INTAKE_MISMATCH')
        context, records = {}, []
        candidate_records = []
        for row in connection.execute('''SELECT d.source_path,d.sha256 AS database_sha256,t.table_name,
                r.raw_json,r.row_sha256,r.source_pk_json,r.source_ordinal,r.ambiguous_empty_columns_json
                FROM source_rows r JOIN source_tables t ON t.id=r.table_id
                JOIN source_databases d ON d.id=t.database_id WHERE d.source_path=? ORDER BY t.table_name,r.source_ordinal''', [DATABASE]):
            table, record = row['table_name'], json.loads(row['raw_json'])
            entry = {'source_database': row['source_path'], 'source_table': table,
                     'source_pk': json.loads(row['source_pk_json']) if row['source_pk_json'] else None,
                     'source_ordinal': row['source_ordinal'], 'row_sha256': row['row_sha256'],
                     'database_sha256': row['database_sha256'], 'ambiguous_empty_columns': json.loads(row['ambiguous_empty_columns_json']),
                     'record': record}
            if table in CONTEXT_TABLES:
                context.setdefault(table, []).append(entry)
            if table not in PATIENT_TABLES:
                continue
            candidate_records.append(entry)
        invoice_owners = {str(r['record']['ID']): str(r['record']['IDP']) for r in candidate_records if r['source_table'] == 'Factura'}
        receipt_owners = {str(r['record']['ID']): str(r['record']['IDP']) for r in candidate_records if r['source_table'] == 'Recibo'}
        def owner(entry):
            record, table = entry['record'], entry['source_table']
            if table == 'Paciente':
                return str(record['ID'])
            if table == 'Factura2':
                return invoice_owners.get(str(record.get('IDF', '')), '')
            if table == 'Recibo2':
                return receipt_owners.get(str(record.get('IDF', '')), '')
            return str(record.get('IDP', ''))
        records = [r for r in candidate_records if owner(r) in patient_ids]
        found = {str(r['record']['ID']) for r in records if r['source_table'] == 'Paciente'}
        if found != set(patient_ids):
            raise ValueError('EURODENT_SOURCE_PATIENT_NOT_FOUND')
        decoded = {}
        if dentition_sidecar:
            if dentition_sidecar.get('version') != 'eurodent_dentition_iso88591/1' or dentition_sidecar.get('charset') != 'ISO-8859-1':
                raise ValueError('EURODENT_DENTITION_DECODER_INVALID')
            for table, data in dentition_sidecar.get('tables', {}).items():
                if table not in ['Piezas','Piezas_pri']:
                    raise ValueError('EURODENT_DENTITION_DECODER_INVALID')
                for item in data['rows']:
                    decoded[(table, str(item['source_pk'].get('ID') if isinstance(item['source_pk'], dict) else item['source_pk']))] = (item, data['raw_export_sha256'])
        treatments = {str(r['record']['ID']): r['record'] for r in context.get('Tratamiento', [])}
        families = {str(r['record']['ID']): r['record'] for r in context.get('FamTrat', [])}
        doctors = {str(r['record']['ID']): r['record'] for r in context.get('Doctor', [])}
        patients = []
        for patient_id in patient_ids:
            selected = []
            for row in records:
                record, table = row['record'], row['source_table']
                identity = owner(row)
                if identity != patient_id:
                    continue
                result = dict(row)
                family = families.get(str(record.get('Nº Trat', '')))
                if family:
                    result['source_family'] = {'id': str(family['ID']), 'name': family.get('Familia')}
                decoder = decoded.get((table, str(record.get('ID', ''))))
                if decoder:
                    item, export_sha = decoder
                    if str(item['source_patient_id']) != patient_id or row['database_sha256'] != dentition_sidecar['source_database_sha256']:
                        raise ValueError('EURODENT_DENTITION_OWNER_OR_SOURCE_MISMATCH')
                    result['decoded_fields'] = {'Piezas': item['Piezas']}
                    result['decoder'] = {'version': dentition_sidecar['version'], 'charset': dentition_sidecar['charset'], 'raw_export_sha256': export_sha, 'source_database_sha256': dentition_sidecar['source_database_sha256']}
                if str(record.get('IDT', '')) in treatments:
                    treatment = treatments[str(record['IDT'])]
                    family = families.get(str(treatment.get('Familia', '')), {})
                    result['catalog'] = { 'source_id': str(treatment['ID']), 'code': treatment.get('Código'),
                        'name': treatment.get('Nombre'), 'family_id': treatment.get('Familia'),
                        'family_name': family.get('Familia'), 'graphic': treatment.get('Grafico'),
                        'all_teeth': treatment.get('Todos'), 'no_tooth': treatment.get('SinPza'),
                        'old_family_id': treatment.get('FamOldOcu') }
                doctor = doctors.get(str(record.get('Doctor', '')))
                if doctor:
                    result['author'] = {'source_id': str(doctor['ID']), 'name': doctor.get('Nombre')}
                selected.append(result)
            patients.append({'source_patient_id': patient_id, 'records': selected})
        bundle = {'version': 'eurodent_patient_bundle/1', 'source_system': 'eurodent',
                  'source_instance': metadata['source_instance'], 'source_inventory_sha256': inventory_sha,
                  'source_zip_sha256': intake['zip_sha256'],
                  'intake_sha256': metadata['intake_sha256'], 'source_export_date': source_export_date, 'patients': patients, 'context': context,
                  'operational_effects': {'appointments': False, 'payments': False, 'debt': False, 'messages': False,
                      'clinical_reference_update': False, 'current_treatment_execution': False}}
        if hashlib.sha256(p.read_bytes()).hexdigest() != inventory_sha:
            raise ValueError('EURODENT_INVENTORY_CHANGED_DURING_READ')
        bundle['sha256'] = digest(bundle)
        return bundle
    finally:
        connection.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inventory', required=True)
    parser.add_argument('--selection', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--source-export-date')
    parser.add_argument('--dentition-sidecar')
    args = parser.parse_args()
    selection = Path(args.selection)
    if not selection.is_file() or selection.stat().st_mode & 0o077:
        raise ValueError('EURODENT_PRIVATE_SELECTION_REQUIRED')
    selected = json.loads(selection.read_text())
    ids = selected.get('source_patient_ids', selected.get('patient_ids')) if isinstance(selected, dict) else selected
    if ids is None and isinstance(selected, dict) and isinstance(selected.get('patients'), list):
        ids = [p.get('source_patient_id', p.get('id')) if isinstance(p, dict) else p for p in selected['patients']]
    if not isinstance(ids, list) or not all(str(p).isdigit() and int(p) > 0 for p in ids):
        raise ValueError('EURODENT_PATIENT_SELECTION_INVALID')
    if args.source_export_date:
        import datetime
        datetime.datetime.strptime(args.source_export_date, '%Y-%m-%d')
    sidecar = None
    if args.dentition_sidecar:
        decoder_file = Path(args.dentition_sidecar)
        if not decoder_file.is_file() or decoder_file.stat().st_mode & 0o077:
            raise ValueError('EURODENT_PRIVATE_DECODER_REQUIRED')
        sidecar = json.loads(decoder_file.read_text())
    bundle = build_bundle(args.inventory, [str(p) for p in ids], args.source_export_date, sidecar)
    destination = Path(args.out)
    if not destination.is_absolute() or not destination.parent.is_dir() or destination.parent.stat().st_mode & 0o077:
        raise ValueError('EURODENT_PRIVATE_OUTPUT_REQUIRED')
    with os.fdopen(os.open(str(destination), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as output:
        json.dump(bundle, output, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        output.flush(); os.fsync(output.fileno())
    print(json.dumps({'version': bundle['version'], 'patients': len(bundle['patients']), 'records': sum(len(p['records']) for p in bundle['patients']), 'sha256': bundle['sha256'], 'operational_writes': False}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if message.startswith('EURODENT_') and message.replace('_','').isupper() else 'EURODENT_BUNDLE_REQUIRES_PRIVATE_REVIEW', file=sys.stderr)
        sys.exit(1)
