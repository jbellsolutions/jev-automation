import { describe, expect, it } from "vitest";
import { FILE_ROOTS, MacComputer, appDisplayName } from "../server/computer.js";

function fake(mdfind: string, fail?: string, front: string[] = ["Slack"]) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const times: Record<string, number> = { "/Users/j/Documents/Resume 2026.pdf": 300, "/Users/j/Downloads/resume-old.docx": 100, "/Users/j/Desktop/Resume.pages": 200 };
  let polls = 0;
  const computer = new MacComputer(
    async (cmd, args) => {
      calls.push({ cmd, args });
      if (fail && `${cmd} ${args.join(" ")}`.includes(fail)) throw new Error(`Unable to find application named '${args.at(-1)}'`);
      return cmd === "mdfind" ? mdfind : "";
    },
    "/Users/j",
    async (p) => times[p] ?? 0,
    async () => front[Math.min(polls++, front.length - 1)] ?? "",
    async () => {},
  );
  return { computer, calls, frontPolls: () => polls };
}

describe("MacComputer", () => {
  it("opens apps by their display name and waits until the app is actually frontmost", async () => {
    // it takes a couple of polls for the launch to reach the foreground
    const late = fake("", undefined, ["Finder", "Finder", "Slack"]);
    expect(await late.computer.openApp("slack")).toBe("Opened Slack");
    expect(late.calls[0]).toEqual({ cmd: "open", args: ["-a", "Slack"] });
    expect(late.frontPolls()).toBe(3); // stopped as soon as Slack came to front
    expect(appDisplayName("slack")).toBe("Slack");
    const vs = fake("", undefined, ["Code"]); // lsappinfo reports "Code" for VS Code
    expect(await vs.computer.openApp("vs code")).toBe("Opened Visual Studio Code");
    await expect(fake("", "Nope").computer.openApp("nope")).rejects.toThrow("Nope"); // launcher errors surface as results, never crashes
  });

  it("finds files by name under the user's own folders, newest first, ignoring caches and code", async () => {
    const { computer, calls } = fake(
      ["/Users/j/Downloads/resume-old.docx", "/Users/j/Library/Caches/resume.tmp", "/Users/j/Documents/Resume 2026.pdf", "/Users/j/Desktop/app/node_modules/resume/index.js", "/Users/j/Desktop/Resume.pages", ""].join("\n"),
    );
    const found = await computer.findFiles("resume");
    expect(found).toEqual(["/Users/j/Documents/Resume 2026.pdf", "/Users/j/Desktop/Resume.pages", "/Users/j/Downloads/resume-old.docx"]);
    const args = calls[0]!.args;
    expect(calls[0]!.cmd).toBe("mdfind");
    expect(args.slice(0, 2)).toEqual(["-name", "resume"]);
    for (const root of FILE_ROOTS) expect(args).toContain(`/Users/j/${root}`);
    expect(await computer.findFiles("  ")).toEqual([]);
  });

  it("opens a path with `open` and names the file", async () => {
    const { computer, calls } = fake("");
    expect(await computer.openPath("/Users/j/Documents/Resume 2026.pdf")).toBe("Opened Resume 2026.pdf");
    expect(calls[0]).toEqual({ cmd: "open", args: ["/Users/j/Documents/Resume 2026.pdf"] });
  });
});
