// Smart Turn v3 (pipecat-ai/smart-turn) in a worker: "did he finish his thought,
// or just pause?" — answered from the audio itself, intonation and all, in a few
// hundred ms, off the main thread so neither the page nor the call stutters.
//
// Loaded lazily the first time voice mode opens. The model (8 MB, int8) is
// served from /models/, fetched by scripts/install-smart-turn.sh.
/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { logMel } from './features'

const MODEL_URL = '/models/smart-turn-v3.2-cpu.onnx'
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl }
// No cross-origin isolation, so no SharedArrayBuffer: one thread is all there is.
ort.env.wasm.numThreads = 1

let session: Promise<ort.InferenceSession> | null = null
function load() {
  if (!session) {
    session = fetch(MODEL_URL)
      .then((r) => { if (!r.ok) throw new Error(`model ${r.status}`); return r.arrayBuffer() })
      .then((buf) => ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }))
    session.catch(() => { session = null })
  }
  return session
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, audio } = e.data || {}
  try {
    if (type === 'warm') {
      await load()
      // One throwaway run so the first real one isn't paying for JIT and allocation.
      const s = await load()
      await s.run({ input_features: new ort.Tensor('float32', new Float32Array(80 * 800), [1, 80, 800]) })
      ;(self as any).postMessage({ id, type: 'ready' })
      return
    }
    const t0 = performance.now()
    const s = await load()
    const features = logMel(audio as Float32Array)
    const out = await s.run({ input_features: new ort.Tensor('float32', features, [1, 80, 800]) })
    // The model's output is already a sigmoid probability; do not squash it again.
    const p = Number((out.logits.data as Float32Array)[0])
    ;(self as any).postMessage({ id, type: 'result', p, ms: Math.round(performance.now() - t0) })
  } catch (err: any) {
    ;(self as any).postMessage({ id, type: 'error', error: String(err?.message || err) })
  }
}
