// Copies MediaPipe's WASM runtime out of node_modules so it is served from
// our own origin (no third-party CDN at runtime). Runs before dev and build.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const from = 'node_modules/@mediapipe/tasks-vision/wasm';
const to = 'public/mediapipe';
if (!existsSync(from)) {
  console.warn('[copy-mediapipe] @mediapipe/tasks-vision not installed; skipping');
  process.exit(0);
}
mkdirSync(to, { recursive: true });
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  cpSync(`${from}/${f}`, `${to}/${f}`);
}
console.log('[copy-mediapipe] wasm copied to public/mediapipe');
