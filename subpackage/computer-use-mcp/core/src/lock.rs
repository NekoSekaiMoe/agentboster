use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct LockInfo {
    pid: u32,
    session_id: String,
    acquired_at: String,
}

#[derive(Debug)]
pub enum LockError {
    Held { session_id: String, pid: u32 },
    Io(std::io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held { session_id, pid } => {
                write!(f, "Lock held by session {session_id} (pid {pid})")
            }
            LockError::Io(e) => write!(f, "IO error: {e}"),
        }
    }
}

impl std::error::Error for LockError {}

impl From<std::io::Error> for LockError {
    fn from(e: std::io::Error) -> Self {
        LockError::Io(e)
    }
}

pub struct ComputerUseLock {
    path: PathBuf,
}

impl ComputerUseLock {
    pub fn acquire(session_id: &str, config_dir: &Path) -> Result<Self, LockError> {
        let path = config_dir.join("computer-use.lock");

        if path.exists() {
            if let Ok(contents) = fs::read_to_string(&path) {
                if let Ok(info) = serde_json::from_str::<LockInfo>(&contents) {
                    if process_alive(info.pid) {
                        return Err(LockError::Held {
                            session_id: info.session_id,
                            pid: info.pid,
                        });
                    }
                }
            }
            let _ = fs::remove_file(&path);
        }

        // Cross-check the other app's lock
        let other_dir = if config_dir.ends_with("agentboster-desktop") {
            config_dir.parent().unwrap().join("agentboster-cli")
        } else {
            config_dir.parent().unwrap().join("agentboster-desktop")
        };
        let other_lock = other_dir.join("computer-use.lock");
        if other_lock.exists() {
            if let Ok(contents) = fs::read_to_string(&other_lock) {
                if let Ok(info) = serde_json::from_str::<LockInfo>(&contents) {
                    if process_alive(info.pid) {
                        return Err(LockError::Held {
                            session_id: info.session_id,
                            pid: info.pid,
                        });
                    }
                }
            }
        }

        let info = LockInfo {
            pid: std::process::id(),
            session_id: session_id.to_string(),
            acquired_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, serde_json::to_string(&info).unwrap())?;

        Ok(Self { path })
    }
}

impl Drop for ComputerUseLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}
