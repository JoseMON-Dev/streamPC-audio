#!/usr/bin/env bash
# Genera un certificado autofirmado para uso en LAN, de modo que el navegador
# acepte contexto seguro y `AudioWorklet.addModule()` funcione en
# `https://<ip>:8080`.
#
# Detecta IPs del host automáticamente; opcionalmente acepta IPs extra.
#
# Uso:
#   ./scripts/gen-cert.sh                        # autodetecta
#   ./scripts/gen-cert.sh 192.168.1.10           # autodetecta + extra
#   ./scripts/gen-cert.sh stream.local           # alias mDNS (macOS)
#
# Salida:
#   certs/cert.pem + certs/key.pem
# Levanta el server:
#   TLS_CERT=certs/cert.pem TLS_KEY=certs/key.pem bun run src/server.ts
set -euo pipefail

OUT_DIR="certs"

# ---------------------------------------------------------------------------
# Detección de IPs según plataforma (Linux/macOS/BSD).
# ---------------------------------------------------------------------------
detect_ips() {
  local ips=""

  # Linux moderno: `ip -4 -o addr show scope global`
  if command -v ip >/dev/null 2>&1; then
    ips=$(ip -4 -o addr show scope global 2>/dev/null \
          | awk '{print $4}' | cut -d/ -f1 || true)
  fi

  # macOS / BSD: `ifconfig`
  if [[ -z "$ips" ]] && command -v ifconfig >/dev/null 2>&1; then
    ips=$(ifconfig 2>/dev/null \
          | awk '/inet[ \t]/ {gsub(/^[ \t]+/, ""); print $2}' \
          | grep -v '^127\.' || true)
  fi

  # Fallback: `hostname -I` (Linux)
  if [[ -z "$ips" ]] && command -v hostname >/dev/null 2>&1; then
    ips=$(hostname -I 2>/dev/null | tr ' \t' '\n' | grep -v '^$' || true)
  fi

  # Dedup, drop vacías
  if [[ -n "$ips" ]]; then
    printf '%s\n' "$ips" | awk 'NF && !seen[$0]++'
  fi
}

# ---------------------------------------------------------------------------
# Extrae el hostname corto del sistema (para añadir DNS:something al SAN).
# ---------------------------------------------------------------------------
short_host() {
  hostname -s 2>/dev/null || hostname 2>/dev/null | cut -d. -f1
}

# ---------------------------------------------------------------------------
# Build Subject Alternative Name (formato OpenSSL).
# ---------------------------------------------------------------------------
build_san() {
  local extra=("$@")
  local san="DNS:localhost,IP:127.0.0.1"

  local host
  host=$(short_host || true)
  if [[ -n "$host" && "$host" != "localhost" ]]; then
    san+=",DNS:${host}"
    # mDNS .local — útil en macOS
    if [[ "$host" != *".local" ]]; then
      san+=",DNS:${host}.local"
    fi
  fi

  # IPs autodetectadas
  local ip
  while IFS= read -r ip; do
    [[ -z "$ip" ]] && continue
    san+=",IP:${ip}"
  done < <(detect_ips)

  # Argumentos extra (override o adicionales)
  local h
  for h in "${extra[@]}"; do
    [[ -z "$h" ]] && continue
    if [[ "$h" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      san+=",IP:${h}"
    else
      san+=",DNS:${h}"
    fi
  done

  printf '%s' "$san"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
mkdir -p "$OUT_DIR"

SAN=$(build_san "$@")
echo "[gen-cert] SAN = $SAN"

if command -v mkcert >/dev/null 2>&1; then
  echo "[gen-cert] usando mkcert (recomendado, sin avisos en el navegador)"
  # mkcert quiere nombres como argumentos posicionales
  args=("localhost" "127.0.0.1")

  host=$(short_host || true)
  [[ -n "$host" && "$host" != "localhost" ]] && args+=("$host" "${host}.local")

  while IFS= read -r ip; do
    [[ -n "$ip" ]] && args+=("$ip")
  done < <(detect_ips)

  for h in "$@"; do
    [[ -n "$h" ]] && args+=("$h")
  done

  # Dedup
  IFS=" " read -r -a args <<< "$(printf '%s\n' "${args[@]}" | awk '!seen[$0]++' | paste -sd ' ' -)"

  mkcert -cert-file "$OUT_DIR/cert.pem" -key-file "$OUT_DIR/key.pem" "${args[@]}"
  echo "[gen-cert] OK → $OUT_DIR/cert.pem + $OUT_DIR/key.pem"
  echo "[gen-cert] arrancar con:"
  echo "  TLS_CERT=$OUT_DIR/cert.pem TLS_KEY=$OUT_DIR/key.pem bun run src/server.ts"
  exit 0
fi

# Fallback: openssl con config de extensiones SAN inline
echo "[gen-cert] mkcert no encontrado → usando openssl (cert autofirmado, el navegador mostrará aviso la 1ª vez)"

cat > "$OUT_DIR/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = audio-stream

[v3_req]
subjectAltName = ${SAN}
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 365 \
  -config "$OUT_DIR/openssl.cnf" \
  -extensions v3_req \
  -subj "/CN=audio-stream" 2>/dev/null

echo "[gen-cert] OK → $OUT_DIR/cert.pem + $OUT_DIR/key.pem"
echo "[gen-cert] arrancar con:"
echo "  TLS_CERT=$OUT_DIR/cert.pem TLS_KEY=$OUT_DIR/key.pem bun run src/server.ts"
