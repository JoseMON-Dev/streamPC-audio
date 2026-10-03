import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { BaseAudioSystemReader } from "../AudioSystemReader.ts";
import type { AudioFormat, AudioChunk } from "../types.ts";

export interface SpawnedReaderOptions {
  /** Binario a invocar (debe estar en PATH o ser ruta absoluta). */
  readonly command: string;
  /** Argumentos posicionales/flags. */
  readonly args: readonly string[];
  /** Formato PCM emitido por el binario en stdout. */
  readonly format: AudioFormat;
  /** Etiqueta humana para logs/errores (p.ej. "pulseaudio", "wasapi"). */
  readonly label: string;
  /** Si el binario requiere `start()` explícito (`false` por defecto, lo arrancamos al spawnear). */
  readonly manualStart?: boolean;
}

/**
 * `AudioSystemReader` genérico para fuentes que exponen PCM por stdout
 * (la gran mayoría: `parec`, `pw-record`, `arecord`, `ffmpeg -f wasapi …`).
 *
 * Se ocupa de:
 *  - spawn del proceso,
 *  - reenviar `stdout.data` como `AudioChunk`,
 *  - capturar stderr y emitirlo como `error` si el proceso termina con error,
 *  - cierre limpio (SIGTERM → SIGKILL con timeout),
 *  - idempotencia de `start`/`stop`.
 */
export abstract class SpawnedAudioReader extends BaseAudioSystemReader {
  readonly #opts: SpawnedReaderOptions;
  #proc: ChildProcess | null = null;

  constructor(opts: SpawnedReaderOptions) {
    super();
    this.#opts = opts;
  }

  get format(): AudioFormat {
    return this.#opts.format;
  }

  get command(): string {
    return this.#opts.command;
  }

  protected get proc(): ChildProcess | null {
    return this.#proc;
  }

  /** Hook para que subclases añadan listeners extra sobre el proceso. */
  protected attach?(proc: ChildProcess): void;

  protected async startImpl(): Promise<void> {
    const { command, args, label } = this.#opts;
    const proc = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#proc = proc;

    let stderrBuf = "";
    proc.stderr?.on("data", (b: Buffer) => {
      stderrBuf += b.toString("utf8");
    });

    proc.stdout?.on("data", (b: Buffer) => {
      const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      const chunk: AudioChunk = { data: u8, timestamp: Date.now() };
      this.emitChunk(chunk);
    });

    proc.on("error", (err) => {
      this.emitError(err);
    });

    proc.on("exit", (code, signal) => {
      const stderr = stderrBuf.trim();
      this.#proc = null;
      if (code !== 0 && code !== null && stderr.length > 0) {
        this.emitError(new Error(`[${label}] exit=${code} signal=${signal}\n${stderr}`));
      }
      this.emitClose(code);
    });

    this.attach?.(proc);
  }

  protected async stopImpl(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = null;

    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
    });
    try {
      proc.kill("SIGTERM");
    } catch {
      /* proceso ya muerto */
    }

    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500);

    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    clearTimeout(killTimer);
  }
}
