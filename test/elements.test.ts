import { describe, expect, it } from "vitest";
import { MAX_ELEMENTS, NONE_OPTION, type PageElement, describeElement, elementCriteria, extractElements } from "../server/elements.js";

const el = (over: Partial<PageElement>): PageElement => ({
  id: "e0", tag: "a", role: "", type: "", text: "", label: "", placeholder: "", name: "", hrefShort: null, inViewport: true, ...over,
});

describe("describeElement", () => {
  it("describes links, buttons and fields compactly", () => {
    expect(describeElement(el({ tag: "a", text: "Pricing", hrefShort: "/pricing" }))).toBe('link "Pricing" → /pricing');
    expect(describeElement(el({ tag: "button", text: "Sign in", inViewport: false }))).toBe('button "Sign in" [off-screen]');
    expect(describeElement(el({ tag: "input", type: "search", placeholder: "Search the site", label: "Search" }))).toBe('search box "Search" placeholder "Search the site"');
    expect(describeElement(el({ tag: "input", type: "email", name: "email" }))).toBe('email field "email"');
    expect(describeElement(el({ tag: "div", role: "tab", text: "Docs" }))).toBe('tab "Docs"');
  });
});

describe("elementCriteria", () => {
  it("maps ids to descriptions and always adds a none option", () => {
    const c = elementCriteria([el({ id: "e0", text: "Home" }), el({ id: "e1", tag: "button", text: "Go" })]);
    expect(Object.keys(c)).toEqual(["e0", "e1", NONE_OPTION]);
    expect(c.e1).toBe('button "Go"');
  });
  it("stays within Jev's 255-option limit", () => {
    const many = Array.from({ length: 400 }, (_, i) => el({ id: `e${i}`, text: `Link ${i}` }));
    expect(Object.keys(elementCriteria(many)).length).toBe(MAX_ELEMENTS + 1);
    expect(MAX_ELEMENTS + 1).toBeLessThanOrEqual(255);
  });
});

describe("extractElements", () => {
  it("assigns sequential ids to what the page script returns", async () => {
    const fake = { evaluate: async (_src: string) => [{ tag: "a", role: "", type: "", text: "X", label: "", placeholder: "", name: "", hrefShort: "/x", inViewport: true }] };
    const out = await extractElements(fake as never);
    expect(out).toEqual([expect.objectContaining({ id: "e0", text: "X" })]);
  });
});
