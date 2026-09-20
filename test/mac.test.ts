import { describe, expect, it } from "vitest";
import { type AxElement, type MacWindow, driverKey, frontWindow, isStaleTokenError, macSnapshot, toPageElements } from "../core/mac.js";

const win = (o: Partial<MacWindow>): MacWindow => ({
  app_name: "Slack",
  pid: 100,
  window_id: 1,
  title: "general - Acme",
  layer: 0,
  is_on_screen: true,
  bounds: { x: 0, y: 0, width: 1200, height: 800 },
  ...o,
});

describe("mac: the window in front", () => {
  it("is the first ordinary on-screen window that is not ours, not system UI and not a tooltip", () => {
    const list = [
      win({ app_name: "Jev", pid: 7, window_id: 10 }), // the floating panel, just focused
      win({ app_name: "universalAccessAuthWarn", pid: 8, window_id: 11, title: "Screen Recording" }),
      win({ app_name: "Cua Driver", pid: 9, window_id: 12, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }),
      win({ app_name: "Slack", pid: 100, window_id: 13, bounds: { x: 0, y: 0, width: 54, height: 54 } }), // a badge
      win({ app_name: "Finder", pid: 50, window_id: 14, is_on_screen: false }),
      win({ app_name: "Slack", pid: 100, window_id: 15 }),
      win({ app_name: "Google Chrome", pid: 60, window_id: 16 }),
    ];
    expect(frontWindow(list, [7])?.window_id).toBe(15);
    expect(frontWindow(list)?.window_id).toBe(10); // without ownPids the panel counts
    expect(frontWindow([win({ layer: 3 })])).toBeNull();
    expect(frontWindow([])).toBeNull();
  });

  it("prefers the frontmost app's largest window over raw z-order (a doc window can float above the active app)", () => {
    const list = [
      win({ app_name: "TextEdit", pid: 30, window_id: 20, bounds: { x: 0, y: 0, width: 656, height: 400 } }), // topmost in z-order
      win({ app_name: "Slack", pid: 100, window_id: 21, bounds: { x: 0, y: 0, width: 100, height: 300 } }), // a thread pane
      win({ app_name: "Slack", pid: 100, window_id: 22, bounds: { x: 0, y: 0, width: 2308, height: 1341 } }), // the main window, further back
    ];
    expect(frontWindow(list, [], 100)?.window_id).toBe(22); // Slack is frontmost app → its biggest window
    expect(frontWindow(list, [], 30)?.window_id).toBe(20); // TextEdit frontmost → its window
    expect(frontWindow(list, [], 999)?.window_id).toBe(20); // frontmost app has no ordinary window → z-order
    expect(frontWindow(list, [30], 30)?.window_id).toBe(22); // our own pid is never the front; the thread pane is too small
  });
});

describe("mac: accessibility tree -> page elements", () => {
  const tree: AxElement[] = [
    { element_index: 0, role: "AXWindow", label: "general - Acme", actions: ["AXRaise"], element_token: "s1:0" },
    { element_index: 1, role: "AXWebArea", label: "general - Acme", actions: ["AXShowMenu", "AXScrollToVisible"], element_token: "s1:1" },
    { element_index: 2, role: "AXStaticText", label: "Channels", actions: ["AXShowMenu"], element_token: "s1:2" },
    { element_index: 3, role: "AXRow", label: "general", actions: ["AXPress", "AXShowMenu"], element_token: "s1:3", frame: { x: 10, y: 100, w: 200, h: 24 } },
    { element_index: 4, role: "AXRow", label: "random", actions: ["AXPress"], element_token: "s1:4", frame: { x: 10, y: 124, w: 200, h: 1 } },
    { element_index: 5, role: "AXButton", label: "New message", actions: ["AXPress"], element_token: "s1:5" },
    { element_index: 6, role: "AXTextArea", label: "Message #general", value: "", element_token: "s1:6" },
    { element_index: 7, role: "AXButton", label: "", actions: ["AXPress"], element_token: "s1:7" }, // unlabeled: useless to pick from
    { element_index: 8, role: "AXLink", label: "Acme docs", element_token: "s1:8" },
    { element_index: 9, role: "AXTextArea", label: "hello from jev\nsecond line", value: "hello from jev\nsecond line", element_token: "s1:9" },
  ];

  it("keeps clickable and typable things with a name, in tree order, ids e0.., and remembers their tokens", () => {
    const { elements, tokens } = toPageElements(tree);
    expect(elements.map((e) => [e.id, e.role, e.text || e.label])).toEqual([
      ["e0", "row", "general"],
      ["e1", "row", "random"],
      ["e2", "button", "New message"],
      ["e3", "text area", "Message #general"],
      ["e4", "link", "Acme docs"],
      ["e5", "text area", ""], // an untitled text view is not named after its contents
    ]);
    expect(elements[5]!.placeholder).toBe("hello from jev");
    expect(tokens.get("e0")?.element_token).toBe("s1:3");
    expect(tokens.get("e3")?.element_token).toBe("s1:6");
    expect(elements[1]!.inViewport).toBe(false); // an h:1 frame is a virtualised row off screen
    expect(elements[0]!.inViewport).toBe(true);
  });

  it("caps the list and labels the snapshot after the app", () => {
    const { snapshot, tokens } = macSnapshot(win({ title: "" }), tree, 2);
    expect(snapshot).toEqual({ url: "app://Slack", title: "Slack", elements: [expect.objectContaining({ id: "e0" }), expect.objectContaining({ id: "e1" })] });
    expect(tokens.size).toBe(2);
  });
});

describe("mac: keys and errors", () => {
  it("translates spoken key names to the driver's", () => {
    expect(driverKey("Enter")).toEqual({ key: "return", modifiers: [] });
    expect(driverKey("esc")).toEqual({ key: "escape", modifiers: [] });
    expect(driverKey("cmd+enter")).toEqual({ key: "return", modifiers: ["cmd"] });
    expect(driverKey("shift tab")).toEqual({ key: "tab", modifiers: ["shift"] });
    expect(driverKey("Control-Option-Delete")).toEqual({ key: "delete", modifiers: ["ctrl", "option"] });
  });

  it("recognises the driver's stale-snapshot refusals", () => {
    expect(isStaleTokenError("element_token s1:3 is stale: superseded by snapshot s2")).toBe(true);
    expect(isStaleTokenError("snapshot s1 not found")).toBe(true);
    expect(isStaleTokenError("AXPress failed: element not enabled")).toBe(false);
  });
});
