/** Turns a stream of provider transcripts into complete utterances. Finals accumulate until the
 *  provider says speech ended, or nothing new has arrived for `gapMs`. Pure: time is passed in. */
import type { SttEvent } from "./types.js";

export type SegmentEvent =
  /** Live text for display: finals so far plus the current interim. */
  | { type: "interim"; text: string }
  /** A complete utterance, ready to be treated as a command. */
  | { type: "utterance"; text: string };

export class Segmenter {
  private finals: string[] = [];
  private interim = "";
  private lastFinalAt: number | null = null;

  constructor(private readonly gapMs = 800) {}

  get pendingText(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ");
  }

  push(ev: SttEvent, now: number): SegmentEvent[] {
    switch (ev.type) {
      case "transcript": {
        const text = ev.text.trim();
        if (!ev.final) {
          this.interim = text;
          return [{ type: "interim", text: this.pendingText }];
        }
        this.interim = "";
        if (text) {
          this.finals.push(text);
          this.lastFinalAt = now;
        }
        if (ev.speechFinal) return this.flush();
        return [{ type: "interim", text: this.pendingText }];
      }
      case "utterance_end":
        return this.flush();
      case "closed":
        return this.flush();
      default:
        return [];
    }
  }

  /** Call periodically: flushes when the provider went quiet without saying so. */
  tick(now: number): SegmentEvent[] {
    if (this.lastFinalAt !== null && now - this.lastFinalAt >= this.gapMs) return this.flush();
    return [];
  }

  flush(): SegmentEvent[] {
    const text = this.finals.join(" ").trim();
    this.finals = [];
    this.interim = "";
    this.lastFinalAt = null;
    return text ? [{ type: "utterance", text }] : [];
  }
}
