//! Tauri application shell: owns the SQLite database and exposes a small, typed command API.

pub mod db;

use db::{BackupInfo, Db, IntegrityReport, LoadedData, Op, Solve};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct AppState {
    db: Mutex<Option<Db>>,
    data_dir: PathBuf,
}

impl AppState {
    fn db_path(&self) -> PathBuf {
        self.data_dir.join("parity.sqlite")
    }
    fn backup_dir(&self, db: &Db) -> PathBuf {
        db.setting_str("backupDir").map(PathBuf::from).unwrap_or_else(|| self.data_dir.join("backups"))
    }
}

type R<T> = Result<T, String>;

fn with_db<T>(state: &State<AppState>, f: impl FnOnce(&mut Db) -> R<T>) -> R<T> {
    let mut guard = state.db.lock().map_err(|_| "database lock poisoned".to_string())?;
    let db = guard.as_mut().ok_or("database is not open")?;
    f(db)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Paths {
    data_dir: String,
    db_path: String,
    backup_dir: String,
}

#[tauri::command]
fn db_load(state: State<AppState>) -> R<LoadedData> {
    with_db(&state, |db| db.load_all())
}

#[tauri::command]
fn db_apply(state: State<AppState>, ops: Vec<Op>) -> R<()> {
    with_db(&state, |db| db.apply(&ops))
}

#[tauri::command]
fn import_commit(state: State<AppState>, record: Value, sessions: Vec<Value>, solves: Vec<Solve>, source_text: String) -> R<()> {
    with_db(&state, |db| {
        // Safety snapshot before any import touches the database.
        let dir = state.backup_dir(db);
        db.snapshot_to(&dir.join(db::backup_file_name("pre-import")))?;
        db.commit_import(&record, &sessions, &solves, &source_text)
    })
}

#[tauri::command]
fn import_rollback(state: State<AppState>, import_id: String) -> R<i64> {
    with_db(&state, |db| {
        let dir = state.backup_dir(db);
        db.snapshot_to(&dir.join(db::backup_file_name("pre-rollback")))?;
        db.rollback_import(&import_id)
    })
}

#[tauri::command]
fn import_source(state: State<AppState>, import_id: String) -> R<Option<String>> {
    with_db(&state, |db| db.import_source(&import_id))
}

#[tauri::command]
fn backup_create(state: State<AppState>, reason: String) -> R<BackupInfo> {
    with_db(&state, |db| {
        let dir = state.backup_dir(db);
        let p = dir.join(db::backup_file_name(&reason));
        db.snapshot_to(&p)?;
        db::prune_backups(&dir, 30);
        db::list_backups(&dir)
            .into_iter()
            .find(|b| Path::new(&b.path) == p)
            .ok_or_else(|| "backup written but not found".to_string())
    })
}

#[tauri::command]
fn backup_list(state: State<AppState>) -> R<Vec<BackupInfo>> {
    with_db(&state, |db| Ok(db::list_backups(&state.backup_dir(db))))
}

/// Replace the live database with a backup. A safety snapshot of the current data is taken first.
#[tauri::command]
fn backup_restore(state: State<AppState>, path: String) -> R<i64> {
    let src = PathBuf::from(&path);
    let n = db::validate_db_file(&src)?;
    let mut guard = state.db.lock().map_err(|_| "database lock poisoned".to_string())?;
    let db_path = state.db_path();
    let backup_dir = if let Some(db) = guard.as_ref() {
        let dir = state.backup_dir(db);
        db.snapshot_to(&dir.join(db::backup_file_name("pre-restore")))?;
        dir
    } else {
        state.data_dir.join("backups")
    };
    let _ = backup_dir;
    // Close the connection, swap the files, reopen.
    *guard = None;
    let staging = db_path.with_extension("restore-tmp");
    std::fs::copy(&src, &staging).map_err(|e| e.to_string())?;
    for ext in ["sqlite-wal", "sqlite-shm"] {
        let _ = std::fs::remove_file(db_path.with_extension(ext));
    }
    std::fs::rename(&staging, &db_path).map_err(|e| e.to_string())?;
    *guard = Some(Db::open(&db_path)?);
    Ok(n)
}

#[tauri::command]
fn db_integrity(state: State<AppState>) -> R<IntegrityReport> {
    with_db(&state, |db| db.integrity())
}

#[tauri::command]
fn app_paths(state: State<AppState>) -> R<Paths> {
    with_db(&state, |db| {
        Ok(Paths {
            data_dir: state.data_dir.to_string_lossy().to_string(),
            db_path: state.db_path().to_string_lossy().to_string(),
            backup_dir: state.backup_dir(db).to_string_lossy().to_string(),
        })
    })
}

/// Read a user-selected file (import). Read-only: source files are never modified.
#[tauri::command]
fn read_text_file(path: String) -> R<String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read {path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// Write an export to a user-selected path. Writes to a temp file then renames (atomic).
#[tauri::command]
fn write_text_file(state: State<AppState>, path: String, contents: String) -> R<()> {
    let target = PathBuf::from(&path);
    // Refuse to overwrite the live database or its WAL by accident.
    if target.starts_with(&state.data_dir) && target.extension().map(|e| e != "txt" && e != "json" && e != "csv").unwrap_or(true) {
        return Err("refusing to overwrite application data files".into());
    }
    let tmp = target.with_extension("parity-tmp");
    std::fs::write(&tmp, contents.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> R<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg("-R").arg(&path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
    }
    Ok(())
}

/// Automated self-test hook: returns the phase name when PARITY_SELFTEST is set (used by CI and
/// local verification of the packaged app). Normal launches return None.
#[tauri::command]
fn selftest_mode() -> Option<String> {
    std::env::var("PARITY_SELFTEST").ok().filter(|s| !s.is_empty())
}

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, report: String, ok: bool) -> R<()> {
    if let Ok(p) = std::env::var("PARITY_SELFTEST_OUT") {
        std::fs::write(&p, report.as_bytes()).map_err(|e| e.to_string())?;
    }
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

/// One-time migration from the app's previous name ("Facelet", id app.facelet.timer):
/// copies the database (consistent snapshot) and backups into the new data folder. The old
/// folder is left untouched as an extra safety copy.
fn migrate_from_old_name(data_dir: &Path) {
    let new_db = data_dir.join("parity.sqlite");
    if new_db.exists() {
        return;
    }
    let old_dir = match data_dir.parent() {
        Some(p) => p.join("app.facelet.timer"),
        None => return,
    };
    let old_db = old_dir.join("facelet.sqlite");
    if !old_db.exists() {
        return;
    }
    if let Ok(old) = Db::open(&old_db) {
        let _ = old.snapshot_to(&new_db);
    }
    if let Ok(rd) = std::fs::read_dir(old_dir.join("backups")) {
        let nb = data_dir.join("backups");
        let _ = std::fs::create_dir_all(&nb);
        for e in rd.flatten() {
            let target = nb.join(e.file_name());
            if !target.exists() {
                let _ = std::fs::copy(e.path(), target);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // PARITY_DATA_DIR lets tests use an isolated data directory.
            let data_dir = std::env::var("PARITY_DATA_DIR").map(PathBuf::from).unwrap_or_else(|_| app.path().app_data_dir().expect("no app data dir"));
            std::fs::create_dir_all(&data_dir)?;
            migrate_from_old_name(&data_dir);
            let db = Db::open(&data_dir.join("parity.sqlite")).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            // Daily automatic backup (kept: newest 30).
            let backup_dir = db.setting_str("backupDir").map(PathBuf::from).unwrap_or_else(|| data_dir.join("backups"));
            let recent = db::list_backups(&backup_dir)
                .into_iter()
                .any(|b| b.reason.starts_with("auto") && db::now_ms() - b.created_at < 20 * 3600 * 1000);
            if !recent {
                let has_data = db.integrity().map(|r| r.solves > 0).unwrap_or(false);
                if has_data {
                    let _ = db.snapshot_to(&backup_dir.join(db::backup_file_name("auto-daily")));
                    db::prune_backups(&backup_dir, 30);
                }
            }
            app.manage(AppState { db: Mutex::new(Some(db)), data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_load,
            db_apply,
            import_commit,
            import_rollback,
            import_source,
            backup_create,
            backup_list,
            backup_restore,
            db_integrity,
            app_paths,
            read_text_file,
            write_text_file,
            reveal_path,
            selftest_mode,
            selftest_report
        ])
        .run(tauri::generate_context!())
        .expect("error while running Parity");
}
