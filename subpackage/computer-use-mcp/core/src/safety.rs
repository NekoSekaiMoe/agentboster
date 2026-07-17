use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
use core_graphics::window::{kCGNullWindowID, kCGWindowListOptionOnScreenOnly};

pub type WindowId = u64;

/// Returns window IDs of terminal applications to exclude from screenshots.
///
/// - macOS: CGWindowListCopyWindowInfo by owner name
/// - Windows: EnumWindows by class name / window title
/// - Linux: returns empty (no reliable cross-desktop API; conservative fallback in screenshot.rs)
pub fn terminal_window_ids() -> Vec<WindowId> {
    #[cfg(target_os = "macos")]
    {
        terminal_window_ids_macos()
    }

    #[cfg(target_os = "windows")]
    {
        terminal_window_ids_windows()
    }

    #[cfg(target_os = "linux")]
    {
        Vec::new()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn terminal_window_ids_macos() -> Vec<WindowId> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    let terminal_bundle_ids = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "io.alacritty",
        "com.github.wez.wezterm",
        "dev.warp.Warp-Stable",
        "co.zeit.hyper",
        "com.github.Kitty",
        "net.kovidgoyal.kitty",
        "com.mitchellh.ghostty",
    ];

    let mut window_ids = Vec::new();

    unsafe {
        let window_list = core_graphics::window::CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly,
            kCGNullWindowID,
        );

        if window_list.is_null() {
            return window_ids;
        }

        let windows: CFArray<CFDictionary> = CFArray::wrap_under_create_rule(window_list as _);

        for i in 0..windows.len() {
            if let Some(window_dict) = windows.get(i) {
                let owner_key = CFString::from_static_string("kCGWindowOwnerName");
                if let Some(owner_name) = window_dict.find(&owner_key as *const _ as *const _) {
                    let owner_name_cf: CFString = CFType::wrap_under_get_rule(*owner_name as _);
                    let owner_str = owner_name_cf.to_string();

                    let is_terminal = terminal_bundle_ids.iter().any(|bundle_id| {
                        owner_str.contains(bundle_id)
                            || owner_str.to_lowercase().contains("terminal")
                            || owner_str.to_lowercase().contains("iterm")
                            || owner_str.to_lowercase().contains("alacritty")
                    });

                    if is_terminal {
                        let id_key = CFString::from_static_string("kCGWindowNumber");
                        if let Some(window_id) = window_dict.find(&id_key as *const _ as *const _) {
                            let id_cf: CFNumber = CFType::wrap_under_get_rule(*window_id as _);
                            if let Some(id) = id_cf.to_i64() {
                                window_ids.push(id as WindowId);
                            }
                        }
                    }
                }
            }
        }
    }

    window_ids
}

#[cfg(target_os = "windows")]
fn terminal_window_ids_windows() -> Vec<WindowId> {
    let mut window_ids = Vec::new();

    unsafe {
        use winapi::shared::windef::HWND;
        use winapi::um::winuser::{EnumWindows, GetClassNameW, GetWindowTextW, IsWindowVisible};

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: isize) -> i32 {
            let window_ids = &mut *(lparam as *mut Vec<WindowId>);

            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }

            let mut class_name = [0u16; 256];
            let class_len = GetClassNameW(hwnd, class_name.as_mut_ptr(), 256);

            let mut window_title = [0u16; 256];
            let title_len = GetWindowTextW(hwnd, window_title.as_mut_ptr(), 256);

            if class_len > 0 {
                let class_str = String::from_utf16_lossy(&class_name[..class_len as usize]);

                let is_terminal_class = [
                    "ConsoleWindowClass",
                    "CASCADIA_HOSTING_WINDOW_CLASS",
                    "VirtualConsoleClass",
                    "mintty",
                    "PuTTY",
                ]
                .iter()
                .any(|&pattern| class_str.contains(pattern));

                let mut is_terminal_title = false;
                if title_len > 0 {
                    let title_str = String::from_utf16_lossy(&window_title[..title_len as usize])
                        .to_lowercase();
                    is_terminal_title = ["powershell", "cmd.exe", "terminal", "bash", "wsl"]
                        .iter()
                        .any(|&pattern| title_str.contains(pattern));
                }

                if is_terminal_class || is_terminal_title {
                    window_ids.push(hwnd as WindowId);
                }
            }

            1
        }

        EnumWindows(Some(enum_proc), &mut window_ids as *mut _ as isize);
    }

    window_ids
}

/// Global Escape key hook for aborting computer-use operations.
///
/// Uses `rdev` to listen for Escape key presses on a background thread.
/// When Escape is pressed, sets an atomic flag that callers can poll.
pub struct EscapeHook {
    abort_flag: Arc<AtomicBool>,
    _listener_thread: Option<std::thread::JoinHandle<()>>,
}

impl EscapeHook {
    pub fn register() -> Result<Self, Box<dyn std::error::Error>> {
        let abort_flag = Arc::new(AtomicBool::new(false));
        let flag_clone = Arc::clone(&abort_flag);

        let handle = std::thread::spawn(move || {
            let flag = flag_clone;
            let callback = move |event: rdev::Event| {
                if let rdev::EventType::KeyPress(rdev::Key::Escape) = event.event_type {
                    flag.store(true, Ordering::SeqCst);
                }
            };
            // rdev::listen blocks until an error occurs
            if let Err(e) = rdev::listen(callback) {
                eprintln!("EscapeHook listener error: {:?}", e);
            }
        });

        Ok(EscapeHook {
            abort_flag,
            _listener_thread: Some(handle),
        })
    }

    pub fn is_aborted(&self) -> bool {
        self.abort_flag.load(Ordering::SeqCst)
    }

    pub fn reset(&self) {
        self.abort_flag.store(false, Ordering::SeqCst);
    }
}
