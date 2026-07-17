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
        let parent = config_dir
            .parent()
            .ok_or_else(|| LockError::Io(std::io::Error::other("config_dir has no parent")))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_config_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("computer-use-lock-test")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_and_release() {
        let dir = temp_config_dir("acquire_release");
        let lock_path = dir.join("computer-use.lock");
        {
            let lock = ComputerUseLock::acquire("session-1", &dir).unwrap();
            assert!(lock_path.exists());
            drop(lock);
        }
        assert!(!lock_path.exists());
    }

    #[test]
    fn same_session_cannot_double_acquire() {
        let dir = temp_config_dir("double_acquire");
        let _lock = ComputerUseLock::acquire("session-1", &dir).unwrap();
        let result = ComputerUseLock::acquire("session-2", &dir);
        assert!(result.is_err());
    }

    #[test]
    fn stale_lock_is_reclaimed() {
        let dir = temp_config_dir("stale_lock");
        let lock_path = dir.join("computer-use.lock");
        let info = LockInfo {
            pid: 999_999_999,
            session_id: "old-session".to_string(),
            acquired_at: "2020-01-01T00:00:00Z".to_string(),
        };
        fs::create_dir_all(&dir).unwrap();
        fs::write(&lock_path, serde_json::to_string(&info).unwrap()).unwrap();

        let lock = ComputerUseLock::acquire("new-session", &dir);
        assert!(lock.is_ok());
    }

    #[test]
    fn lock_error_display() {
        let err = LockError::Held {
            session_id: "s1".to_string(),
            pid: 42,
        };
        assert!(err.to_string().contains("s1"));
        assert!(err.to_string().contains("42"));
    }
}
