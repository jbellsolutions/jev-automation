/** Which voice speaks: JEV_TTS = elevenlabs | say | off. Unset, ElevenLabs when its key and
 *  voice are configured, else macOS `say`; JEV_SPEAK=off (the older switch) still silences. */
import type { Speaker } from "../../core/speak.js";
import { ElevenLabsSpeaker } from "./elevenlabs.js";
import { selectPlayer } from "./player.js";
import { SaySpeaker } from "./say.js";

export const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam, the voice Hermes uses on Telegram

export function selectSpeaker(env: NodeJS.ProcessEnv = process.env, log: (message: string) => void = (m) => console.warn(m)): Speaker | null {
  const mode = (env.JEV_TTS ?? (env.JEV_SPEAK?.toLowerCase() === "off" ? "off" : "")).toLowerCase();
  if (mode === "off") return null;
  const say = process.platform === "darwin" ? new SaySpeaker({ voice: env.JEV_VOICE || undefined, rate: env.JEV_SPEECH_RATE ? Number(env.JEV_SPEECH_RATE) : undefined }) : null;
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  if (mode === "say" || (mode !== "elevenlabs" && !apiKey)) return say;
  if (!apiKey) {
    log("JEV_TTS=elevenlabs but ELEVENLABS_API_KEY is not set; using say");
    return say;
  }
  return new ElevenLabsSpeaker({ apiKey, voiceId: env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID, modelId: env.ELEVENLABS_TTS_MODEL?.trim() || undefined, player: selectPlayer(env), fallback: say, log });
}

export function describeSpeaker(speaker: Speaker | null): string {
  if (!speaker) return "off";
  return speaker instanceof ElevenLabsSpeaker ? "elevenlabs" : "say";
}
