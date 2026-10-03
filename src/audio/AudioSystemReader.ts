import { EventEmitter } from "node:events";
import type { AudioChunk, AudioFormat } from "./types.ts";

/**
 * Contrato público de un lector de audio del sistema.
 *
 * Diseño elegido: **EventEmitter (push) con adaptador `AsyncIterable` opcional**.
 *
 * Por qué emitter y no callbacks o un `yield`:
 *  - El audio del sistema es un flujo *push* contínuo. Encaja nativamente con
 *    `stdout.on("data", …)` que exponen todas las fuentes (parec, pw-record,
 *    ffmpeg, arecord, …).
 *  - Es multi-subscriber: el mismo reader puede alimentar a la vez el WS,
 *    una grabación a disco y un VU meter sin coordinaciones extra.
 *  - La latencia se mantiene baja: no hay queue interna obligatoria; cada
 *    chunk se entrega en cuanto llega.
 *  - Quien prefiera sintaxis declarativa puede usar `for await (const chunk of reader)`.
 *
 * Eventos:
 *  - `"chunk"`  → AudioChunk, emitido en cada bloque entregado por la fuente.
 *  - `"error"`  → Error, errores no fatales (p.ej. parseo de stderr del binario).
 *  - `"close"`  → number | null, código de salida del proceso (null = señal).
 */
export interface AudioSystemReader {
  readonly format: AudioFormat;

  on(event: "chunk", listener: (chunk: AudioChunk) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;

  off(event: "chunk", listener: (chunk: AudioChunk) => void): this;
  off(event: "error", listener: (err: Error) => void): this;
  off(event: "close", listener: (code: number | null) => void): this;

  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;

  /** Adaptador pull: `for await (const chunk of reader) { … }`. */
  [Symbol.asyncIterator](): AsyncIterableIterator<AudioChunk>;
}

export type AudioSystemReaderEventMap = {
  chunk: AudioChunk;
  error: Error;
  close: number | null;
};

/**
 * Base común para implementar `AudioSystemReader`. Maneja el emitter, el
 * lifecycle (`start`/`stop` idempotentes) y el adaptador async-iterable.
 *
 * Las subclases implementan `startImpl()` / `stopImpl()` y llaman a
 * `emitChunk(...)`, `emitError(...)`, `emitClose(...)` cuando corresponde.
 */
export abstract class BaseAudioSystemReader implements AudioSystemReader {
  abstract readonly format: AudioFormat;

  readonly #emitter = new EventEmitter();
  #running = false;

  constructor() {
    this.#emitter.setMaxListeners(64);
  }

  get isRunning(): boolean {
    return this.#running;
  }

  on<K extends keyof AudioSystemReaderEventMap>(
    event: K,
    listener: (payload: AudioSystemReaderEventMap[K]) => void,
  ): this {
    this.#emitter.on(event, listener as (...a: unknown[]) => void);
    return this;
  }

  off<K extends keyof AudioSystemReaderEventMap>(
    event: K,
    listener: (payload: AudioSystemReaderEventMap[K]) => void,
  ): this {
    this.#emitter.off(event, listener as (...a: unknown[]) => void);
    return this;
  }

  protected emitChunk(chunk: AudioChunk): void {
    this.#emitter.emit("chunk", chunk);
  }

  protected emitError(err: Error): void {
    this.#emitter.emit("error", err);
  }

  protected emitClose(code: number | null): void {
    this.#emitter.emit("close", code);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.startImpl();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    await this.stopImpl();
  }

  protected abstract startImpl(): Promise<void>;
  protected abstract stopImpl(): Promise<void>;

  [Symbol.asyncIterator](): AsyncIterableIterator<AudioChunk> {
    const queue: AudioChunk[] = [];
    const waits: Array<(value: AudioChunk | typeof END | { error: Error }) => void> = [];
    let closed = false;
    let pendingError: Error | null = null;
    const END = Symbol("end");

    const onChunk = (c: AudioChunk): void => {
      const w = waits.shift();
      if (w) w(c);
      else queue.push(c);
    };
    const onError = (err: Error): void => {
      pendingError = err;
      closed = true;
      while (waits.length > 0) waits.shift()!({ error: err });
    };
    const onClose = (): void => {
      closed = true;
      while (waits.length > 0) waits.shift()!(END);
    };

    this.on("chunk", onChunk);
    this.on("error", onError);
    this.on("close", onClose);

    const next = (): Promise<AudioChunk | typeof END | { error: Error }> =>
      new Promise((resolve) => {
        if (pendingError) return resolve({ error: pendingError });
        if (queue.length > 0) return resolve(queue.shift()!);
        if (closed) return resolve(END);
        waits.push(resolve);
      });

    const it: AsyncIterableIterator<AudioChunk> = {
      next: async () => {
        const v = await next();
        if (v === END) return { value: undefined, done: true } as const;
        if (typeof v === "object" && v && "error" in v) {
          throw (v as { error: Error }).error;
        }
        return { value: v as AudioChunk, done: false } as const;
      },
      return: async () => {
        this.off("chunk", onChunk);
        this.off("error", onError);
        this.off("close", onClose);
        await this.stop();
        return { value: undefined, done: true } as const;
      },
      throw: async (err) => {
        this.off("chunk", onChunk);
        this.off("error", onError);
        this.off("close", onClose);
        await this.stop();
        throw err;
      },
      [Symbol.asyncIterator]() {
        return it;
      },
    };
    return it;
  }
}
