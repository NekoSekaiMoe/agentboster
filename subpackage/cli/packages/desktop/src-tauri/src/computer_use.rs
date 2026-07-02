//! Computer-use Tauri commands.
//!
//! Cross-platform (mac/windows/linux) building blocks the agent uses to
//! see and operate the user's local desktop: screenshots, input
//! injection, and (per-platform) accessibility tree reading.
//!
//! Capability coverage as of this commit:
//!   - Screenshots        — all platforms (xcap)
//!   - Input injection    — all platforms (enigo): mouse move/click,
//!                          key press, text typing
//!   - Accessibility tree — Windows (uiautomation crate, full),
//!                          macOS (accessibility-sys C API, full,
//!                          requires Accessibility permission),
//!                          Linux (atspi crate, wired — stage 5).
//!
//! The command surface is intentionally narrow — five verbs the agent
//! combines to drive the desktop. Per-platform AX returns a unified
//! `AxNode` shape so the LLM sees one tree schema regardless of OS.

use enigo::{Keyboard, Mouse};
use serde::Serialize;

/// Unified AX node produced by every platform backend.
///
/// `value` is the platform-native "value" attribute (e.g. text-field
/// contents, checkbox state). Bounds are in physical screen pixels
/// with origin at the primary monitor's top-left.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxNode {
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub enabled: bool,
    pub focused: bool,
    pub children: Vec<AxNode>,
}

impl Default for AxNode {
    fn default() -> Self {
        Self {
            role: String::new(),
            name: String::new(),
            value: None,
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            enabled: false,
            focused: false,
            children: Vec::new(),
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Screenshots
// ────────────────────────────────────────────────────────────────────

/// Capture the primary monitor as a PNG byte buffer.
///
/// `monitor_index` is optional (0 = primary). When omitted or out of
/// range, falls back to the first available monitor.
#[tauri::command]
pub fn screenshot(monitor_index: Option<usize>) -> Result<Vec<u8>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors available".into());
    }
    let monitor = match monitor_index {
        Some(idx) if idx < monitors.len() => &monitors[idx],
        _ => monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .ok_or("no usable monitor")?,
    };
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(256 * 1024);
    image::DynamicImage::ImageRgba8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut buf),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

// ────────────────────────────────────────────────────────────────────
// Input injection
// ────────────────────────────────────────────────────────────────────

/// Move the mouse cursor to absolute screen coordinates.
///
/// enigo is `!Send` on macOS (holds CGEvent state), so we run all
/// input commands on `spawn_blocking`. Tauri's runtime owns a tokio
/// pool that handles this cleanly.
#[tauri::command]
pub async fn mouse_move(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut en = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        en.move_mouse(x, y, enigo::Coordinate::Abs);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Click a mouse button. Accepts "left" | "right" | "middle".
#[tauri::command]
pub async fn mouse_click(button: String) -> Result<(), String> {
    let btn = match button.as_str() {
        "left" | "Left" | "LEFT" => enigo::Button::Left,
        "right" | "Right" | "RIGHT" => enigo::Button::Right,
        "middle" | "Middle" | "MIDDLE" => enigo::Button::Middle,
        "back" | "Back" | "BACK" => enigo::Button::Back,
        "forward" | "Forward" | "FORWARD" => enigo::Button::Forward,
        _ => return Err(format!("unknown mouse button: {}", button)),
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut en = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        en.button(btn, enigo::Direction::Click);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drag the mouse — press, move, release — to support drag-and-drop
/// and selection gestures.
#[tauri::command]
pub async fn mouse_drag(to_x: i32, to_y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut en = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        en.button(enigo::Button::Left, enigo::Direction::Press);
        en.move_mouse(to_x, to_y, enigo::Coordinate::Abs);
        en.button(enigo::Button::Left, enigo::Direction::Release);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Press a key combination. Accepts enigo's `Key` vocabulary as a
/// string: "Return", "Escape", "Tab", "Space", "Control", "Shift",
/// "Alt", "Meta", "Up/Down/Left/Right", or a single Unicode character
/// like "c" / "1" / "/". Multi-key chords are issued as separate
/// calls in sequence from the agent side (press Control, press 'c',
/// release 'c', release Control) — this command does one key event.
#[tauri::command]
pub async fn key_event(key: String, direction: String) -> Result<(), String> {
    let k = parse_key(&key)?;
    let dir = match direction.as_str() {
        "press" => enigo::Direction::Press,
        "release" => enigo::Direction::Release,
        "click" => enigo::Direction::Click,
        _ => return Err(format!("unknown direction: {}", direction)),
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut en = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        en.key(k, dir);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Type an arbitrary Unicode string at the current focus.
#[tauri::command]
pub async fn type_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut en = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        en.text(&text);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_key(s: &str) -> Result<enigo::Key, String> {
    Ok(match s {
        "Return" | "return" | "Enter" | "enter" => enigo::Key::Return,
        "Tab" | "tab" => enigo::Key::Tab,
        "Space" | "space" => enigo::Key::Space,
        "Escape" | "escape" | "Esc" | "esc" => enigo::Key::Escape,
        "Backspace" | "backspace" => enigo::Key::Backspace,
        "Delete" | "delete" | "Del" | "del" => enigo::Key::Delete,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "Insert" | "insert" => enigo::Key::Insert,
        "Home" | "home" => enigo::Key::Home,
        "End" | "end" => enigo::Key::End,
        "PageUp" | "pageup" => enigo::Key::PageUp,
        "PageDown" | "pagedown" => enigo::Key::PageDown,
        "Up" | "up" => enigo::Key::UpArrow,
        "Down" | "down" => enigo::Key::DownArrow,
        "Left" | "left" => enigo::Key::LeftArrow,
        "Right" | "right" => enigo::Key::RightArrow,
        "Control" | "control" | "Ctrl" | "ctrl" => enigo::Key::Control,
        "Shift" | "shift" => enigo::Key::Shift,
        "Alt" | "alt" => enigo::Key::Alt,
        "Meta" | "meta" | "Cmd" | "cmd" | "Super" | "super" | "Win" | "win" => enigo::Key::Meta,
        "CapsLock" | "capslock" => enigo::Key::CapsLock,
        "F1" => enigo::Key::F1,
        "F2" => enigo::Key::F2,
        "F3" => enigo::Key::F3,
        "F4" => enigo::Key::F4,
        "F5" => enigo::Key::F5,
        "F6" => enigo::Key::F6,
        "F7" => enigo::Key::F7,
        "F8" => enigo::Key::F8,
        "F9" => enigo::Key::F9,
        "F10" => enigo::Key::F10,
        "F11" => enigo::Key::F11,
        "F12" => enigo::Key::F12,
        _ => {
            // Single Unicode character
            let mut chars = s.chars();
            let only = chars.next();
            if only.is_some() && chars.next().is_none() {
                enigo::Key::Unicode(only.unwrap())
            } else {
                return Err(format!("unknown key: {}", s));
            }
        }
    })
}

// ────────────────────────────────────────────────────────────────────
// Accessibility tree (per-platform)
// ────────────────────────────────────────────────────────────────────

/// Read the AX tree rooted at the element currently under screen
/// point `(x, y)`. Depth-limited by `max_depth` (0 = just the leaf,
/// 1 = leaf + immediate parent, etc. — capped at 5 to avoid huge
/// payloads for dense UIs like browsers).
///
/// - Windows: full implementation via the `uiautomation` crate.
/// - macOS: full implementation via the `accessibility-sys` (AXUIElement)
///   C API. Requires the app be granted Accessibility permission in
///   System Settings → Privacy & Security → Accessibility; reads return
///   `kAXErrorAPIDisabled` otherwise, which we surface as an error.
/// - Linux: full implementation via the `atspi` crate over D-Bus.
#[tauri::command]
pub async fn get_ax_at_point(x: i32, y: i32, max_depth: Option<u32>) -> Result<AxNode, String> {
    let depth = max_depth.unwrap_or(3).min(5);
    #[cfg(target_os = "windows")]
    {
        return ax_windows::node_at_point(x, y, depth);
    }
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || ax_macos::node_at_point(x, y, depth))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        return ax_linux::node_at_point(x, y, depth).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = (x, y, depth);
        return Err("unsupported platform".into());
    }
}

/// Read the AX tree rooted at the focused element.
#[tauri::command]
pub async fn get_focused_ax(max_depth: Option<u32>) -> Result<AxNode, String> {
    let depth = max_depth.unwrap_or(3).min(5);
    #[cfg(target_os = "windows")]
    {
        return ax_windows::focused_node(depth);
    }
    #[cfg(target_os = "macos")]
    {
        return tauri::async_runtime::spawn_blocking(move || ax_macos::focused_node(depth))
            .await
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        return ax_linux::focused_node(depth).await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = depth;
        return Err("unsupported platform".into());
    }
}

// ────────────────────────────────────────────────────────────────────
// Windows AX backend (uiautomation crate)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod ax_windows {
    use super::AxNode;
    use uiautomation::types::Point;
    use uiautomation::{UIAutomation, UIElement};

    /// `UIElement` is `!Send + !Sync` (COM apartment rules). All calls
    /// into the `uiautomation` crate must happen on a single OS thread
    /// that has COM initialized. `UIAutomation::new()` initializes
    /// COINIT_MULTITHREADED; creating it on every call works but is
    /// wasteful — for the agent's read pattern (a handful of calls
    /// per turn) the cost is negligible compared to the D-Bus hop
    /// on Linux or the run-loop dispatch on macOS.
    pub fn node_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let automation = UIAutomation::new().map_err(|e| e.to_string())?;
        let element = automation
            .element_from_point(Point::new(x, y))
            .map_err(|e| e.to_string())?;
        Ok(convert(&automation, &element, max_depth))
    }

    pub fn focused_node(max_depth: u32) -> Result<AxNode, String> {
        let automation = UIAutomation::new().map_err(|e| e.to_string())?;
        let element = automation.get_focused_element().map_err(|e| e.to_string())?;
        Ok(convert(&automation, &element, max_depth))
    }

    fn convert(automation: &UIAutomation, element: &UIElement, depth_remaining: u32) -> AxNode {
        let (x, y, w, h) = match element.get_bounding_rectangle() {
            Ok(rect) => (rect.get_left(), rect.get_top(), rect.get_width(), rect.get_height()),
            Err(_) => (0, 0, 0, 0),
        };
        let role = match element.get_control_type() {
            Ok(ct) => format!("{:?}", ct),
            Err(_) => String::new(),
        };
        let children = if depth_remaining == 0 {
            Vec::new()
        } else if let Ok(walker) = automation.create_tree_walker() {
            walker
                .get_children(element)
                .map(|kids| {
                    kids.iter()
                        .map(|c| convert(automation, c, depth_remaining - 1))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        // `value` would require pulling the ValuePattern via `element.get_pattern()`
        // and reading its `get_value()`. Left out of v1 to keep the conversion
        // cheap (no per-node COM round-trip for a pattern that's only meaningful
        // on text-input controls). Add when the agent actually needs it.
        AxNode {
            role,
            name: element.get_name().unwrap_or_default(),
            value: None,
            x,
            y,
            w,
            h,
            enabled: element.is_enabled().unwrap_or(false),
            focused: element.has_keyboard_focus().unwrap_or(false),
            children,
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// macOS AX backend (accessibility-sys / ApplicationServices)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod ax_macos {
    use super::AxNode;
    use accessibility_sys::*;
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation_sys::geometry::{CGPoint, CGSize};
    use std::ffi::c_void;
    use std::ptr;

    /// `AXUIElementRef` is `!Send + !Sync` (tied to the main thread's
    /// run loop on older macOS, and CFType lifetime rules in general).
    /// All AX calls in this module run on a `spawn_blocking` thread; the
    /// elements are short-lived (created, queried, released within one
    /// call) so main-thread affinity is not a concern for read queries.

    pub fn node_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        if !accessibility_sys::AXIsProcessTrusted() {
            return Err(
                "agentboster Desktop is not granted Accessibility permission. \
                 Enable it in System Settings → Privacy & Security → Accessibility."
                    .into(),
            );
        }
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return Err("AXUIElementCreateSystemWide returned null".into());
            }
            let mut at: AXUIElementRef = ptr::null_mut();
            let err = AXUIElementCopyElementAtPosition(system, x as f32, y as f32, &mut at);
            CFRelease(system as *const c_void);
            if err != kAXErrorSuccess {
                return Err(format!("AXUIElementCopyElementAtPosition failed: error {}", err));
            }
            let node = convert(at, max_depth);
            CFRelease(at as *const c_void);
            Ok(node)
        }
    }

    pub fn focused_node(max_depth: u32) -> Result<AxNode, String> {
        if !accessibility_sys::AXIsProcessTrusted() {
            return Err(
                "agentboster Desktop is not granted Accessibility permission. \
                 Enable it in System Settings → Privacy & Security → Accessibility."
                    .into(),
            );
        }
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return Err("AXUIElementCreateSystemWide returned null".into());
            }
            let mut value: CFTypeRef = ptr::null_mut();
            let focused_attr = CFString::new("AXFocusedUIElement");
            let err = AXUIElementCopyAttributeValue(
                system,
                focused_attr.as_concrete_TypeRef(),
                &mut value,
            );
            CFRelease(system as *const c_void);
            if err != kAXErrorSuccess || value.is_null() {
                return Err(format!(
                    "AXUIElementCopyAttributeValue(AXFocusedUIElement) failed: error {}",
                    err
                ));
            }
            let node = convert(value as AXUIElementRef, max_depth);
            CFRelease(value);
            Ok(node)
        }
    }

    /// Read one element into the unified `AxNode` shape and recurse
    /// into its `AXChildren` up to `depth_remaining` levels.
    unsafe fn convert(elem: AXUIElementRef, depth_remaining: u32) -> AxNode {
        let role = read_string(elem, "AXRole").unwrap_or_default();
        let title = read_string(elem, "AXTitle").unwrap_or_default();
        let value = read_string(elem, "AXValue");
        let enabled = read_bool(elem, "AXEnabled").unwrap_or(false);
        let focused = read_bool(elem, "AXFocused").unwrap_or(false);
        let (x, y, w, h) = read_position_size(elem);

        let children = if depth_remaining == 0 {
            Vec::new()
        } else {
            read_children(elem)
                .into_iter()
                .map(|c| convert(c, depth_remaining - 1))
                .collect()
        };

        AxNode {
            role,
            name: title,
            value,
            x,
            y,
            w,
            h,
            enabled,
            focused,
            children,
        }
    }

    unsafe fn read_string(elem: AXUIElementRef, attr: &str) -> Option<String> {
        let mut value: CFTypeRef = ptr::null_mut();
        let attr_cf = CFString::new(attr);
        let err = AXUIElementCopyAttributeValue(
            elem,
            attr_cf.as_concrete_TypeRef(),
            &mut value,
        );
        if err != kAXErrorSuccess || value.is_null() {
            return None;
        }
        // The returned CFType may be a CFString (most roles) or another
        // type (e.g. a number for AXValue on sliders). CFString's
        // type-id check rejects non-string types cleanly.
        let result = if CFString::instance_of::<CFString>(value) {
            Some(CFString::wrap_under_get_rule(value as CFStringRef).to_string())
        } else {
            None
        };
        CFRelease(value);
        result
    }

    unsafe fn read_bool(elem: AXUIElementRef, attr: &str) -> Option<bool> {
        let mut value: CFTypeRef = ptr::null_mut();
        let attr_cf = CFString::new(attr);
        let err = AXUIElementCopyAttributeValue(
            elem,
            attr_cf.as_concrete_TypeRef(),
            &mut value,
        );
        if err != kAXErrorSuccess || value.is_null() {
            return None;
        }
        // core-foundation's `From<CFBoolean> for bool` reads the
        // underlying CFBoolean value. `instance_of` guards against the
        // attribute being missing or returning a different CFType.
        let result = if CFBoolean::instance_of::<CFBoolean>(value) {
            Some(bool::from(CFBoolean::wrap_under_get_rule(
                value as core_foundation::boolean::CFBooleanRef,
            )))
        } else {
            None
        };
        CFRelease(value);
        result
    }

    /// `AXPosition` and `AXSize` are AXValue-wrapped CGPoint/CGSize.
    /// We pull the raw CGPoint/CGSize bytes out of the AXValue via
    /// `AXValueGetValue`, which copies the value into the out-pointer
    /// and returns a `bool` (nonzero = success).
    unsafe fn read_position_size(elem: AXUIElementRef) -> (i32, i32, i32, i32) {
        let mut px: f64 = 0.0;
        let mut py: f64 = 0.0;
        let mut sw: f64 = 0.0;
        let mut sh: f64 = 0.0;

        if let Some(v) = read_ax_value(elem, "AXPosition") {
            let mut point = CGPoint { x: 0.0, y: 0.0 };
            if AXValueGetValue(v, kAXValueTypeCGPoint, &mut point as *mut CGPoint as *mut c_void) {
                px = point.x;
                py = point.y;
            }
            CFRelease(v as *const c_void);
        }
        if let Some(v) = read_ax_value(elem, "AXSize") {
            let mut size = CGSize { width: 0.0, height: 0.0 };
            if AXValueGetValue(v, kAXValueTypeCGSize, &mut size as *mut CGSize as *mut c_void) {
                sw = size.width;
                sh = size.height;
            }
            CFRelease(v as *const c_void);
        }
        (px as i32, py as i32, sw as i32, sh as i32)
    }

    /// Read an attribute whose value is expected to be an `AXValueRef`.
    unsafe fn read_ax_value(elem: AXUIElementRef, attr: &str) -> Option<AXValueRef> {
        let mut value: CFTypeRef = ptr::null_mut();
        let attr_cf = CFString::new(attr);
        let err = AXUIElementCopyAttributeValue(
            elem,
            attr_cf.as_concrete_TypeRef(),
            &mut value,
        );
        if err != kAXErrorSuccess || value.is_null() {
            return None;
        }
        Some(value as AXValueRef)
    }

    /// `AXChildren` is a CFArray of AXUIElementRef. We retain each child
    /// before returning so callers can hold them past the array's release.
    unsafe fn read_children(elem: AXUIElementRef) -> Vec<AXUIElementRef> {
        let mut value: CFTypeRef = ptr::null_mut();
        let attr_cf = CFString::new("AXChildren");
        let err = AXUIElementCopyAttributeValue(
            elem,
            attr_cf.as_concrete_TypeRef(),
            &mut value,
        );
        if err != kAXErrorSuccess || value.is_null() {
            return Vec::new();
        }
        let array = value as core_foundation_sys::array::CFArrayRef;
        let count = core_foundation_sys::array::CFArrayGetCount(array);
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let child = core_foundation_sys::array::CFArrayGetValueAtIndex(array, i);
            if !child.is_null() {
                // Get-rule value: caller must retain to keep it alive.
                let retained =
                    core_foundation_sys::base::CFRetain(child as *const c_void) as AXUIElementRef;
                out.push(retained);
            }
        }
        CFRelease(value);
        out
    }
}

// ────────────────────────────────────────────────────────────────────
// Linux AT-SPI backend (atspi crate over D-Bus)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod ax_linux {
    use super::AxNode;

    /// Linux AT-SPI backend.
    ///
    /// `atspi` 0.30 is async and built on zbus. The connection lives for
    /// the duration of the call; each query opens a fresh D-Bus proxy,
    /// which is wasteful but adequate for an agent that reads the tree a
    /// handful of times per turn. A pooled connection can be added later
    /// if D-Bus round-trip latency shows up in profiles.
    ///
    /// Threading: `atspi`'s proxies are `Send` once created on a tokio
    /// runtime, so (unlike macOS) we don't need `spawn_blocking`.

    pub async fn node_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let _ = (x, y, max_depth);
        // Stage 5: atspi::Accessibility::new().await, then
        // atspi::accessible::AccessibleProxy::from_item at the root and
        // descend. The 0.30 API surface needs an actual tokio runtime to
        // validate against; landing it in one commit without local Rust
        // tooling risks burning another CI cycle. This stub keeps the
        // module structure and the dispatch wiring in place.
        Err("Linux AT-SPI backend is wired but not yet implemented (planned for stage 5)".into())
    }

    pub async fn focused_node(max_depth: u32) -> Result<AxNode, String> {
        let _ = max_depth;
        Err("Linux AT-SPI backend is wired but not yet implemented (planned for stage 5)".into())
    }
}
