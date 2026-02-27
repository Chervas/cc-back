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

set -euo pipefail

BASE="${BASE:-http://localhost:3002}"
DOCTOR_ID="${DOCTOR_ID:-19}"
CLINICA_ID="${CLINICA_ID:-1}"
TOKEN="${TOKEN:?Falta TOKEN}"

URL="$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/horarios"

echo "═══ QA 6.7c-back ═══"
echo "URL: $URL"
echo ""

# ─── Paso 0: Asegurar modo avanzado ───
echo "▸ Paso 0: Poner modo avanzado"
curl -s -X PATCH "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' | python3 -m json.tool
echo ""

# ─── Caso 1: Tramo válido en avanzado → 200 ───
# Ajustar dia_semana/hora_inicio/hora_fin a un tramo que esté DENTRO de capa1 ∩ capa2
echo "▸ Caso 1: Tramo válido (debe ser 200)"
HTTP_CODE=$(curl -s -o /tmp/qa-67c-1.json -w "%{http_code}" -X PUT "$URL" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"dia_semana":1,"hora_inicio":"09:00","hora_fin":"13:00","activo":true}]')
echo "  HTTP: $HTTP_CODE"
cat /tmp/qa-67c-1.json | python3 -m json.tool 2>/dev/null || cat /tmp/qa-67c-1.json
echo ""

# ─── Caso 2: Tramo fuera de capa 1 → 422 OUTSIDE_GENERAL_AVAILABILITY ───
# Usar un horario que exceda la disponibilidad general del profesional
echo "▸ Caso 2: Fuera de capa 1 (debe ser 422 OUTSIDE_GENERAL_AVAILABILITY)"
HTTP_CODE=$(curl -s -o /tmp/qa-67c-2.json -w "%{http_code}" -X PUT "$URL" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"dia_semana":1,"hora_inicio":"05:00","hora_fin":"06:00","activo":true}]')
echo "  HTTP: $HTTP_CODE"
cat /tmp/qa-67c-2.json | python3 -m json.tool 2>/dev/null || cat /tmp/qa-67c-2.json
echo ""

# ─── Caso 3: Tramo fuera de apertura clínica → 422 OUTSIDE_CLINIC_OPENING ───
# Usar un horario que esté dentro de capa 1 pero fuera de capa 2
echo "▸ Caso 3: Fuera de apertura clínica (debe ser 422 OUTSIDE_CLINIC_OPENING)"
HTTP_CODE=$(curl -s -o /tmp/qa-67c-3.json -w "%{http_code}" -X PUT "$URL" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"dia_semana":1,"hora_inicio":"22:00","hora_fin":"23:00","activo":true}]')
echo "  HTTP: $HTTP_CODE"
cat /tmp/qa-67c-3.json | python3 -m json.tool 2>/dev/null || cat /tmp/qa-67c-3.json
echo ""

# ─── Caso 4: Día sin disponibilidad general → 422 NO_GENERAL_AVAILABILITY_FOR_DAY ───
# Usar un día de la semana donde el doctor no tiene capa 1 (ej. domingo=0)
echo "▸ Caso 4: Día sin disponibilidad general (debe ser 422 NO_GENERAL_AVAILABILITY_FOR_DAY)"
HTTP_CODE=$(curl -s -o /tmp/qa-67c-4.json -w "%{http_code}" -X PUT "$URL" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"dia_semana":0,"hora_inicio":"09:00","hora_fin":"13:00","activo":true}]')
echo "  HTTP: $HTTP_CODE"
cat /tmp/qa-67c-4.json | python3 -m json.tool 2>/dev/null || cat /tmp/qa-67c-4.json
echo ""

# ─── Caso 5: Modo basico → no valida capa 3 (200 siempre) ───
echo "▸ Caso 5a: Cambiar a modo basico"
curl -s -X PATCH "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"basico"}' | python3 -m json.tool
echo ""

echo "▸ Caso 5b: Tramo cualquiera en basico (debe ser 200, sin validación capa 3)"
HTTP_CODE=$(curl -s -o /tmp/qa-67c-5.json -w "%{http_code}" -X PUT "$URL" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"dia_semana":0,"hora_inicio":"05:00","hora_fin":"06:00","activo":true}]')
echo "  HTTP: $HTTP_CODE"
cat /tmp/qa-67c-5.json | python3 -m json.tool 2>/dev/null || cat /tmp/qa-67c-5.json
echo ""

# ─── Restaurar modo avanzado ───
echo "▸ Restaurar modo avanzado"
curl -s -X PATCH "$BASE/api/personal/$DOCTOR_ID/clinicas/$CLINICA_ID/modo-disponibilidad" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"modo_disponibilidad":"avanzado"}' | python3 -m json.tool

echo ""
echo "═══ QA 6.7c-back COMPLETADO ═══"
