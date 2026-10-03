import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import {
  type AudioSystemReader,
  type AudioChunk,
} from "./audio/index.ts";
import { buildReader, parseArgs, printHelp, type ParsedArgs } from "./cli.ts";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const STATIC_DIR   = join(PROJECT_ROOT, "public");

type ServerWebSocketData = { ip: string };

interface ServerState {
  reader: AudioSystemReader;
  kind: string;
  clients: Set<{ sendBinary: (data: Uint8Array) => void }>;
}

async function loadIndexHtml(): Promise<string> {
  return await readFile(join(PROJECT_ROOT, "index.html"), "utf8");
}

const MIME_BY_EXT: Record<string, string> = {
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico":  "image/x-icon",
  ".wasm": "application/wasm",
};

const CACHEABLE_EXTS = new Set([".js", ".mjs", ".css", ".wasm"]);

/**
 * Sirve un archivo estático desde `public/`. Devuelve `null` si la ruta
 * intenta escapar del directorio (path traversal) o si el archivo no existe.
 */
async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname.replace(/^\/+/, "");
  if (rel === "" || rel.includes("..") || rel.includes("\\")) return null;
  const full = join(STATIC_DIR, rel);
  const inside = relative(STATIC_DIR, full);
  if (inside.startsWith("..") || inside.startsWith("/") || inside.includes("..")) return null;

  const file = Bun.file(full);
  if (!(await file.exists())) return null;

  const ext = extname(full).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const cache = CACHEABLE_EXTS.has(ext) ? "public, max-age=300" : "no-cache";
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function listIPv4(): string[] {
  const out: string[] = [];
  for (const name of Object.keys(networkInterfaces())) {
    for (const i of networkInterfaces()[name] ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function broadcast(state: ServerState, chunk: AudioChunk): void {
  for (const ws of state.clients) {
    try {
      ws.sendBinary(chunk.data);
    } catch {
      /* el close handler limpia el set */
    }
  }
}

function setupShutdown(server: ReturnType<typeof Bun.serve>, reader: AudioSystemReader): void {
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} recibido, cerrando...`);
    server.stop();
    await reader.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function run(args: ParsedArgs): Promise<void> {
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const { reader, kind } = await buildReader(args);
  const state: ServerState = {
    reader,
    kind,
    clients: new Set(),
  };

  const indexHtml = await loadIndexHtml();

  reader.on("chunk", (chunk) => broadcast(state, chunk));
  reader.on("error", (err) => console.error("[reader]", err.message));
  reader.on("close", (code) => console.warn(`[reader] closed (code=${code})`));

  await reader.start();

  const port = Number(process.env.PORT ?? 8080);

  // Soporte TLS opcional. En LAN (http://192.168.x.x) `addModule()` falla por
  // contexto no seguro, así que para activar AudioWorklet en el navegador
  // hay que servir por HTTPS (p. ej. con `mkcert 192.168.1.10`).
  const tlsOptions: { key: ReturnType<typeof Bun.file>; cert: ReturnType<typeof Bun.file> } | undefined = (() => {
    const k = process.env["TLS_KEY"];
    const c = process.env["TLS_CERT"];
    if (k && c) return { key: Bun.file(k), cert: Bun.file(c) };
    return undefined;
  })();

  const server = Bun.serve<ServerWebSocketData>({
    ...(tlsOptions ? { tls: tlsOptions } : {}),
    port,
    hostname: "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const ip = srv.requestIP(req)?.address ?? "unknown";
        const ok = srv.upgrade(req, { data: { ip } });
        if (ok) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(indexHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }
      // Static files from public/ (worklet, css, wasm, íconos, …).
      // Se sirven aquí porque `fetch` es async-friendly para `Bun.file.exists()`.
      return serveStatic(url.pathname).then((res) => res ?? new Response("not found", { status: 404 }));
    },
    websocket: {
      open(ws) {
        state.clients.add(
          ws as unknown as { sendBinary: (data: Uint8Array) => void },
        );
        console.log(
          `[+] cliente conectado desde ${ws.data?.ip ?? "?"} (total: ${state.clients.size})`,
        );
        const hello = JSON.stringify({
          type: "hello",
          sampleRate: reader.format.sampleRate,
          channels: reader.format.channels,
          sampleFormat: reader.format.sampleFormat,
          backend: state.kind,
        });
        ws.send(hello);
      },
      message() {
        /* el cliente no envía nada esperado */
      },
      close(ws) {
        state.clients.delete(
          ws as unknown as { sendBinary: (data: Uint8Array) => void },
        );
        console.log(`[-] cliente desconectado (total: ${state.clients.size})`);
      },
    },
  });

  const ips = listIPv4();
  const wsScheme = tlsOptions ? "wss" : "ws";
  console.log("=====================================");
  console.log(" Audio Stream (Bun + TypeScript)");
  console.log("=====================================");
  console.log(` ${tlsOptions ? "HTTPS/WSS" : "HTTP/WS"}: ${server.url}`);
  console.log(
    ` Audio:   ${reader.format.sampleRate}Hz ${reader.format.channels}ch ${reader.format.sampleFormat}`,
  );
  console.log(` Backend: ${state.kind}`);
  console.log(" Args:");
  if (args.configPath) console.log(`   configjson: ${args.configPath}`);
  for (const [k, v] of Object.entries(args.flags)) {
    console.log(`   --${k}=${v}`);
  }
  console.log(` Accede desde la LAN (${wsScheme}):`);
  for (const ip of ips) console.log(`   ${wsScheme}://${ip}:${server.port}/ws`);
  console.log("=====================================");

  setupShutdown(server, reader);
}

const argv = process.argv.slice(2);
let parsed: ParsedArgs;
try {
  parsed = parseArgs(argv);
} catch (e) {
  console.error("Error parseando argv:", (e as Error).message);
  process.exit(2);
}

run(parsed).catch((err) => {
  console.error("Fallo arrancando:", err.message ?? err);
  process.exit(1);
});
