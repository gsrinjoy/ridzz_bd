import { FRAME, type Denoiser } from './chain';

interface RnnoiseExports {
  c: WebAssembly.Memory;
  d: () => void; // constructors
  f: (model: number) => number; // rnnoise_create
  g: (bytes: number) => number; // malloc
  h: (state: number) => void; // rnnoise_destroy
  i: (ptr: number) => void; // free
  j: (state: number, out: number, input: number) => number; // rnnoise_process_frame
}

/**
 * Binds the 112 KB RNNoise 0.1 build directly, skipping its Emscripten glue,
 * which expects a page and cannot run inside an AudioWorklet.
 *
 * The export letters are minified and belong to @jitsi/rnnoise-wasm 0.2.1, so
 * that version is pinned exactly. tests/unit/rnnoise.test.ts fails on a mismatch.
 *
 * Do not call rnnoise_init (export e): it initialises a state struct at the
 * pointer it is given, so calling it bare wipes low memory and every frame
 * silently passes through unprocessed.
 */
export function createRnnoise(module: WebAssembly.Module): Denoiser {
  let memory: WebAssembly.Memory | undefined;
  const instance = new WebAssembly.Instance(module, {
    a: {
      a: () => 0, // emscripten_resize_heap: the heap is fixed, so refuse growth.
      b: (dest: number, src: number, count: number) => {
        new Uint8Array((memory as WebAssembly.Memory).buffer).copyWithin(dest, src, src + count);
      },
    },
  });
  const x = instance.exports as unknown as RnnoiseExports;
  memory = x.c;
  x.d();
  const state = x.f(0);
  const ptr = x.g(FRAME * 4);
  const heap = new Float32Array(memory.buffer, ptr, FRAME);
  return {
    process(frame) {
      heap.set(frame);
      const probability = x.j(state, ptr, ptr);
      frame.set(heap);
      return probability;
    },
    destroy() {
      x.i(ptr);
      x.h(state);
    },
  };
}
