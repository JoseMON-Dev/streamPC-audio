// Arranca el server con TLS. Usa los certs en `certs/cert.pem` y
// `certs/key.pem` por defecto; permite override por env (gana sobre el default).
//
// Uso:
//   bun run start:tls
//   TLS_CERT=/ruta/cert.pem TLS_KEY=/ruta/key.pem bun run start:tls
//   bun run dev:tls                       # mismo con --watch
//
// Antes de la primera ejecución, genera los certs:
//   bun run cert       # = ./scripts/gen-cert.sh

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "..");

function resolveCertPath(candidate: string | undefined, fallback: string): string {
  // Si es una ruta absoluta o el usuario pasó algo distinto al default, úsala;
  // si no, resuelve el fallback respecto al project root.
  if (candidate && candidate !== fallback) return resolve(PROJECT_ROOT, candidate);
  return resolve(PROJECT_ROOT, fallback);
}

const certPath = resolveCertPath(process.env["TLS_CERT"], "certs/cert.pem");
const keyPath  = resolveCertPath(process.env["TLS_KEY"],  "certs/key.pem");

if (!existsSync(certPath)) {
  console.error(`cert no encontrado: ${certPath}`);
  console.error(`Genera uno primero con:  bun run cert   (= scripts/gen-cert.sh)`);
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`key no encontrada: ${keyPath}`);
  console.error(`Genera una primero con:  bun run cert   (= scripts/gen-cert.sh)`);
  process.exit(1);
}

// Inyecta las rutas en el env antes de cargar el server.
process.env["TLS_CERT"] = certPath;
process.env["TLS_KEY"]  = keyPath;
console.log(`[start:tls] usando TLS_CERT=${certPath}`);
console.log(`[start:tls] usando TLS_KEY=${keyPath}`);

// Carga el server; como usa process.env al arrancar, ya leerá las vars anteriores.
await import("../src/server.ts");
