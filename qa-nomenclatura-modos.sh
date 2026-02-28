#!/usr/bin/env bash
# ============================================================
# QA: Nomenclatura canónica de modo_disponibilidad
# Verifica que backend acepta valores canónicos y legacy,
# normaliza en respuestas, y excluye sin_citas de /api/doctores.
#
# Requisitos:
#   export TOKEN="Bearer eyJ..."
#   export DOCTOR_ID=19
#   export CLINICA_ID=1
#   export BASE_URL="http://localhost:3002"  # opcional
# ============================================================
set -euo pipefail

BASE="${BASE_URL:-http://localhost:3002}"
: "${TOKEN:?TOKEN requerido}"
: "${DOCTOR_ID:?DOCTOR_ID requerido}"
: "${CLINICA_ID:?CLINICA_ID requerido}"

PASS=0; FAIL=0; SKIP=0
BACKUP_FILE="/tmp/qa-nomenclatura-backup.json"
ORIGINAL_MODO=""

# ── Helpers ──────────────────────────────────────────────────
assert_http() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label (HTTP $actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — esperado HTTP $expected, obtenido $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local label="$1" json="$2" field="$3" expected="$4"
  local actual
  actual=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$field',''))" 2>/dev/null || echo "PARSE_ERROR")
  if [ "$actual" = "$expected" ]; then
    echo "  ✅ $label ($field=$actual)"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $label — $field esperado '$expected', obtenido '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

skip_case() {
  echo "  ⏭️  SKIP: $1"
  SKIP=$((SKIP + 1))
}

# ── Backup estado original ───────────────────────────────────
backup_state() {
  echo "📦 Backup del estado original..."
  local schedule_json
  schedule_json=$(curl -s -H "Authorization: $TOKEN" \
    "$BASE/api/personal/$DOCTOR_ID/schedule")

  echo "$schedule_json" > "$BACKUP_FILE"

  ORIGINAL_MODO=$(echo "$schedule_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
clinicas = data.get('clinicas', [])
for c in clinicas:
    if str(c.get('clinica_id','')) == '$CLINICA_ID':
        print(c.get('modo_disponibilidad', 'citas_personalizadas'))
        break
else:
    print('citas_personalizadas')
" 2>/dev/null || echo "citas_personalizadas")

  echo "   Modo original: $ORIGINAL_MODO"
}

# ── Restore estado original ──────────────────────────────────
restore_state() {
  echo ""
  echo "🔄 Restaurando estado original..."
  if [ -n "$ORIGINAL_MODO" ]; then
    curl -s -o /dev/null -X PATCH \
      -H "Authorization: $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"modo_disponibilidad\": \"$ORIGINAL_MODO\"}" \
      "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad"
    echo "   Modo restaurado a: $ORIGINAL_MODO"
  fi
  rm -f "$BACKUP_FILE"
}
trap restore_state EXIT

# ── Función auxiliar: cambiar modo ───────────────────────────
set_modo() {
  local modo="$1"
  local http_code body
  body=$(curl -s -w "\n%{http_code}" -X PATCH \
    -H "Authorization: $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"modo_disponibilidad\": \"$modo\"}" \
    "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
  http_code=$(echo "$body" | tail -1)
  echo "$body" | sed '$d'
  return 0
}

get_modo_from_schedule() {
  local schedule_json
  schedule_json=$(curl -s -H "Authorization: $TOKEN" \
    "$BASE/api/personal/$DOCTOR_ID/schedule")
  echo "$schedule_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for c in data.get('clinicas', []):
    if str(c.get('clinica_id','')) == '$CLINICA_ID':
        print(c.get('modo_disponibilidad', ''))
        break
else:
    print('')
" 2>/dev/null
}

# ══════════════════════════════════════════════════════════════
echo "═══════════════════════════════════════════════════"
echo "  QA: Nomenclatura canónica modo_disponibilidad"
echo "═══════════════════════════════════════════════════"
echo ""

backup_state

# ── Caso 1: PATCH con valor canónico sin_citas ───────────────
echo ""
echo "── Caso 1: PATCH modo=sin_citas (canónico) ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "sin_citas"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta sin_citas" "200" "$http"
assert_json_field "Respuesta devuelve canónico" "$json" "modo_disponibilidad" "sin_citas"

# Verificar que schedule devuelve canónico
actual_modo=$(get_modo_from_schedule)
if [ "$actual_modo" = "sin_citas" ]; then
  echo "  ✅ GET /schedule devuelve sin_citas"
  PASS=$((PASS + 1))
else
  echo "  ❌ GET /schedule devuelve '$actual_modo' en vez de 'sin_citas'"
  FAIL=$((FAIL + 1))
fi

# ── Caso 2: PATCH con valor canónico citas_automaticas ───────
echo ""
echo "── Caso 2: PATCH modo=citas_automaticas (canónico) ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "citas_automaticas"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta citas_automaticas" "200" "$http"
assert_json_field "Respuesta devuelve canónico" "$json" "modo_disponibilidad" "citas_automaticas"

# ── Caso 3: PATCH con valor canónico citas_personalizadas ────
echo ""
echo "── Caso 3: PATCH modo=citas_personalizadas (canónico) ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "citas_personalizadas"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta citas_personalizadas" "200" "$http"
assert_json_field "Respuesta devuelve canónico" "$json" "modo_disponibilidad" "citas_personalizadas"

# ── Caso 4: PATCH con valor legacy solo_registro → sin_citas ─
echo ""
echo "── Caso 4: PATCH modo=solo_registro (legacy) → normaliza a sin_citas ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "solo_registro"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta legacy solo_registro" "200" "$http"
assert_json_field "Respuesta normaliza a sin_citas" "$json" "modo_disponibilidad" "sin_citas"

# ── Caso 5: PATCH con valor legacy basico → citas_automaticas ─
echo ""
echo "── Caso 5: PATCH modo=basico (legacy) → normaliza a citas_automaticas ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "basico"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta legacy basico" "200" "$http"
assert_json_field "Respuesta normaliza a citas_automaticas" "$json" "modo_disponibilidad" "citas_automaticas"

# ── Caso 6: PATCH con valor legacy avanzado → citas_personalizadas ─
echo ""
echo "── Caso 6: PATCH modo=avanzado (legacy) → normaliza a citas_personalizadas ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "avanzado"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
assert_http "PATCH acepta legacy avanzado" "200" "$http"
assert_json_field "Respuesta normaliza a citas_personalizadas" "$json" "modo_disponibilidad" "citas_personalizadas"

# ── Caso 7: PATCH con valor inválido → 400 ──────────────────
echo ""
echo "── Caso 7: PATCH modo=invalido → 400 ──"
body=$(curl -s -w "\n%{http_code}" -X PATCH \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad": "invalido"}' \
  "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad")
http=$(echo "$body" | tail -1)
assert_http "PATCH rechaza valor inválido" "400" "$http"

# ── Caso 8: sin_citas excluye de /api/doctores ──────────────
echo ""
echo "── Caso 8: sin_citas excluye de /api/doctores ──"
# Poner en sin_citas primero
set_modo "sin_citas" > /dev/null
doctors_json=$(curl -s -H "Authorization: $TOKEN" \
  "$BASE/api/doctores?clinica_id=$CLINICA_ID&activo=true")
found=$(echo "$doctors_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
docs = data if isinstance(data, list) else data.get('data', data.get('doctors', []))
ids = [str(d.get('id', d.get('id_usuario', ''))) for d in docs]
print('found' if '$DOCTOR_ID' in ids else 'not_found')
" 2>/dev/null || echo "error")
if [ "$found" = "not_found" ]; then
  echo "  ✅ Doctor $DOCTOR_ID excluido de /api/doctores en modo sin_citas"
  PASS=$((PASS + 1))
else
  echo "  ❌ Doctor $DOCTOR_ID NO excluido de /api/doctores en modo sin_citas"
  FAIL=$((FAIL + 1))
fi

# Restaurar a citas_personalizadas para verificar que reaparece
set_modo "citas_personalizadas" > /dev/null
doctors_json2=$(curl -s -H "Authorization: $TOKEN" \
  "$BASE/api/doctores?clinica_id=$CLINICA_ID&activo=true")
found2=$(echo "$doctors_json2" | python3 -c "
import sys, json
data = json.load(sys.stdin)
docs = data if isinstance(data, list) else data.get('data', data.get('doctors', []))
ids = [str(d.get('id', d.get('id_usuario', ''))) for d in docs]
print('found' if '$DOCTOR_ID' in ids else 'not_found')
" 2>/dev/null || echo "error")
if [ "$found2" = "found" ]; then
  echo "  ✅ Doctor $DOCTOR_ID reaparece en /api/doctores en modo citas_personalizadas"
  PASS=$((PASS + 1))
else
  echo "  ❌ Doctor $DOCTOR_ID NO reaparece en /api/doctores en modo citas_personalizadas"
  FAIL=$((FAIL + 1))
fi

# ── Caso 9: disponibilidad/check con sin_citas → conflicto ──
echo ""
echo "── Caso 9: disponibilidad/check con sin_citas → conflicto ──"
set_modo "sin_citas" > /dev/null
# Usar fecha de mañana
TOMORROW=$(date -d "+1 day" +%Y-%m-%d 2>/dev/null || date -v+1d +%Y-%m-%d)
body=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: $TOKEN" \
  "$BASE/api/disponibilidad/check?clinica_id=$CLINICA_ID&doctor_id=$DOCTOR_ID&inicio_local=${TOMORROW}T10:00:00&fin_local=${TOMORROW}T10:30:00")
http=$(echo "$body" | tail -1)
json=$(echo "$body" | sed '$d')
if [ "$http" = "409" ]; then
  echo "  ✅ disponibilidad/check devuelve 409 en modo sin_citas"
  PASS=$((PASS + 1))
else
  echo "  ❌ disponibilidad/check devuelve HTTP $http en vez de 409"
  FAIL=$((FAIL + 1))
fi

# ══════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Resultados: $PASS passed, $FAIL failed, $SKIP skipped"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
