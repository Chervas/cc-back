#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# QA Script — Bloque 6.7c-back: Validación capa 3 contra capa 1+2
# ═══════════════════════════════════════════════════════════════════
#
# Prerequisitos:
#   - Backend corriendo en localhost:3002 (o ajustar BASE)
#   - Un doctor con id=$DOCTOR_ID asociado a clínica $CLINICA_ID
#   - El doctor en modo 'avanzado' en esa clínica
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

set -euo pipefail

BASE="${BASE:-http://localhost:3002}"
DOCTOR_ID="${DOCTOR_ID:-19}"
CLINICA_ID="${CLINICA_ID:-1}"
TOKEN="${TOKEN:?Falta TOKEN}"

URL_HORARIOS="$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/horarios"
URL_MODO="$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad"
URL_SCHEDULE="$BASE/api/personal/$DOCTOR_ID/schedule"

PASS=0
FAIL=0
TOTAL=0

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

echo "═══════════════════════════════════════════════════"
echo " QA 6.7c-back — Validación capa 3 vs capa 1 + 2"
echo "═══════════════════════════════════════════════════"
echo "Doctor: $DOCTOR_ID | Clínica: $CLINICA_ID"
echo ""

# ─── Paso 0: Descubrir datos dinámicos de capa 1 y capa 2 ───
echo "▸ Descubriendo datos de schedule..."
HTTP_SCHED=$(curl -s -o /tmp/qa-sched.json -w "%{http_code}" \
  "$URL_SCHEDULE" -H "Authorization: $TOKEN")

if [ "$HTTP_SCHED" != "200" ]; then
    echo "  ❌ No se pudo obtener schedule (HTTP $HTTP_SCHED). Abortando."
    exit 1
fi

# Extraer un día con disponibilidad general (capa 1)
CAPA1_INFO=$(python3 -c "
import json
data = json.load(open('/tmp/qa-sched.json'))
dg = data.get('disponibilidad_general', {}).get('horarios', [])
active = [h for h in dg if h.get('activo', True)]
if not active:
    print('NONE')
else:
    h = active[0]
    print(f\"{h['dia_semana']}|{h['hora_inicio']}|{h['hora_fin']}\")
" 2>/dev/null || echo "NONE")

if [ "$CAPA1_INFO" = "NONE" ]; then
    echo "  ❌ No hay disponibilidad general configurada. Abortando."
    exit 1
fi

IFS='|' read -r C1_DIA C1_INICIO C1_FIN <<< "$CAPA1_INFO"
echo "  Capa 1 (día $C1_DIA): $C1_INICIO – $C1_FIN"

# Extraer apertura de clínica (capa 2) para el mismo día
CAPA2_INFO=$(python3 -c "
import json
data = json.load(open('/tmp/qa-sched.json'))
clinicas = data.get('schedule_clinicas', [])
target_clinica = $CLINICA_ID
target_dia = $C1_DIA
for c in clinicas:
    if c.get('clinica_id') != target_clinica:
        continue
    apertura = c.get('horarios_apertura', [])
    for h in apertura:
        if h.get('dia_semana') == target_dia and h.get('activo', True):
            print(f\"{h['hora_inicio']}|{h['hora_fin']}\")
            break
    break
else:
    print('NONE')
" 2>/dev/null || echo "NONE")

if [ "$CAPA2_INFO" = "NONE" ]; then
    echo "  ⚠️  No hay apertura de clínica para día $C1_DIA. Usando día alternativo..."
    # Try to find a day that has both capa1 and capa2
    BOTH_INFO=$(python3 -c "
import json
data = json.load(open('/tmp/qa-sched.json'))
dg = data.get('disponibilidad_general', {}).get('horarios', [])
clinicas = data.get('schedule_clinicas', [])
target_clinica = $CLINICA_ID
apertura_by_day = {}
for c in clinicas:
    if c.get('clinica_id') != target_clinica:
        continue
    for h in c.get('horarios_apertura', []):
        if h.get('activo', True):
            apertura_by_day[h['dia_semana']] = (h['hora_inicio'], h['hora_fin'])
    break
for h in dg:
    if not h.get('activo', True):
        continue
    dia = h['dia_semana']
    if dia in apertura_by_day:
        c2 = apertura_by_day[dia]
        print(f\"{dia}|{h['hora_inicio']}|{h['hora_fin']}|{c2[0]}|{c2[1]}\")
        break
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
    if [ "$BOTH_INFO" = "NONE" ]; then
        echo "  ❌ No hay día con capa1 + capa2. Abortando."
        exit 1
    fi
    IFS='|' read -r C1_DIA C1_INICIO C1_FIN C2_INICIO C2_FIN <<< "$BOTH_INFO"
else
    IFS='|' read -r C2_INICIO C2_FIN <<< "$CAPA2_INFO"
fi

echo "  Capa 2 (día $C1_DIA): $C2_INICIO – $C2_FIN"

# Compute a valid slot: intersection of capa1 and capa2, take first hour
VALID_SLOT=$(python3 -c "
c1s, c1e = '$C1_INICIO', '$C1_FIN'
c2s, c2e = '$C2_INICIO', '$C2_FIN'
start = max(c1s, c2s)
end = min(c1e, c2e)
# Take a 1-hour slot from the start of the intersection
sh, sm = int(start.split(':')[0]), int(start.split(':')[1])
eh = sh + 1
if eh > 23: eh = sh
em = sm
slot_end = f'{eh:02d}:{em:02d}'
if slot_end <= end and start < slot_end:
    print(f'{start}|{slot_end}')
else:
    # Just use start + 30min
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
data = json.load(open('/tmp/qa-sched.json'))
dg = data.get('disponibilidad_general', {}).get('horarios', [])
used_days = set(h['dia_semana'] for h in dg if h.get('activo', True))
for d in range(7):
    if d not in used_days:
        print(d)
        break
else:
    print('NONE')
" 2>/dev/null || echo "NONE")
echo "  Día sin capa 1: $NO_C1_DIA"
echo ""

# ─── Paso 1: Asegurar modo avanzado ───
echo "▸ Paso 0: Poner modo avanzado"
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' > /dev/null
echo "  OK"
echo ""

# ─── Caso 1: Tramo válido en avanzado → 200 ───
echo "▸ Caso 1: Tramo válido dentro de capa1 ∩ capa2 (esperado: 200)"
HTTP=$(curl -s -o /tmp/qa-67c-1.json -w "%{http_code}" -X PUT "$URL_HORARIOS" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"dia_semana\":$C1_DIA,\"hora_inicio\":\"$VALID_START\",\"hora_fin\":\"$VALID_END\",\"activo\":true}]")
assert_http "Caso 1 HTTP" "200" "$HTTP" "/tmp/qa-67c-1.json"
echo ""

# ─── Caso 2: Tramo fuera de capa 1 → 422 OUTSIDE_GENERAL_AVAILABILITY ───
echo "▸ Caso 2: Tramo fuera de capa 1 (esperado: 422 OUTSIDE_GENERAL_AVAILABILITY)"
# Use 1 hour before capa1 start (or 04:00-05:00 if capa1 starts at 00:00)
OUT_C1_SLOT=$(python3 -c "
c1s = '$C1_INICIO'
sh = int(c1s.split(':')[0])
if sh >= 2:
    print(f'{sh-2:02d}:00|{sh-1:02d}:00')
else:
    print('04:00|05:00')
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
# We need a slot inside capa1 but outside capa2. This only works if capa1 extends beyond capa2.
OUT_C2_SLOT=$(python3 -c "
c1s, c1e = '$C1_INICIO', '$C1_FIN'
c2s, c2e = '$C2_INICIO', '$C2_FIN'
# Try after capa2 end but within capa1
c2e_h = int(c2e.split(':')[0])
c2e_m = int(c2e.split(':')[1])
c1e_h = int(c1e.split(':')[0])
c1e_m = int(c1e.split(':')[1])
# Slot: c2e + 0:00 to c2e + 1:00 (if within capa1)
slot_s = f'{c2e_h:02d}:{c2e_m:02d}'
slot_e_h = c2e_h + 1
slot_e = f'{slot_e_h:02d}:{c2e_m:02d}'
if slot_s >= c1s and slot_e <= c1e and slot_s < slot_e:
    print(f'{slot_s}|{slot_e}')
else:
    # Try before capa2 start but within capa1
    c2s_h = int(c2s.split(':')[0])
    c2s_m = int(c2s.split(':')[1])
    c1s_h = int(c1s.split(':')[0])
    c1s_m = int(c1s.split(':')[1])
    slot_e2 = f'{c2s_h:02d}:{c2s_m:02d}'
    slot_s2_h = c2s_h - 1
    if slot_s2_h < 0: slot_s2_h = 0
    slot_s2 = f'{slot_s2_h:02d}:{c2s_m:02d}'
    if slot_s2 >= c1s and slot_e2 <= c1e and slot_s2 < slot_e2:
        print(f'{slot_s2}|{slot_e2}')
    else:
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
# Restore avanzado
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' > /dev/null

# Check if capa 1 has contiguous intervals for any day
CONTIGUOUS_SLOT=$(python3 -c "
import json
data = json.load(open('/tmp/qa-sched.json'))
dg = data.get('disponibilidad_general', {}).get('horarios', [])
clinicas = data.get('schedule_clinicas', [])
target_clinica = $CLINICA_ID
apertura_by_day = {}
for c in clinicas:
    if c.get('clinica_id') != target_clinica:
        continue
    for h in c.get('horarios_apertura', []):
        if h.get('activo', True):
            d = h['dia_semana']
            if d not in apertura_by_day:
                apertura_by_day[d] = []
            apertura_by_day[d].append((h['hora_inicio'], h['hora_fin']))
    break

by_day = {}
for h in dg:
    if not h.get('activo', True): continue
    d = h['dia_semana']
    if d not in by_day: by_day[d] = []
    by_day[d].append((h['hora_inicio'], h['hora_fin']))

for d, intervals in by_day.items():
    if len(intervals) < 2: continue
    intervals.sort()
    for i in range(len(intervals)-1):
        # Check if end of interval i == start of interval i+1 (contiguous)
        if intervals[i][1] == intervals[i+1][0]:
            # Found contiguous pair — build a slot that crosses the boundary
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
            # Verify within capa2
            if d in apertura_by_day:
                for c2s, c2e in apertura_by_day[d]:
                    if slot_s >= c2s and slot_e <= c2e:
                        print(f'{d}|{slot_s}|{slot_e}')
                        exit()
            # Even without capa2 check, print it
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

# ─── Restaurar modo avanzado ───
echo "▸ Restaurando modo avanzado..."
curl -s -X PATCH "$URL_MODO" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' > /dev/null

# ─── Restaurar horario válido ───
echo "▸ Restaurando horario válido..."
curl -s -X PUT "$URL_HORARIOS" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"dia_semana\":$C1_DIA,\"hora_inicio\":\"$VALID_START\",\"hora_fin\":\"$VALID_END\",\"activo\":true}]" > /dev/null

echo ""
echo "═══════════════════════════════════════════════════"
echo " Resultados: $PASS/$TOTAL passed, $FAIL failed"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
