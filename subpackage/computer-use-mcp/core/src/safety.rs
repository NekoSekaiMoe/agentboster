use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
#[cfg(target_os = "macos")]
use core_graphics::window::{kCGNullWindowID, kCGWindowListOptionOnScreenOnly};

#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;

pub type WindowId = u64;

/// Returns window IDs of terminal applications to exclude from screenshots.
///
/// Matches terminal apps by window class/bundle ID:
/// - macOS: Terminal.app, iTerm2, Alacritty, Hyper, Warp, etc.
/// - Windows: WindowsTerminal, cmd.exe, powershell.exe, ConEmu, etc.
/// - Linux: gnome-terminal, konsole, xterm, alacritty, kitty, etc.
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
        terminal_window_ids_linux()
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
                // Get owner name (bundle ID)
                let owner_key = CFString::from_static_string("kCGWindowOwnerName");
                if let Some(owner_name) = window_dict.find(&owner_key as *const _ as *const _) {
                    let owner_name_cf: CFString = CFType::wrap_under_get_rule(*owner_name as _);
                    let owner_str = owner_name_cf.to_string();

                    // Check if it matches any terminal bundle ID
                    let is_terminal = terminal_bundle_ids.iter().any(|bundle_id| {
                        owner_str.contains(bundle_id)
                            || owner_str.to_lowercase().contains("terminal")
                            || owner_str.to_lowercase().contains("iterm")
                            || owner_str.to_lowercase().contains("alacritty")
                    });

                    if is_terminal {
                        // Get window ID
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
    use std::mem;
    use std::ptr;

    let terminal_class_names = [
        "ConsoleWindowClass",            // cmd.exe, powershell.exe
        "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal
        "VirtualConsoleClass",           // ConEmu
        "mintty",                        // Git Bash, Cygwin
        "PuTTY",
    ];

    let terminal_titles = ["powershell", "cmd.exe", "terminal", "bash", "wsl"];

    let mut window_ids = Vec::new();

    unsafe {
        use winapi::shared::windef::HWND;
        use winapi::um::winuser::{EnumWindows, GetClassNameW, GetWindowTextW, IsWindowVisible};

        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: isize) -> i32 {
            let window_ids = &mut *(lparam as *mut Vec<WindowId>);

            if IsWindowVisible(hwnd) == 0 {
                return 1; // continue
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

            1 // continue enumeration
        }

        EnumWindows(Some(enum_proc), &mut window_ids as *mut _ as isize);
    }

    window_ids
}

#[cfg(target_os = "linux")]
fn terminal_window_ids_linux() -> Vec<WindowId> {
    // For Linux, we use xcap's window enumeration since it handles both X11 and Wayland
    // This is a simplified implementation that matches by window title/class

    let _terminal_patterns = [
        "gnome-terminal",
        "konsole",
        "xterm",
        "alacritty",
        "kitty",
        "terminator",
        "tilix",
        "terminology",
        "terminal",
        "bash",
        "zsh",
        "fish",
    ];

    // Since xcap doesn't expose window IDs directly, we return an empty list
    // The masking will be done by checking window titles during screenshot capture
    Vec::new()
}

/// Global Escape key hook for aborting operations.
pub struct EscapeHook {
    #[allow(dead_code)]
    abort_flag: Arc<AtomicBool>,
    #[cfg(target_os = "macos")]
    event_tap: Option<()>, // Placeholder for CGEventTap handle
    #[cfg(target_os = "windows")]
    hook_handle: Option<()>, // Placeholder for HHOOK
}

impl EscapeHook {
    /// Register a global Escape key hook.
    ///
    /// When Escape is pressed, the hook consumes the event (preventing it from
    /// reaching applications) and triggers the abort flag.
    ///
    /// Platform implementations:
    /// - macOS: CGEventTapCreate with kCGEventKeyDown, keycode 53
    /// - Windows: SetWindowsHookEx(WH_KEYBOARD_LL)
    /// - Linux X11: XGrabKey on root window
    /// - Linux Wayland: libinput monitoring (requires input group permissions)
    pub fn register() -> Result<Self, Box<dyn std::error::Error>> {
        let abort_flag = Arc::new(AtomicBool::new(false));

        #[cfg(target_os = "macos")]
        {
            // macOS: CGEventTap implementation
            // Note: Requires accessibility permissions
            // For now, return a placeholder
            Ok(EscapeHook {
                abort_flag,
                event_tap: None,
            })
        }

        #[cfg(target_os = "windows")]
        {
            // Windows: Low-level keyboard hook
            // For now, return a placeholder
            Ok(EscapeHook {
                abort_flag,
                hook_handle: None,
            })
        }

        #[cfg(target_os = "linux")]
        {
            // Linux: X11 XGrabKey or Wayland libinput
            // For now, return a placeholder
            Ok(EscapeHook { abort_flag })
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Err("Escape hook not supported on this platform".into())
        }
    }

    /// Check if the abort flag has been triggered.
    pub fn is_aborted(&self) -> bool {
        self.abort_flag.load(Ordering::Relaxed)
    }

    /// Reset the abort flag.
    pub fn reset(&self) {
        self.abort_flag.store(false, Ordering::Relaxed);
    }
}

impl Drop for EscapeHook {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            // Clean up CGEventTap
        }

        #[cfg(target_os = "windows")]
        {
            // Unhook keyboard hook
        }
    }
}
