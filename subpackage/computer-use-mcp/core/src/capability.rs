use serde::Serialize;

#[derive(Serialize)]
pub struct Capabilities {
    pub has_display: bool,
    pub platform: String,
    pub display_server: Option<String>,
    pub display_resolution: Option<(u32, u32)>,
    pub scale_factor: f64,
    pub accessibility_granted: bool,
    pub is_admin: bool,
    pub issues: Vec<String>,
}

pub fn detect_capabilities() -> Capabilities {
    let platform = std::env::consts::OS.to_string();
    let (has_display, display_server) = detect_display_server();
    let display_resolution = if has_display {
        detect_resolution().ok()
    } else {
        None
    };
    let scale_factor = display_resolution
        .map(|(w, _)| if w > 2000 { w as f64 / 1400.0 } else { 1.0 })
        .unwrap_or(1.0);
    let accessibility_granted = check_accessibility_permission();
    let is_admin = check_admin_status();

    let mut issues = Vec::new();

    if !has_display {
        issues.push("No display server detected. Computer use tools unavailable.".into());
    }

    if has_display && !accessibility_granted && platform == "macos" {
        issues.push(
            "Accessibility permission required. Grant in: \
             System Preferences → Privacy & Security → Accessibility → \
             Enable AgentBoster"
                .into(),
        );
    }

    Capabilities {
        has_display,
        platform,
        display_server,
        display_resolution,
        scale_factor,
        accessibility_granted,
        is_admin,
        issues,
    }
}

fn detect_display_server() -> (bool, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        (true, Some("quartz".into()))
    }

    #[cfg(target_os = "windows")]
    {
        (true, Some("win32".into()))
    }

    #[cfg(target_os = "linux")]
    {
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            (true, Some("wayland".into()))
        } else if std::env::var("DISPLAY").is_ok() {
            (true, Some("x11".into()))
        } else {
            (false, None)
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        (false, None)
    }
}

fn detect_resolution() -> Result<(u32, u32), Box<dyn std::error::Error>> {
    let monitors = xcap::Monitor::all()?;
    let m = monitors.first().ok_or("No monitors")?;
    Ok((m.width(), m.height()))
}

fn check_accessibility_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe { accessibility_sys::AXIsProcessTrusted() }
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn check_admin_status() -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(not(unix))]
    {
        false
    }
}
