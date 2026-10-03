// AudioWorkletProcessor: PCM Int16 LE → Float32 estéreo, con ring buffer
// pre-asignado y drop-oldest en overflow.
//
// Se sirve como archivo estático en `/pcm-sink.js` (ver src/server.ts) y se
// carga con `audioCtx.audioWorklet.addModule('/pcm-sink.js')` desde
// index.html. Si lo editas, recuerda actualizar el `Cache-Control` del
// server o forzar recarga con Cmd/Ctrl+Shift+R.

class PCMSink extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Tamaño del ring buffer (frames). Configurable vía processorOptions; con
    // fallback a 1 s ≈ 44100 frames @ 44.1 kHz.
    const opts = options && options.processorOptions;
    const cap = (opts && opts.capacityFrames) | 0 || 44100;

    this.cap    = cap;
    this.left   = new Float32Array(cap);
    this.right  = new Float32Array(cap);
    this.wIdx   = 0;     // write head
    this.rIdx   = 0;     // read head
    this.avail  = 0;     // frames in the ring

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.type !== "pcm") return;

      const int16  = new Int16Array(m.buffer);   // view, no copy
      const frames = m.frames | 0;
      if (frames <= 0) return;

      let read = 0;
      while (read < frames) {
        const freeSpace = this.cap - this.avail;
        if (freeSpace <= 0) {
          // Overflow: drop the oldest chunk's worth of frames to make room.
          const drop = Math.min(this.cap >> 2, frames - read);
          this.rIdx  = (this.rIdx + drop) % this.cap;
          this.avail -= drop;
          continue;
        }

        const intoEnd = this.cap - this.wIdx;
        const chunk   = Math.min(frames - read, freeSpace, intoEnd);
        const off     = read;

        // Decode Int16 LE interleaved → Float32 en los dos anillos.
        // 1/32768 = 0.000030517578125 (precomputado para hot loop).
        for (let i = 0; i < chunk; i++) {
          this.left [this.wIdx + i] = int16[(off + i) * 2]     * 0.000030517578125;
          this.right[this.wIdx + i] = int16[(off + i) * 2 + 1] * 0.000030517578125;
        }
        this.wIdx  = (this.wIdx + chunk) % this.cap;
        this.avail += chunk;
        read       += chunk;
      }
    };
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const need = outL.length;
    let written = 0;

    while (written < need && this.avail > 0) {
      const intoEnd = this.cap - this.rIdx;
      const chunk   = Math.min(need - written, this.avail, intoEnd);
      outL.set(this.left .subarray(this.rIdx, this.rIdx + chunk), written);
      outR.set(this.right.subarray(this.rIdx, this.rIdx + chunk), written);
      written   += chunk;
      this.rIdx  = (this.rIdx + chunk) % this.cap;
      this.avail -= chunk;
    }

    // Underrun: silencio.
    while (written < need) {
      outL[written] = 0;
      outR[written] = 0;
      written++;
    }
    return true;
  }
}

registerProcessor("pcm-sink", PCMSink);
