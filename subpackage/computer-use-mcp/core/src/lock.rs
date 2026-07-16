use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
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
            if let Ok(contents) = fs::read_to_string(&path)
                && let Ok(info) = serde_json::from_str::<LockInfo>(&contents)
                && process_alive(info.pid)
            {
                return Err(LockError::Held {
                    session_id: info.session_id,
                    pid: info.pid,
                });
            }
            let _ = fs::remove_file(&path);
        }

        // Cross-check the other app's lock
        let parent = config_dir.parent().ok_or_else(|| {
            LockError::Io(std::io::Error::other(
                "config_dir has no parent",
            ))
        })?;
        let other_dir = if config_dir.ends_with("agentboster-desktop") {
            parent.join("agentboster-cli")
        } else {
            parent.join("agentboster-desktop")
        };
        let other_lock = other_dir.join("computer-use.lock");
        if other_lock.exists()
            && let Ok(contents) = fs::read_to_string(&other_lock)
            && let Ok(info) = serde_json::from_str::<LockInfo>(&contents)
            && process_alive(info.pid)
        {
            return Err(LockError::Held {
                session_id: info.session_id,
                pid: info.pid,
            });
        }

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let info = LockInfo {
            pid: std::process::id(),
            session_id: session_id.to_string(),
            acquired_at: chrono::Utc::now().to_rfc3339(),
        };
        let content = serde_json::to_string(&info).unwrap();
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    LockError::Io(std::io::Error::new(
                        std::io::ErrorKind::AlreadyExists,
                        "lock file was re-created by another process",
                    ))
                } else {
                    LockError::Io(e)
                }
            })?;
        file.write_all(content.as_bytes())?;

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

#[cfg(target_os = "windows")]
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            out.contains(&pid.to_string())
        })
        .unwrap_or(false)
}

#[cfg(not(any(unix, target_os = "windows")))]
fn process_alive(_pid: u32) -> bool {
    false
}
