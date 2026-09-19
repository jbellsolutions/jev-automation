import { AppleSpeechProvider, appleSpeechAvailable } from "./apple.js";
import { DeepgramProvider } from "./deepgram.js";
import { FallbackProvider } from "./fallback.js";
import type { SttProvider } from "./types.js";

/** The streaming provider for /ws/stt, or null when the UI must fall back to Web Speech.
 *  STT_PROVIDER=deepgram|apple pins one; otherwise Deepgram (when keyed) is tried first and
 *  Apple's on-device recognizer takes over if Deepgram cannot open (no credit, bad key, offline). */
export function selectSttProvider(env: NodeJS.ProcessEnv = process.env): SttProvider | null {
  const deepgram = env.DEEPGRAM_API_KEY ? new DeepgramProvider({ apiKey: env.DEEPGRAM_API_KEY, model: env.DEEPGRAM_MODEL || undefined }) : null;
  const apple = appleSpeechAvailable() ? new AppleSpeechProvider() : null;
  const pick = (env.STT_PROVIDER ?? "auto").toLowerCase();
  if (pick === "deepgram") return deepgram;
  if (pick === "apple") return apple;
  const chain: SttProvider[] = [deepgram, apple].filter((p) => p !== null);
  if (chain.length === 0) return null;
  return chain.length === 1 ? chain[0]! : new FallbackProvider(chain);
}
