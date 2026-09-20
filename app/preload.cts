/** Runs in the renderer before the page, with Node isolated away. Exposes only what the UI
 *  needs from the shell: that it is the desktop build, where the companion is, and the hotkey. */
import { contextBridge, ipcRenderer } from "electron";

const baseUrl = process.argv.find((a) => a.startsWith("--jev-base-url="))?.slice("--jev-base-url=".length) ?? "";

contextBridge.exposeInMainWorld("jev", {
  mode: "desktop",
  baseUrl,
  /** Escape or the busy tray icon asked to cancel the current command/brain run. */
  onCancel(cb: () => void): () => void {
    const handler = () => cb();
    ipcRenderer.on("jev:cancel", handler);
    return () => ipcRenderer.off("jev:cancel", handler);
  },
  setBusy(busy: boolean): void {
    ipcRenderer.send("jev:busy", busy);
  },
  hide(): void {
    ipcRenderer.send("jev:hide");
  },
});
