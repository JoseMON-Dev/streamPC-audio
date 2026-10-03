// Smoke tests del CLI: cada caso lanza el server en un puerto distinto,
// conecta un WS, valida, y mata el proceso.
//
//   bun run scripts/smoke.ts
//
// Casos cubiertos:
//   ✓ 1. auto-detect                          (--reader auto)
//   ✓ 2. canonical por nombre                 (--reader pipewire)
//   ✓ 3. configjson estricto                  (--reader pipewire --configjson ...)
//   ✓ 4. flags inline mergean sobre canonical (--reader pipewire --rate 48000)
//   ✓ 5. override de optional (--device custom, --latencyMs 30)
//   ✗ 6. JSON con required omitidos          (debe fallar)
//   ✗ 7. flag desconocido                    (debe fallar)
//   ✗ 8. reader desconocido                  (debe fallar)
import { spawn } from "bun";
import { writeFile, unlink } from "node:fs/promises";

const cwd = import.meta.dir + "/..";
const BAD_CONFIG = `${cwd}/.bad-config.json`;

interface CaseResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function waitForPort(port: number, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      sock.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  throw new Error(`timeout esperando :${port}`);
}

async function readHello(port: number): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msg = await new Promise<string>((resolve, reject) => {
    ws.onerror = () => reject(new Error("ws error"));
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") resolve(ev.data);
    };
    setTimeout(() => reject(new Error("timeout hello")), 3000);
  });
  ws.close();
  return JSON.parse(msg);
}

async function runOkCase(
  name: string,
  port: number,
  args: string[],
  expect: (hello: Record<string, unknown>) => boolean,
): Promise<CaseResult> {
  const proc = spawn({
    cmd: ["bun", "run", "src/server.ts", ...args],
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderr = "";
  const dec = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stderr) stderr += dec.decode(chunk);
  })();
  try {
    await waitForPort(port);
    const hello = await readHello(port);
    if (!expect(hello)) {
      throw new Error(`hello inesperado: ${JSON.stringify(hello)}`);
    }
    proc.kill("SIGTERM");
    await proc.exited;
    return { name, ok: true, detail: JSON.stringify(hello) };
  } catch (e) {
    try { proc.kill("SIGTERM"); await proc.exited; } catch { /* ignore */ }
    return { name, ok: false, detail: stderr + " | " + (e as Error).message };
  }
}

async function runFailCase(name: string, args: string[]): Promise<CaseResult> {
  const proc = spawn({
    cmd: ["bun", "run", "src/server.ts", ...args],
    cwd,
    env: { ...process.env, PORT: "8181" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let out = "";
  const dec = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stderr) out += dec.decode(chunk);
    for await (const chunk of proc.stdout) out += dec.decode(chunk);
  })();
  const code = await proc.exited;
  if (code === 0) return { name, ok: false, detail: "process exit 0 (esperaba error)" };
  if (!/config|flag|reader|desconocido/i.test(out)) {
    return { name, ok: false, detail: `output sin mensaje claro: ${out}` };
  }
  const line = out.split("\n").find((l) => /config|flag|reader|desconocido/i.test(l)) ?? "ok";
  return { name, ok: true, detail: line.trim() };
}

const cases: CaseResult[] = [];

// Casos OK
cases.push(
  await runOkCase(
    "auto-detect → backend disponible",
    8091,
    [],
    (h) => typeof h["backend"] === "string" && h["sampleRate"] === 44100 && h["channels"] === 2,
  ),
);
cases.push(
  await runOkCase(
    "--reader pipewire (canonical)",
    8092,
    ["--reader", "pipewire"],
    (h) => h["backend"] === "pipewire" && h["sampleRate"] === 44100,
  ),
);
cases.push(
  await runOkCase(
    "--reader pipewire --configjson examples/pipewire.json (rate=48000)",
    8093,
    ["--reader", "pipewire", "--configjson", "examples/pipewire.json"],
    (h) => h["backend"] === "pipewire" && h["sampleRate"] === 48000,
  ),
);
cases.push(
  await runOkCase(
    "--reader pipewire --sampleRate 48000 (inline override)",
    8094,
    ["--reader", "pipewire", "--sampleRate", "48000"],
    (h) => h["backend"] === "pipewire" && h["sampleRate"] === 48000,
  ),
);
cases.push(
  await runOkCase(
    "--reader pulseaudio --device @DEFAULT_SINK@ --latencyMs 30",
    8095,
    ["--reader", "pulseaudio", "--device", "@DEFAULT_SINK@", "--latencyMs", "30"],
    (h) => h["backend"] === "pulseaudio" && h["sampleRate"] === 44100 && h["channels"] === 2,
  ),
);

// Casos FAIL
cases.push(
  await runFailCase("JSON con campos requeridos omitidos", [
    "--reader",
    "pipewire",
    "--configjson",
    ".bad-config.json",
  ]),
);
cases.push(
  await runFailCase("flag desconocido", ["--reader", "pipewire", "--no-existe", "x"]),
);
cases.push(
  await runFailCase("reader desconocido", ["--reader", "fake-reader"]),
);

await writeFile(BAD_CONFIG, JSON.stringify({ sampleRate: 44100 })).catch(() => {});
const failMissing = await runFailCase("JSON con required omitidos (real)", [
  "--reader",
  "pipewire",
  "--configjson",
  ".bad-config.json",
]);
failMissing.name = "JSON con required omitidos (real)";
cases.push(failMissing);
await unlink(BAD_CONFIG).catch(() => {});

let pass = 0;
let fail = 0;
for (const c of cases) {
  if (c.ok) {
    console.log(`[OK]   ${c.name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${c.name}\n        → ${c.detail ?? ""}`);
    fail++;
  }
}
console.log(`\n${pass}/${cases.length} ok, ${fail} fallidos`);
process.exit(fail === 0 ? 0 : 1);
