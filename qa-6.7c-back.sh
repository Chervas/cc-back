#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# QA Script — Bloque 6.7c-back: Validación capa 3 contra capa 1+2
# ═══════════════════════════════════════════════════════════════════
#
# Prerequisitos:
#   - Backend corriendo en localhost:3002 (o ajustar BASE)
#   - Un doctor con id=$DOCTOR_ID asociado a clínica $CLINICA_ID
#   - Disponibilidad general (capa 1) configurada para al menos un día
#   - Horarios de apertura de clínica (capa 2) configurados
#   - Un JWT válido en $TOKEN
#
# Uso:
#   export TOKEN="Bearer eyJ..."
#   export DOCTOR_ID=19
#   export CLINICA_ID=1
#   bash qa-6.7c-back.sh
#
# El script descubre dinámicamente los datos de capa 1 y capa 2
# y construye los tramos de prueba a partir de ellos.
# Cada caso verifica HTTP code y/o JSON code con aserciones automáticas.
# Al inicio hace backup completo del estado; al final (o en error) restaura.

set -euo pipefail

BASE="${BASE:-http://localhost:3002}"
DOCTOR_ID="${DOCTOR_ID:-19}"
CLINICA_ID="${CLINICA_ID:-1}"
TOKEN="${TOKEN:?Falta TOKEN}"

URL_HORARIOS="$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/horarios"
URL_MODO="$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad"
URL_SCHEDULE="$BASE/api/personal/$DOCTOR_ID/schedule"
URL_DISP_GENERAL="$BASE/api/personal/$DOCTOR_ID/disponibilidad-general"

BACKUP_FILE="/tmp/qa-67c-backup.json"
PASS=0
FAIL=0
TOTAL=0

# ─── Assertion helpers ───
assert_http() {
    local label="$1" expected_http="$2" actual_http="$3" body_file="$4"
    TOTAL=$((TOTAL + 1))
    if [ "$actual_http" = "$expected_http" ]; then
        echo "  ✅ $label — HTTP $actual_http (esperado $expected_http)"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $label — HTTP $actual_http (esperado $expected_http)"
        echo "     Body: $(cat "$body_file" 2>/dev/null | head -c 500)"
        FAIL=$((FAIL + 1))
    fi
}

assert_json_field() {
    local label="$1" body_file="$2" jq_expr="$3" expected="$4"
    TOTAL=$((TOTAL + 1))
    local actual
    actual=$(python3 -c "
import json, sys
data = json.load(open('$body_file'))
result = $jq_expr
print(result)
" 2>/dev/null || echo "__ERROR__")
    if [ "$actual" = "$expected" ]; then
        echo "  ✅ $label — '$jq_expr' = $actual"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $label — '$jq_expr' = $actual (esperado $expected)"
        FAIL=$((FAIL + 1))
    fi
}

# ─── Restore function (called via trap) ───
restore_state() {
    echo ""
    echo "▸ Restaurando estado original..."
    if [ ! -f "$BACKUP_FILE" ]; then
        echo "  ⚠️  No hay backup — no se puede restaurar."
        return
    fi

    # Restore modo_disponibilidad
    local ORIG_MODO
    ORIG_MODO=$(python3 -c "
import json
data = json.load(open('$BACKUP_FILE'))
clinicas = data.get('clinicas', [])
for c in clinicas:
    if c.get('clinica_id') == $CLINICA_ID:
        print(c.get('modo_disponibilidad', 'basico'))
        break
else:
    print('basico')
" 2>/dev/null || echo "basico")
    echo "  Modo original: $ORIG_MODO"
    curl -s -X PATCH "$URL_MODO" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"modo_disponibilidad\":\"$ORIG_MODO\"}" > /dev/null

    # Restore horarios de clínica (capa 3)
    local ORIG_HORARIOS
    ORIG_HORARIOS=$(python3 -c "
import json
data = json.load(open('$BACKUP_FILE'))
clinicas = data.get('clinicas', [])
for c in clinicas:
    if c.get('clinica_id') == $CLINICA_ID:
        horarios = c.get('horarios', [])
        clean = []
        for h in horarios:
            clean.append({
                'dia_semana': h['dia_semana'],
                'hora_inicio': h['hora_inicio'],
                'hora_fin': h['hora_fin'],
                'activo': h.get('activo', True)
            })
        print(json.dumps(clean))
        break
else:
    print('[]')
" 2>/dev/null || echo "[]")
    echo "  Restaurando horarios clínica ($CLINICA_ID)..."
    curl -s -X PUT "$URL_HORARIOS" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$ORIG_HORARIOS" > /dev/null

    # Restore disponibilidad general (capa 1)
    local ORIG_DISP_GENERAL
    ORIG_DISP_GENERAL=$(python3 -c "
import json
data = json.load(open('$BACKUP_FILE'))
dg = data.get('disponibilidad_general', [])
clean = []
for h in dg:
    clean.append({
        'dia_semana': h['dia_semana'],
        'hora_inicio': h['hora_inicio'],
        'hora_fin': h['hora_fin'],
        'activo': h.get('activo', True)
    })
print(json.dumps(clean))
" 2>/dev/null || echo "[]")
    echo "  Restaurando disponibilidad general..."
    curl -s -X PUT "$URL_DISP_GENERAL" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$ORIG_DISP_GENERAL" > /dev/null

    echo "  ✅ Estado restaurado."
    rm -f "$BACKUP_FILE"
}

# Register trap for cleanup on exit (success, error, or interrupt)
trap restore_state EXIT

echo "═══════════════════════════════════════════════════"
echo " QA 6.7c-back — Validación capa 3 vs capa 1 + 2"
echo "═══════════════════════════════════════════════════"
echo "Doctor: $DOCTOR_ID | Clínica: $CLINICA_ID"
echo ""

# ─── Paso 0: Backup completo del estado actual ───
echo "▸ Haciendo backup del estado actual..."
HTTP_SCHED=$(curl -s -o "$BACKUP_FILE" -w "%{http_code}" \
  "$URL_SCHEDULE" -H "Authorization: $TOKEN")

if [ "$HTTP_SCHED" != "200" ]; then
    echo "  ❌ No se pudo obtener schedule (HTTP $HTTP_SCHED). Abortando."
    exit 1
fi
echo "  ✅ Backup guardado en $BACKUP_FILE"
echo ""

# ─── Paso 1: Descubrir datos dinámicos de capa 1 y capa 2 ───
echo "▸ Descubriendo datos de schedule..."

# Shape real de /schedule:
#   disponibilidad_general: [] (array directo, cada item: dia_semana, hora_inicio, hora_fin, activo)
#   clinicas: [] (array de clínicas, cada una con horarios_apertura, horarios, modo_disponibilidad, etc.)

# Helper Python: valida que un horario tenga hora_inicio/hora_fin no vacíos y con formato HH:MM válido
# Se reutiliza en todos los bloques de descubrimiento.
VALID_HM_CHECK='
import re
def is_valid_hm(s):
    """Returns True if s is a non-empty string matching HH:MM with valid values."""
    if not s or not isinstance(s, str):
        return False
    m = re.match(r"^(\d{1,2}):(\d{2})$", s.strip())
    if not m:
        return False
    hh, mm = int(m.group(1)), int(m.group(2))
    return 0 <= hh <= 23 and 0 <= mm <= 59

def is_valid_horario(h):
    """Returns True if h has valid, non-empty hora_inicio < hora_fin."""
    return is_valid_hm(h.get("hora_inicio","")) and is_valid_hm(h.get("hora_fin","")) and h["hora_inicio"] < h["hora_fin"]
'

# Discover all valid (day, c1_start, c1_end, c2_start, c2_end) combos
# Output: one line per valid combo "dia|c1s|c1e|c2s|c2e"
ALL_COMBOS=$(python3 -c "
import json
$VALID_HM_CHECK

data = json.load(open('$BACKUP_FILE'))
dg = data.get('disponibilidad_general', [])
clinicas = data.get('clinicas', [])
target_clinica = $CLINICA_ID

# Build capa2 map: day -> list of (start, end)
apertura_by_day = {}
for c in clinicas:
    if c.get('clinica_id') != target_clinica:
        continue
    for h in c.get('horarios_apertura', []):
        if not h.get('activo', True):
            continue
        if not is_valid_horario(h):
            continue
        d = h['dia_semana']
        if d not in apertura_by_day:
            apertura_by_day[d] = []
        apertura_by_day[d].append((h['hora_inicio'], h['hora_fin']))
    break

# Find combos: capa1 day that also has valid capa2
for h in dg:
    if not h.get('activo', True):
        continue
    if not is_valid_horario(h):
        continue
    dia = h['dia_semana']
    if dia in apertura_by_day:
        for c2s, c2e in apertura_by_day[dia]:
            print(f\"{dia}|{h['hora_inicio']}|{h['hora_fin']}|{c2s}|{c2e}\")
" 2>/dev/null || echo "")

if [ -z "$ALL_COMBOS" ]; then
    echo "  ❌ No hay día con capa1 + capa2 válidas. Abortando."
    exit 1
fi

# Pick the first combo as primary
FIRST_COMBO=$(echo "$ALL_COMBOS" | head -1)
IFS='|' read -r C1_DIA C1_INICIO C1_FIN C2_INICIO C2_FIN <<< "$FIRST_COMBO"
echo "  Capa 1 (día $C1_DIA): $C1_INICIO – $C1_FIN"
echo "  Capa 2 (día $C1_DIA): $C2_INICIO – $C2_FIN"

# Compute a valid slot: intersection of capa1 and capa2, take first hour
VALID_SLOT=$(python3 -c "
c1s, c1e = '$C1_INICIO', '$C1_FIN'
c2s, c2e = '$C2_INICIO', '$C2_FIN'
start = max(c1s, c2s)
end = min(c1e, c2e)
sh, sm = int(start.split(':')[0]), int(start.split(':')[1])
eh = sh + 1
em = sm
slot_end = f'{eh:02d}:{em:02d}'
if slot_end <= end and start < slot_end:
    print(f'{start}|{slot_end}')
else:
    em2 = sm + 30
    eh2 = sh
    if em2 >= 60:
        em2 -= 60
        eh2 += 1
    slot_end2 = f'{eh2:02d}:{em2:02d}'
    print(f'{start}|{slot_end2}')
")
IFS='|' read -r VALID_START VALID_END <<< "$VALID_SLOT"
echo "  Tramo válido: día $C1_DIA $VALID_START – $VALID_END"

# Find a day WITHOUT capa 1 (for NO_GENERAL_AVAILABILITY_FOR_DAY test)
NO_C1_DIA=$(python3 -c "
import json
$VALID_HM_CHECK
data = json.load(open('$BACKUP_FILE'))
dg = data.get('disponibilidad_general', [])
used_days = set(h['dia_semana'] for h in dg if h.get('activo', True) and is_valid_horario(h))
for d in range(7):
    if d not in used_days:
        print(d)
        break
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
echo "  Día sin capa 1: $NO_C1_DIA"
echo ""

# ─── Paso 2: Asegurar modo avanzado ───
echo "▸ Paso 2: Poner modo avanzado"
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' > /dev/null
echo "  OK"
echo ""

# ─── Caso 1: Tramo válido en avanzado → 200 ───
# Si devuelve 409 STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC, probar con otros combos/tramos.
echo "▸ Caso 1: Tramo válido dentro de capa1 ∩ capa2 (esperado: 200)"

CASO1_RESOLVED=false

# Try primary slot first
HTTP=$(curl -s -o /tmp/qa-67c-1.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"dia_semana\":$C1_DIA,\"hora_inicio\":\"$VALID_START\",\"hora_fin\":\"$VALID_END\",\"activo\":true}]")

if [ "$HTTP" = "200" ]; then
    CASO1_RESOLVED=true
    assert_http "Caso 1 HTTP" "200" "$HTTP" "/tmp/qa-67c-1.json"
elif [ "$HTTP" = "409" ]; then
    OVERLAP_CODE=$(python3 -c "
import json
data = json.load(open('/tmp/qa-67c-1.json'))
print(data.get('code',''))
" 2>/dev/null || echo "")
    if [ "$OVERLAP_CODE" = "STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC" ]; then
        echo "  ⚠️  409 cross-clinic en tramo primario. Probando alternativas..."
        # Try each combo with progressively smaller/shifted slots
        while IFS='|' read -r ALT_DIA ALT_C1S ALT_C1E ALT_C2S ALT_C2E; do
            ALT_SLOT=$(python3 -c "
start = max('$ALT_C1S', '$ALT_C2S')
end = min('$ALT_C1E', '$ALT_C2E')
if start >= end:
    print('SKIP')
    exit()
sh, sm = int(start.split(':')[0]), int(start.split(':')[1])
# Try multiple offsets: +0h, +1h, +2h from intersection start
for offset in [0, 1, 2]:
    s_h = sh + offset
    s_m = sm
    e_h = s_h + 1
    e_m = sm
    s_str = f'{s_h:02d}:{s_m:02d}'
    e_str = f'{e_h:02d}:{e_m:02d}'
    if s_str >= start and e_str <= end and s_str < e_str:
        print(f'{s_str}|{e_str}')
        exit()
print('SKIP')
" 2>/dev/null || echo "SKIP")
            if [ "$ALT_SLOT" = "SKIP" ]; then
                continue
            fi
            IFS='|' read -r ALT_START ALT_END <<< "$ALT_SLOT"
            HTTP2=$(curl -s -o /tmp/qa-67c-1.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
              -H "Authorization: $TOKEN" \
              -H "Content-Type: application/json" \
              -d "[{\"dia_semana\":$ALT_DIA,\"hora_inicio\":\"$ALT_START\",\"hora_fin\":\"$ALT_END\",\"activo\":true}]")
            if [ "$HTTP2" = "200" ]; then
                CASO1_RESOLVED=true
                echo "  ✅ Caso 1 HTTP — HTTP 200 (alternativa día $ALT_DIA $ALT_START-$ALT_END)"
                TOTAL=$((TOTAL + 1))
                PASS=$((PASS + 1))
                break
            fi
            # Check if still 409 cross-clinic — try next combo
            OVERLAP2=$(python3 -c "
import json
data = json.load(open('/tmp/qa-67c-1.json'))
print(data.get('code',''))
" 2>/dev/null || echo "")
            if [ "$OVERLAP2" != "STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC" ]; then
                # Different error — stop trying
                break
            fi
        done <<< "$ALL_COMBOS"
    fi
fi

if [ "$CASO1_RESOLVED" = "false" ]; then
    # Check if it was a non-cross-clinic error
    if [ "$HTTP" = "409" ] && [ "$OVERLAP_CODE" = "STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC" ]; then
        echo "  ⚠️  SKIP: Todos los tramos válidos colisionan con otra clínica."
        TOTAL=$((TOTAL + 1))
        echo "  ⏭️  Caso 1 omitido (cross-clinic en todos los combos)"
    else
        assert_http "Caso 1 HTTP" "200" "$HTTP" "/tmp/qa-67c-1.json"
    fi
fi
echo ""

# ─── Caso 2: Tramo fuera de capa 1 → 422 OUTSIDE_GENERAL_AVAILABILITY ───
echo "▸ Caso 2: Tramo fuera de capa 1 (esperado: 422 OUTSIDE_GENERAL_AVAILABILITY)"
OUT_C1_SLOT=$(python3 -c "
c1s = '$C1_INICIO'
sh = int(c1s.split(':')[0])
if sh >= 2:
    print(f'{sh-2:02d}:00|{sh-1:02d}:00')
elif sh == 1:
    print('00:00|01:00')
else:
    # c1s starts at 00:00 — use after c1e
    c1e = '$C1_FIN'
    eh = int(c1e.split(':')[0])
    if eh <= 22:
        print(f'{eh+1:02d}:00|{eh+2:02d}:00')
    else:
        print('23:00|23:59')
")
IFS='|' read -r OUT_C1_START OUT_C1_END <<< "$OUT_C1_SLOT"
HTTP=$(curl -s -o /tmp/qa-67c-2.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"dia_semana\":$C1_DIA,\"hora_inicio\":\"$OUT_C1_START\",\"hora_fin\":\"$OUT_C1_END\",\"activo\":true}]")
assert_http "Caso 2 HTTP" "422" "$HTTP" "/tmp/qa-67c-2.json"
assert_json_field "Caso 2 code" "/tmp/qa-67c-2.json" "data.get('code','')" "SCHEDULE_OUT_OF_EFFECTIVE_AVAILABILITY"
assert_json_field "Caso 2 reason" "/tmp/qa-67c-2.json" "data.get('errors',[])[0].get('reason','')" "OUTSIDE_GENERAL_AVAILABILITY"
echo ""

# ─── Caso 3: Tramo fuera de apertura clínica → 422 OUTSIDE_CLINIC_OPENING ───
echo "▸ Caso 3: Tramo dentro de capa 1 pero fuera de capa 2 (esperado: 422 OUTSIDE_CLINIC_OPENING)"
OUT_C2_SLOT=$(python3 -c "
import re
$VALID_HM_CHECK

c1s, c1e = '$C1_INICIO', '$C1_FIN'
c2s, c2e = '$C2_INICIO', '$C2_FIN'

# Validate inputs before int() parsing
if not is_valid_hm(c1s) or not is_valid_hm(c1e) or not is_valid_hm(c2s) or not is_valid_hm(c2e):
    print('SKIP')
    exit()

c2e_h = int(c2e.split(':')[0])
c2e_m = int(c2e.split(':')[1])
c1e_h = int(c1e.split(':')[0])
c1e_m = int(c1e.split(':')[1])

# Try after capa2 end but within capa1
slot_s = f'{c2e_h:02d}:{c2e_m:02d}'
slot_e_h = c2e_h + 1
slot_e = f'{slot_e_h:02d}:{c2e_m:02d}'
if slot_s >= c1s and slot_e <= c1e and slot_s < slot_e:
    print(f'{slot_s}|{slot_e}')
    exit()

# Try before capa2 start but within capa1
c2s_h = int(c2s.split(':')[0])
c2s_m = int(c2s.split(':')[1])
slot_e2 = f'{c2s_h:02d}:{c2s_m:02d}'
slot_s2_h = c2s_h - 1
if slot_s2_h >= 0:
    slot_s2 = f'{slot_s2_h:02d}:{c2s_m:02d}'
    if slot_s2 >= c1s and slot_e2 <= c1e and slot_s2 < slot_e2:
        print(f'{slot_s2}|{slot_e2}')
        exit()

print('SKIP')
")
if [ "$OUT_C2_SLOT" = "SKIP" ]; then
    echo "  ⚠️  SKIP: capa 1 no se extiende más allá de capa 2 en día $C1_DIA. No se puede probar OUTSIDE_CLINIC_OPENING."
    TOTAL=$((TOTAL + 1))
    echo "  ⏭️  Caso 3 omitido (datos insuficientes)"
else
    IFS='|' read -r OUT_C2_START OUT_C2_END <<< "$OUT_C2_SLOT"
    HTTP=$(curl -s -o /tmp/qa-67c-3.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[{\"dia_semana\":$C1_DIA,\"hora_inicio\":\"$OUT_C2_START\",\"hora_fin\":\"$OUT_C2_END\",\"activo\":true}]")
    assert_http "Caso 3 HTTP" "422" "$HTTP" "/tmp/qa-67c-3.json"
    assert_json_field "Caso 3 code" "/tmp/qa-67c-3.json" "data.get('code','')" "SCHEDULE_OUT_OF_EFFECTIVE_AVAILABILITY"
    assert_json_field "Caso 3 reason" "/tmp/qa-67c-3.json" "data.get('errors',[])[0].get('reason','')" "OUTSIDE_CLINIC_OPENING"
fi
echo ""

# ─── Caso 4: Día sin disponibilidad general → 422 NO_GENERAL_AVAILABILITY_FOR_DAY ───
echo "▸ Caso 4: Día sin disponibilidad general (esperado: 422 NO_GENERAL_AVAILABILITY_FOR_DAY)"
if [ "$NO_C1_DIA" = "NONE" ]; then
    echo "  ⚠️  SKIP: Todos los días tienen capa 1 configurada."
    TOTAL=$((TOTAL + 1))
    echo "  ⏭️  Caso 4 omitido (datos insuficientes)"
else
    HTTP=$(curl -s -o /tmp/qa-67c-4.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[{\"dia_semana\":$NO_C1_DIA,\"hora_inicio\":\"09:00\",\"hora_fin\":\"13:00\",\"activo\":true}]")
    assert_http "Caso 4 HTTP" "422" "$HTTP" "/tmp/qa-67c-4.json"
    assert_json_field "Caso 4 code" "/tmp/qa-67c-4.json" "data.get('code','')" "SCHEDULE_OUT_OF_EFFECTIVE_AVAILABILITY"
    assert_json_field "Caso 4 reason" "/tmp/qa-67c-4.json" "data.get('errors',[])[0].get('reason','')" "NO_GENERAL_AVAILABILITY_FOR_DAY"
fi
echo ""

# ─── Caso 5: Modo basico → no valida capa 3 (200 siempre) ───
echo "▸ Caso 5: Modo basico — tramo fuera de todo (esperado: 200, sin validación capa 3)"
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"basico"}' > /dev/null

HTTP=$(curl -s -o /tmp/qa-67c-5.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"dia_semana\":0,\"hora_inicio\":\"04:00\",\"hora_fin\":\"05:00\",\"activo\":true}]")
assert_http "Caso 5 HTTP" "200" "$HTTP" "/tmp/qa-67c-5.json"
echo ""

# ─── Caso 6 (bonus): Tramo que cruza intervalos contiguos de capa 1 → 200 ───
echo "▸ Caso 6 (bonus): Tramo que cruza intervalos contiguos de capa 1 (esperado: 200)"
# Restore avanzado for this test
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' > /dev/null

# Check if capa 1 has contiguous intervals for any day
CONTIGUOUS_SLOT=$(python3 -c "
import json, re
$VALID_HM_CHECK

data = json.load(open('$BACKUP_FILE'))
dg = data.get('disponibilidad_general', [])
clinicas = data.get('clinicas', [])
target_clinica = $CLINICA_ID
apertura_by_day = {}
for c in clinicas:
    if c.get('clinica_id') != target_clinica:
        continue
    for h in c.get('horarios_apertura', []):
        if not h.get('activo', True):
            continue
        if not is_valid_horario(h):
            continue
        d = h['dia_semana']
        if d not in apertura_by_day:
            apertura_by_day[d] = []
        apertura_by_day[d].append((h['hora_inicio'], h['hora_fin']))
    break

by_day = {}
for h in dg:
    if not h.get('activo', True): continue
    if not is_valid_horario(h): continue
    d = h['dia_semana']
    if d not in by_day: by_day[d] = []
    by_day[d].append((h['hora_inicio'], h['hora_fin']))

for d, intervals in by_day.items():
    if len(intervals) < 2: continue
    intervals.sort()
    for i in range(len(intervals)-1):
        if intervals[i][1] == intervals[i+1][0]:
            boundary = intervals[i][1]
            bh, bm = int(boundary.split(':')[0]), int(boundary.split(':')[1])
            slot_s_m = bm - 30
            slot_s_h = bh
            if slot_s_m < 0:
                slot_s_m += 60
                slot_s_h -= 1
            slot_e_m = bm + 30
            slot_e_h = bh
            if slot_e_m >= 60:
                slot_e_m -= 60
                slot_e_h += 1
            slot_s = f'{slot_s_h:02d}:{slot_s_m:02d}'
            slot_e = f'{slot_e_h:02d}:{slot_e_m:02d}'
            if d in apertura_by_day:
                for c2s, c2e in apertura_by_day[d]:
                    if slot_s >= c2s and slot_e <= c2e:
                        print(f'{d}|{slot_s}|{slot_e}')
                        exit()
            print(f'{d}|{slot_s}|{slot_e}')
            exit()
print('SKIP')
")

if [ "$CONTIGUOUS_SLOT" = "SKIP" ]; then
    echo "  ⚠️  SKIP: No hay intervalos contiguos de capa 1 para probar merge."
    TOTAL=$((TOTAL + 1))
    echo "  ⏭️  Caso 6 omitido (datos insuficientes)"
else
    IFS='|' read -r CONT_DIA CONT_START CONT_END <<< "$CONTIGUOUS_SLOT"
    HTTP=$(curl -s -o /tmp/qa-67c-6.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "[{\"dia_semana\":$CONT_DIA,\"hora_inicio\":\"$CONT_START\",\"hora_fin\":\"$CONT_END\",\"activo\":true}]")
    assert_http "Caso 6 HTTP" "200" "$HTTP" "/tmp/qa-67c-6.json"
fi
echo ""

# ─── Resultados ───
# (restore_state se ejecuta automáticamente via trap EXIT)
echo "═══════════════════════════════════════════════════"
echo " Resultados: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
