/** Tries providers in order: if one fails before it opens, the next takes over transparently
 *  (audio sent meanwhile is replayed, up to a bound). The relay only ever sees one stream. */
import type { SttEvent, SttProvider, SttStart, SttStream } from "./types.js";

const MAX_REPLAY_BYTES = 320_000; // ~10 s of 16 kHz PCM

export class FallbackProvider implements SttProvider {
  /** Reported as the active provider's name once one opens. */
  name: string;

  constructor(private readonly providers: SttProvider[]) {
    if (providers.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.name = providers[0]!.name;
  }

  open(start: SttStart, onEvent: (ev: SttEvent) => void): SttStream {
    let index = 0;
    let stream: SttStream | null = null;
    let opened = false;
    let finished = false;
    let closed = false;
    const replay: Uint8Array[] = [];
    let replayBytes = 0;

    let exhausted = false;
    const tryNext = (): void => {
      const provider = this.providers[index++];
      if (!provider) {
        if (!exhausted) onEvent({ type: "closed" });
        exhausted = true;
        return;
      }
      let thisOpened = false;
      stream = provider.open(start, (ev) => {
        if (closed) return;
        if (ev.type === "open") {
          thisOpened = true;
          opened = true;
          this.name = provider.name;
          onEvent(ev);
          for (const chunk of replay) stream?.send(chunk);
          replay.length = 0;
          if (finished) stream?.finish();
          return;
        }
        if (!thisOpened) {
          // failed before opening: annotate the error, move on when it closes (providers always close after an error)
          if (ev.type === "error") onEvent({ type: "error", message: `${provider.name}: ${ev.message} — trying ${this.providers[index]?.name ?? "nothing else"}` });
          else if (ev.type === "closed") tryNext();
          return;
        }
        onEvent(ev);
      });
    };
    tryNext();

    return {
      send: (audio) => {
        if (opened) return stream?.send(audio);
        if (replayBytes + audio.byteLength > MAX_REPLAY_BYTES) return;
        replay.push(audio);
        replayBytes += audio.byteLength;
      },
      finish: () => {
        finished = true;
        if (opened) stream?.finish();
      },
      close: () => {
        closed = true;
        stream?.close();
      },
    };
  }
}
