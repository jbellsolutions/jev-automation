import type { Transport } from "../transport.ts";
import { useSpeechRecognition } from "./useSpeechRecognition.ts";
import { useStreamingTranscription } from "./useStreamingTranscription.ts";
import type { Voice } from "./voice.ts";

/** Streaming transcription through the companion when it has a provider; the browser's own
 *  Web Speech API otherwise. Both hooks are mounted so the choice can change with `hello`. */
export function useVoice(args: { transport: Transport; sttProvider: string | null; muted: boolean; onUtterance: (text: string) => void }): Voice {
  const streaming = useStreamingTranscription({ transport: args.transport, muted: args.muted, onUtterance: args.onUtterance });
  const webSpeech = useSpeechRecognition(args.onUtterance);
  if (args.sttProvider) {
    return { ...streaming, engine: "streaming", provider: streaming.provider ?? args.sttProvider };
  }
  return { ...webSpeech, engine: "web-speech", provider: null };
}
