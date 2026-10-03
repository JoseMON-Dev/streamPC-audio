/**
 * Tipos compartidos del subsistema de captura de audio.
 *
 * Se mantienen deliberadamente mínimos: la responsabilidad del reader es
 * entregar PCM crudo en el formato declarado y eventos de control (error, close).
 */

export type SampleFormat = "s16le" | "s32le" | "f32le";

export interface AudioFormat {
  /** Hz. */
  readonly sampleRate: number;
  readonly channels: number;
  readonly sampleFormat: SampleFormat;
}

/** Bytes de un único frame de captura. PCM interleaved según `AudioFormat`. */
export interface AudioChunk {
  /** PCM crudo. La longitud siempre será múltiplo de `frameSize`. */
  readonly data: Uint8Array;
  /** Wall-clock ms (`Date.now()`) cuando el reader emitió el chunk. */
  readonly timestamp: number;
}
