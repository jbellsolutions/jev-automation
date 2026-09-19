import { describe, expect, it } from "vitest";
import { Segmenter } from "../server/stt/segment.js";

const interim = (text: string) => ({ type: "transcript" as const, text, final: false, speechFinal: false });
const final = (text: string, speechFinal = false) => ({ type: "transcript" as const, text, final: true, speechFinal });

describe("Segmenter", () => {
  it("shows interim text and emits an utterance on speech_final", () => {
    const s = new Segmenter(800);
    expect(s.push(interim("open wiki"), 0)).toEqual([{ type: "interim", text: "open wiki" }]);
    expect(s.push(final("open wikipedia"), 100)).toEqual([{ type: "interim", text: "open wikipedia" }]);
    expect(s.push(interim("and search"), 200)).toEqual([{ type: "interim", text: "open wikipedia and search" }]);
    expect(s.push(final("and search for cats", true), 300)).toEqual([{ type: "utterance", text: "open wikipedia and search for cats" }]);
    expect(s.pendingText).toBe("");
  });

  it("flushes on the provider's utterance end", () => {
    const s = new Segmenter(800);
    s.push(final("scroll down"), 0);
    expect(s.push({ type: "utterance_end" }, 50)).toEqual([{ type: "utterance", text: "scroll down" }]);
  });

  it("flushes after a silent gap, and not before", () => {
    const s = new Segmenter(800);
    s.push(final("go back"), 1000);
    expect(s.tick(1500)).toEqual([]);
    expect(s.tick(1800)).toEqual([{ type: "utterance", text: "go back" }]);
    expect(s.tick(5000)).toEqual([]);
  });

  it("ignores empty finals and never emits empty utterances", () => {
    const s = new Segmenter(800);
    expect(s.push(final("", true), 0)).toEqual([]);
    expect(s.push({ type: "utterance_end" }, 10)).toEqual([]);
    expect(s.tick(5000)).toEqual([]);
  });

  it("an empty speech_final still releases buffered finals", () => {
    const s = new Segmenter(800);
    s.push(final("click next"), 0);
    expect(s.push(final("", true), 100)).toEqual([{ type: "utterance", text: "click next" }]);
  });

  it("flushes whatever is buffered when the stream closes", () => {
    const s = new Segmenter(800);
    s.push(final("reload"), 0);
    s.push(interim("the pa"), 10);
    expect(s.push({ type: "closed" }, 20)).toEqual([{ type: "utterance", text: "reload" }]);
  });
});
