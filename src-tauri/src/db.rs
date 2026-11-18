//! SQLite persistence layer.
//!
//! Durability: WAL journal with `synchronous = FULL`, every mutation batch runs in a
//! single transaction, so a completed solve is on disk before the UI acknowledges it.
//! Deletions from the UI are soft (tombstones) so they can be undone; imports can be
//! rolled back; backups are consistent snapshots made with `VACUUM INTO`.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Solve {
    pub id: String,
    pub session_id: String,
    pub ord: f64,
    pub time: i64,
    pub penalty: i64,
    pub splits: Option<Vec<i64>>,
    pub scramble: String,
    pub comment: String,
    pub date: Option<i64>,
    pub event: String,
    pub import_id: Option<String>,
    pub fp: String,
    pub extra: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedData {
    pub sessions: Vec<Value>,
    pub solves: Vec<Solve>,
    pub settings: serde_json::Map<String, Value>,
    pub imports: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum Op {
    #[serde(rename = "putSolves")]
    PutSolves { solves: Vec<Solve> },
    #[serde(rename = "putSessions")]
    PutSessions { sessions: Vec<Value> },
    #[serde(rename = "hardDeleteSolves")]
    HardDeleteSolves { ids: Vec<String> },
    #[serde(rename = "hardDeleteSessions")]
    HardDeleteSessions { ids: Vec<String> },
    #[serde(rename = "setSetting")]
    SetSetting { key: String, value: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub created_at: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    pub message: String,
    pub sessions: i64,
    pub solves: i64,
    pub live_solves: i64,
    pub orphan_solves: i64,
    pub schema_version: i64,
    pub db_path: String,
    pub db_size: u64,
}

pub type Result<T> = std::result::Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub struct Db {
    pub conn: Connection,
    pub path: PathBuf,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(e)?;
        }
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = OFF;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(e)?;
        let db = Db { conn, path: path.to_path_buf() };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        self.conn
            .execute_batch("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
            .map_err(e)?;
        let v: i64 = self
            .conn
            .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |r| r.get::<_, String>(0))
            .optional()
            .map_err(e)?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        if v < 1 {
            self.conn
                .execute_batch(
                    "BEGIN;
                     CREATE TABLE IF NOT EXISTS sessions (
                        id TEXT PRIMARY KEY,
                        data TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        deleted_at INTEGER
                     );
                     CREATE TABLE IF NOT EXISTS solves (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        ord REAL NOT NULL,
                        time INTEGER NOT NULL CHECK (time >= 0),
                        penalty INTEGER NOT NULL CHECK (penalty >= -1),
                        splits TEXT,
                        scramble TEXT NOT NULL,
                        comment TEXT NOT NULL,
                        date INTEGER,
                        event TEXT NOT NULL,
                        import_id TEXT,
                        fp TEXT NOT NULL,
                        extra TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        deleted_at INTEGER
                     );
                     CREATE INDEX IF NOT EXISTS solves_session ON solves(session_id, ord);
                     CREATE INDEX IF NOT EXISTS solves_fp ON solves(fp);
                     CREATE INDEX IF NOT EXISTS solves_import ON solves(import_id);
                     CREATE INDEX IF NOT EXISTS solves_date ON solves(date);
                     CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                     CREATE TABLE IF NOT EXISTS imports (
                        id TEXT PRIMARY KEY,
                        data TEXT NOT NULL,
                        source_text TEXT
                     );
                     INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
                     COMMIT;",
                )
                .map_err(e)?;
        }
        // Future migrations: `if v < 2 { ... }`
        Ok(())
    }

    pub fn load_all(&self) -> Result<LoadedData> {
        let mut sessions = Vec::new();
        {
            let mut st = self.conn.prepare("SELECT data FROM sessions").map_err(e)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
            for r in rows {
                let s = r.map_err(e)?;
                sessions.push(serde_json::from_str::<Value>(&s).map_err(e)?);
            }
        }
        let mut solves = Vec::new();
        {
            let mut st = self
                .conn
                .prepare(
                    "SELECT id, session_id, ord, time, penalty, splits, scramble, comment, date, event,
                            import_id, fp, extra, created_at, updated_at, deleted_at
                     FROM solves ORDER BY session_id, ord",
                )
                .map_err(e)?;
            let rows = st
                .query_map([], |r| {
                    let splits: Option<String> = r.get(5)?;
                    Ok(Solve {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        ord: r.get(2)?,
                        time: r.get(3)?,
                        penalty: r.get(4)?,
                        splits: splits.and_then(|s| serde_json::from_str(&s).ok()),
                        scramble: r.get(6)?,
                        comment: r.get(7)?,
                        date: r.get(8)?,
                        event: r.get(9)?,
                        import_id: r.get(10)?,
                        fp: r.get(11)?,
                        extra: r.get(12)?,
                        created_at: r.get(13)?,
                        updated_at: r.get(14)?,
                        deleted_at: r.get(15)?,
                    })
                })
                .map_err(e)?;
            for r in rows {
                solves.push(r.map_err(e)?);
            }
        }
        let mut settings = serde_json::Map::new();
        {
            let mut st = self.conn.prepare("SELECT key, value FROM settings").map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(e)?;
            for r in rows {
                let (k, v) = r.map_err(e)?;
                settings.insert(k, serde_json::from_str(&v).unwrap_or(Value::Null));
            }
        }
        let mut imports = Vec::new();
        {
            let mut st = self.conn.prepare("SELECT data FROM imports").map_err(e)?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
            for r in rows {
                imports.push(serde_json::from_str::<Value>(&r.map_err(e)?).map_err(e)?);
            }
        }
        Ok(LoadedData { sessions, solves, settings, imports })
    }

    fn put_solve(tx: &Transaction, s: &Solve) -> Result<()> {
        if s.id.is_empty() || s.session_id.is_empty() {
            return Err("solve id/session id must not be empty".into());
        }
        let splits = match &s.splits {
            Some(v) => Some(serde_json::to_string(v).map_err(e)?),
            None => None,
        };
        tx.execute(
            "INSERT INTO solves (id, session_id, ord, time, penalty, splits, scramble, comment, date, event,
                                 import_id, fp, extra, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, ord=excluded.ord, time=excluded.time,
               penalty=excluded.penalty, splits=excluded.splits, scramble=excluded.scramble, comment=excluded.comment,
               date=excluded.date, event=excluded.event, import_id=excluded.import_id, fp=excluded.fp,
               extra=excluded.extra, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
            params![
                s.id, s.session_id, s.ord, s.time, s.penalty, splits, s.scramble, s.comment, s.date, s.event,
                s.import_id, s.fp, s.extra, s.created_at, s.updated_at, s.deleted_at
            ],
        )
        .map_err(e)?;
        Ok(())
    }

    fn put_session(tx: &Transaction, s: &Value) -> Result<()> {
        let id = s.get("id").and_then(|v| v.as_str()).ok_or("session without id")?;
        let updated = s.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or_else(now_ms);
        let deleted = s.get("deletedAt").and_then(|v| v.as_i64());
        tx.execute(
            "INSERT INTO sessions (id, data, updated_at, deleted_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at",
            params![id, s.to_string(), updated, deleted],
        )
        .map_err(e)?;
        Ok(())
    }

    fn apply_in(tx: &Transaction, ops: &[Op]) -> Result<()> {
        for op in ops {
            match op {
                Op::PutSolves { solves } => {
                    for s in solves {
                        Self::put_solve(tx, s)?;
                    }
                }
                Op::PutSessions { sessions } => {
                    for s in sessions {
                        Self::put_session(tx, s)?;
                    }
                }
                Op::HardDeleteSolves { ids } => {
                    for id in ids {
                        tx.execute("DELETE FROM solves WHERE id=?1", [id]).map_err(e)?;
                    }
                }
                Op::HardDeleteSessions { ids } => {
                    for id in ids {
                        tx.execute("DELETE FROM sessions WHERE id=?1", [id]).map_err(e)?;
                    }
                }
                Op::SetSetting { key, value } => {
                    tx.execute(
                        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![key, value.to_string()],
                    )
                    .map_err(e)?;
                }
            }
        }
        Ok(())
    }

    /// Apply a batch of operations atomically.
    pub fn apply(&mut self, ops: &[Op]) -> Result<()> {
        let tx = self.conn.transaction().map_err(e)?;
        Self::apply_in(&tx, ops)?;
        tx.commit().map_err(e)
    }

    /// Commit an import: record + sessions + solves + preserved original file, in one transaction.
    pub fn commit_import(&mut self, record: &Value, sessions: &[Value], solves: &[Solve], source_text: &str) -> Result<()> {
        let id = record.get("id").and_then(|v| v.as_str()).ok_or("import record without id")?.to_string();
        let tx = self.conn.transaction().map_err(e)?;
        tx.execute(
            "INSERT INTO imports (id, data, source_text) VALUES (?1, ?2, ?3)",
            params![id, record.to_string(), source_text],
        )
        .map_err(e)?;
        for s in sessions {
            Self::put_session(&tx, s)?;
        }
        for s in solves {
            if s.import_id.as_deref() != Some(id.as_str()) {
                return Err("solve import id mismatch".into());
            }
            Self::put_solve(&tx, s)?;
        }
        tx.commit().map_err(e)
    }

    /// Remove everything an import added. Sessions created by the import are removed only if
    /// no other solves have since been added to them.
    pub fn rollback_import(&mut self, import_id: &str) -> Result<i64> {
        let tx = self.conn.transaction().map_err(e)?;
        let removed = tx.execute("DELETE FROM solves WHERE import_id=?1", [import_id]).map_err(e)? as i64;
        let ses_ids: Vec<String> = {
            let mut st = tx
                .prepare("SELECT id, data FROM sessions")
                .map_err(e)?;
            let rows = st
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(e)?;
            let mut out = Vec::new();
            for r in rows {
                let (id, data) = r.map_err(e)?;
                let v: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
                if v.get("importId").and_then(|x| x.as_str()) == Some(import_id) {
                    out.push(id);
                }
            }
            out
        };
        for sid in ses_ids {
            let n: i64 = tx
                .query_row("SELECT COUNT(*) FROM solves WHERE session_id=?1", [&sid], |r| r.get(0))
                .map_err(e)?;
            if n == 0 {
                tx.execute("DELETE FROM sessions WHERE id=?1", [&sid]).map_err(e)?;
            }
        }
        let data: Option<String> = tx
            .query_row("SELECT data FROM imports WHERE id=?1", [import_id], |r| r.get(0))
            .optional()
            .map_err(e)?;
        if let Some(d) = data {
            let mut v: Value = serde_json::from_str(&d).map_err(e)?;
            v["rolledBackAt"] = Value::from(now_ms());
            tx.execute("UPDATE imports SET data=?1 WHERE id=?2", params![v.to_string(), import_id])
                .map_err(e)?;
        }
        tx.commit().map_err(e)?;
        Ok(removed)
    }

    pub fn import_source(&self, import_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row("SELECT source_text FROM imports WHERE id=?1", [import_id], |r| r.get(0))
            .optional()
            .map_err(e)
            .map(|o| o.flatten())
    }

    pub fn setting_str(&self, key: &str) -> Option<String> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten();
        v.and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
    }

    /// Consistent snapshot of the live database to `dest` (must not exist).
    pub fn snapshot_to(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            return Err(format!("backup target already exists: {}", dest.display()));
        }
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).map_err(e)?;
        }
        self.conn
            .execute("VACUUM INTO ?1", [dest.to_string_lossy().to_string()])
            .map_err(e)?;
        Ok(())
    }

    pub fn integrity(&self) -> Result<IntegrityReport> {
        let msg: String = self.conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(e)?;
        let q = |sql: &str| -> Result<i64> { self.conn.query_row(sql, [], |r| r.get(0)).map_err(e) };
        let sessions = q("SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL")?;
        let solves = q("SELECT COUNT(*) FROM solves")?;
        let live = q("SELECT COUNT(*) FROM solves WHERE deleted_at IS NULL")?;
        let orphans = q("SELECT COUNT(*) FROM solves WHERE session_id NOT IN (SELECT id FROM sessions)")?;
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        Ok(IntegrityReport {
            ok: msg == "ok" && orphans == 0,
            message: if orphans > 0 { format!("{msg}; {orphans} solves reference missing sessions") } else { msg },
            sessions,
            solves,
            live_solves: live,
            orphan_solves: orphans,
            schema_version: SCHEMA_VERSION,
            db_path: self.path.to_string_lossy().to_string(),
            db_size: size,
        })
    }
}

/// Validate that a file is a readable Parity database before restoring it.
pub fn validate_db_file(path: &Path) -> Result<i64> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(e)?;
    let msg: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).map_err(e)?;
    if msg != "ok" {
        return Err(format!("backup failed integrity check: {msg}"));
    }
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM solves", [], |r| r.get(0))
        .map_err(|_| "file is not a Parity database (no solves table)".to_string())?;
    Ok(n)
}

pub fn backup_file_name(reason: &str) -> String {
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S%.3f");
    let safe: String = reason.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    format!("parity-{ts}-{safe}.sqlite")
}

pub fn list_backups(dir: &Path) -> Vec<BackupInfo> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if !(name.starts_with("parity-") || name.starts_with("facelet-")) || !name.ends_with(".sqlite") {
                continue;
            }
            let meta = match ent.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let created = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let reason = name
                .trim_end_matches(".sqlite")
                .splitn(4, '-')
                .nth(3)
                .unwrap_or("")
                .to_string();
            out.push(BackupInfo { path: p.to_string_lossy().to_string(), name, size: meta.len(), created_at: created, reason });
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

/// Keep the newest `keep` automatic backups; manual / safety backups are never pruned.
pub fn prune_backups(dir: &Path, keep: usize) {
    let auto: Vec<BackupInfo> = list_backups(dir).into_iter().filter(|b| b.reason.starts_with("auto")).collect();
    for b in auto.into_iter().skip(keep) {
        let _ = fs::remove_file(&b.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn solve(id: &str, ses: &str, ord: f64, imp: Option<&str>) -> Solve {
        Solve {
            id: id.into(),
            session_id: ses.into(),
            ord,
            time: 12345,
            penalty: 0,
            splits: Some(vec![4000, 12345]),
            scramble: "R U R'".into(),
            comment: "c".into(),
            date: Some(1_700_000_000_000),
            event: "333".into(),
            import_id: imp.map(|s| s.to_string()),
            fp: format!("fp{id}"),
            extra: None,
            created_at: 1,
            updated_at: 1,
            deleted_at: None,
        }
    }

    #[test]
    fn roundtrip_apply_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Db::open(&dir.path().join("t.sqlite")).unwrap();
        db.apply(&[
            Op::PutSessions { sessions: vec![json!({"id":"s1","name":"Session 1","updatedAt":1})] },
            Op::PutSolves { solves: vec![solve("a", "s1", 0.0, None), solve("b", "s1", 1.0, None)] },
            Op::SetSetting { key: "theme".into(), value: json!("oled") },
        ])
        .unwrap();
        let d = db.load_all().unwrap();
        assert_eq!(d.sessions.len(), 1);
        assert_eq!(d.solves.len(), 2);
        assert_eq!(d.solves[0], solve("a", "s1", 0.0, None));
        assert_eq!(d.settings.get("theme").unwrap(), "oled");
        // update in place
        let mut s = solve("a", "s1", 0.0, None);
        s.penalty = 2000;
        db.apply(&[Op::PutSolves { solves: vec![s] }]).unwrap();
        assert_eq!(db.load_all().unwrap().solves[0].penalty, 2000);
        db.apply(&[Op::HardDeleteSolves { ids: vec!["b".into()] }]).unwrap();
        assert_eq!(db.load_all().unwrap().solves.len(), 1);
    }

    #[test]
    fn failed_batch_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Db::open(&dir.path().join("t.sqlite")).unwrap();
        let mut bad = solve("x", "s1", 0.0, None);
        bad.time = -5; // violates CHECK
        let r = db.apply(&[Op::PutSolves { solves: vec![solve("ok", "s1", 0.0, None), bad] }]);
        assert!(r.is_err());
        assert_eq!(db.load_all().unwrap().solves.len(), 0);
    }

    #[test]
    fn import_and_rollback() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Db::open(&dir.path().join("t.sqlite")).unwrap();
        db.apply(&[Op::PutSessions { sessions: vec![json!({"id":"keep","name":"Mine"})] }]).unwrap();
        db.apply(&[Op::PutSolves { solves: vec![solve("mine", "keep", 0.0, None)] }]).unwrap();
        let rec = json!({"id":"imp1","fileName":"x.txt"});
        db.commit_import(
            &rec,
            &[json!({"id":"s2","name":"Imported","importId":"imp1"})],
            &[solve("i1", "s2", 0.0, Some("imp1")), solve("i2", "keep", 1.0, Some("imp1"))],
            "{\"session1\":[]}",
        )
        .unwrap();
        assert_eq!(db.load_all().unwrap().solves.len(), 3);
        assert_eq!(db.import_source("imp1").unwrap().unwrap(), "{\"session1\":[]}");
        let removed = db.rollback_import("imp1").unwrap();
        assert_eq!(removed, 2);
        let d = db.load_all().unwrap();
        assert_eq!(d.solves.len(), 1);
        assert_eq!(d.sessions.len(), 1);
        assert!(d.imports[0].get("rolledBackAt").unwrap().is_i64());
    }

    #[test]
    fn snapshot_validate_and_integrity() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Db::open(&dir.path().join("t.sqlite")).unwrap();
        db.apply(&[Op::PutSessions { sessions: vec![json!({"id":"s1"})] }, Op::PutSolves { solves: vec![solve("a", "s1", 0.0, None)] }])
            .unwrap();
        let bdir = dir.path().join("backups");
        let p = bdir.join(backup_file_name("manual"));
        db.snapshot_to(&p).unwrap();
        assert_eq!(validate_db_file(&p).unwrap(), 1);
        assert!(db.snapshot_to(&p).is_err(), "never overwrite an existing backup");
        let list = list_backups(&bdir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].reason, "manual");
        let rep = db.integrity().unwrap();
        assert!(rep.ok);
        assert_eq!(rep.live_solves, 1);
        // not a db
        let junk = dir.path().join("junk.sqlite");
        fs::write(&junk, b"hello").unwrap();
        assert!(validate_db_file(&junk).is_err());
    }

    #[test]
    fn bulk_insert_20k_is_fast() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Db::open(&dir.path().join("t.sqlite")).unwrap();
        let solves: Vec<Solve> = (0..20000).map(|i| solve(&format!("s{i}"), "s1", i as f64, Some("imp"))).collect();
        let t = std::time::Instant::now();
        db.commit_import(&json!({"id":"imp"}), &[json!({"id":"s1"})], &solves, "").unwrap();
        let load = db.load_all().unwrap();
        assert_eq!(load.solves.len(), 20000);
        assert!(t.elapsed().as_secs_f64() < 10.0);
    }
}
