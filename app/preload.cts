/** Runs in the renderer before the page, with Node isolated away. Exposes only what the UI
 *  needs from the shell: that it is the desktop build, where the companion is, and the hotkey. */
import { contextBridge, ipcRenderer } from "electron";

const baseUrl = process.argv.find((a) => a.startsWith("--jev-base-url="))?.slice("--jev-base-url=".length) ?? "";

contextBridge.exposeInMainWorld("jev", {
  mode: "desktop",
  baseUrl,
  onInterrupt(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:interrupt", handler);
    return () => ipcRenderer.off("jev:interrupt", handler);
  },
  setSpeaking(speaking: boolean): void {
    ipcRenderer.send("jev:speaking", speaking);
  },
  hide(): void {
    ipcRenderer.send("jev:hide");
  },
});
