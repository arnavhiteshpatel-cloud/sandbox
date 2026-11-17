import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Backend, FileFilter } from "./backend";

export function createTauriBackend(): Backend {
  return {
    kind: "tauri",
    load: () => invoke("db_load"),
    apply: (ops) => invoke("db_apply", { ops }),
    importCommit: (record, sessions, solves, sourceText) => invoke("import_commit", { record, sessions, solves, sourceText }),
    importRollback: (importId) => invoke("import_rollback", { importId }),
    importSource: (importId) => invoke("import_source", { importId }),
    backupCreate: (reason) => invoke("backup_create", { reason }),
    backupList: () => invoke("backup_list"),
    backupRestore: (path) => invoke("backup_restore", { path }),
    integrity: () => invoke("db_integrity"),
    paths: () => invoke("app_paths"),
    async pickOpenFile(filters: FileFilter[]) {
      const path = await open({ multiple: false, directory: false, filters });
      if (!path || Array.isArray(path)) return null;
      const text = await invoke<string>("read_text_file", { path });
      const name = String(path).split(/[\\/]/).pop() ?? "import";
      return { name, text, size: new TextEncoder().encode(text).length };
    },
    async pickDirectory() {
      const p = await open({ directory: true, multiple: false });
      return typeof p === "string" ? p : null;
    },
    async saveTextFile(defaultName, text, filters) {
      const path = await save({ defaultPath: defaultName, filters });
      if (!path) return null;
      await invoke("write_text_file", { path, contents: text });
      return path;
    },
    setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
    isFullscreen: () => getCurrentWindow().isFullscreen(),
    reveal: (path) => invoke("reveal_path", { path }),
  };
}
