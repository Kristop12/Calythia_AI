/**
 * Kokoro TTS demo (Node / script).
 * Calythia uses the same model in the browser via `lib/speak.ts`.
 *
 * Voices: af_heart (default), af_bella, af_nicole, …
 * Model: onnx-community/Kokoro-82M-v1.0-ONNX
 *
 * Run standalone (optional):
 *   npx tsx kokoro.ts
 */
import { KokoroTTS } from "kokoro-js";

const model_id = "onnx-community/Kokoro-82M-v1.0-ONNX";
const tts = await KokoroTTS.from_pretrained(model_id, {
  dtype: "fp32",
  device: "webgpu",
});

const text = "Hi Christopher, how are you doing today?";
const audio = await tts.generate(text, { voice: "af_heart" });
audio.save("audio.wav");
console.log("saved audio.wav");
