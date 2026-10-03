import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ConfigSchema, ReaderConfigInput } from "../../config/schema.ts";
import { resolveReaderConfig } from "../../config/schema.ts";
import { BaseAudioSystemReader } from "../AudioSystemReader.ts";
import type { AudioChunk, AudioFormat, SampleFormat } from "../types.ts";

/**
 * WASAPI loopback en Windows.
 *
 * Backend primario: `node-wasapi-loopback` (addon nativo, COM directo).
 * Fallback:        `ffmpeg -f wasapi -loopback 1` (cualquier ffmpeg ≥ 5.x con wasapi).
 *
 * El reader NO extiende `SpawnedAudioReader` porque el camino nativo no es
 * un child_process: usa callbacks internos y emitimos cada bloque como
 * `AudioChunk` directo.
 */
export type WasapiBackend = "auto" | "ffmpeg";

export interface WasapiLoopbackConfig {
  /** Opcional. Default: `auto` (intenta nativo, luego ffmpeg). */
  backend?: WasapiBackend;
  /** OBLIGATORIO. */
  sampleRate: number;
  /** OBLIGATORIO. */
  channels: number;
  /** OBLIGATORIO. */
  sampleFormat: SampleFormat;
}

export const WasapiLoopbackSchema: ConfigSchema<WasapiLoopbackConfig> = {
  required: ["sampleRate", "channels", "sampleFormat"],
  optional: ["backend"],
  defaults: { backend: "auto" },
  fields: {
    backend: "enum",
    sampleRate: "number",
    channels: "number",
    sampleFormat: "enum",
  },
  enums: {
    backend: ["auto", "ffmpeg"],
    sampleFormat: ["s16le", "s32le", "f32le"],
  },
};

export type WasapiLoopbackInput = ReaderConfigInput<WasapiLoopbackConfig>;

interface NativeLoopback {
  on(ev: "data", cb: (chunk: Buffer) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  start(): void;
  stop(): void;
}

export class WasapiLoopbackReader extends BaseAudioSystemReader {
  readonly format: AudioFormat;
  readonly #cfg: WasapiLoopbackConfig;
  #proc: ChildProcess | null = null;
  #native: NativeLoopback | null = null;

  constructor(input: WasapiLoopbackInput = WasapiLoopbackReader.canonical()) {
    super();
    this.#cfg = resolveReaderConfig(input, WasapiLoopbackSchema, "wasapi-loopback");
    this.format = {
      sampleRate: this.#cfg.sampleRate,
      channels: this.#cfg.channels,
      sampleFormat: this.#cfg.sampleFormat,
    };
  }

  static canonical(): WasapiLoopbackConfig {
    return {
      backend: "auto",
      sampleRate: 44100,
      channels: 2,
      sampleFormat: "s16le",
    };
  }

  protected async startImpl(): Promise<void> {
    if (this.#cfg.backend === "auto") {
      try {
        await this.#startNative();
        return;
      } catch (e) {
        console.warn(
          `[wasapi] addon nativo no disponible (${(e as Error).message}); usando ffmpeg`,
        );
      }
    }
    this.#spawnFfmpeg();
  }

  async #startNative(): Promise<void> {
    const mod = (await import("node-wasapi-loopback" as string)) as {
      default?: new (opts: Record<string, unknown>) => NativeLoopback;
    };
    const Ctor = mod.default;
    if (!Ctor) throw new Error("node-wasapi-loopback no expone default export");
    const native = new Ctor({
      sampleRate: this.#cfg.sampleRate,
      channels: this.#cfg.channels,
    });
    native.on("data", (b: Buffer) => this.#pushChunk(b));
    native.on("error", (err) => this.emitError(err));
    native.start();
    this.#native = native;
  }

  #spawnFfmpeg(): void {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "wasapi",
        "-loopback",
        "1",
        "-ac",
        String(this.#cfg.channels),
        "-ar",
        String(this.#cfg.sampleRate),
        "-f",
        "s16le",
        "-i",
        "default",
        "-acodec",
        "pcm_s16le",
        "-f",
        "s16le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.#proc = proc;
    proc.stdout?.on("data", (b: Buffer) => this.#pushChunk(b));
    let stderrBuf = "";
    proc.stderr?.on("data", (b: Buffer) => {
      stderrBuf += b.toString("utf8");
    });
    proc.on("error", (err) => this.emitError(err));
    proc.on("exit", (code) => {
      if (code !== 0 && code !== null && stderrBuf.trim().length > 0) {
        this.emitError(
          new Error(`[wasapi/ffmpeg] exit=${code}\n${stderrBuf.trim()}`),
        );
      }
      this.emitClose(code);
      this.#proc = null;
    });
  }

  #pushChunk(b: Buffer): void {
    const u8 = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    const chunk: AudioChunk = { data: u8, timestamp: Date.now() };
    this.emitChunk(chunk);
  }

  protected async stopImpl(): Promise<void> {
    const proc = this.#proc;
    if (proc) {
      this.#proc = null;
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1500);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
      clearTimeout(killTimer);
      return;
    }
    const native = this.#native;
    if (native) {
      try {
        native.stop();
      } catch {
        /* ignore */
      }
      this.#native = null;
    }
  }
}
