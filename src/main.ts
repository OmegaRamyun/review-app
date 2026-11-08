// Bootstrap scaffold: proves the drag-drop → real absolute path → backend stat
// round-trip. U1 builds the Mediabunny / Deepgram / scrubber loop on top.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface FileInfo {
  path: string;
  size_bytes: number;
}

const drop = document.querySelector<HTMLElement>("#drop")!;
const info = document.querySelector<HTMLElement>("#info")!;

async function onPaths(paths: string[]) {
  const lines: string[] = [];
  for (const path of paths) {
    try {
      const fi = await invoke<FileInfo>("stat_file", { path });
      lines.push(`${fi.path}\n  ${(fi.size_bytes / 1e9).toFixed(2)} GB`);
    } catch (e) {
      lines.push(`${path}\n  error: ${String(e)}`);
    }
  }
  info.textContent = lines.join("\n");
}

getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over" || p.type === "enter") drop.classList.add("over");
  else drop.classList.remove("over");
  if (p.type === "drop") void onPaths(p.paths);
});
