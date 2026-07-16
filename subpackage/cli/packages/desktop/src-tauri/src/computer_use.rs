//! Computer-use Tauri commands — thin wrappers over `computer-use-core`.
//!
//! Screenshot, input injection, and key parsing delegate to the shared
//! `computer_use_core` crate. Platform-specific accessibility backends
//! remain here because they depend on Tauri's async runtime model
//! (`spawn_blocking` for macOS, native async for Linux).

use computer_use_core::input::parse_key;
use enigo::{Keyboard, Mouse};
use serde::Serialize;

/// Unified AX node produced by every platform backend.
pub use computer_use_core::coord::CoordMapper;

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
// Screenshots — delegates to computer_use_core::screenshot
// ────────────────────────────────────────────────────────────────────

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
// Input injection — delegates to enigo, key parsing from core
// ────────────────────────────────────────────────────────────────────

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

/// Key parsing now delegates to `computer_use_core::input::parse_key`.
#[tauri::command]
pub async fn key_event(key: String, direction: String) -> Result<(), String> {
    let k = parse_key(&key).map_err(|e| e.to_string())?;
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

// ────────────────────────────────────────────────────────────────────
// Accessibility tree (per-platform) — kept in Desktop due to
// Tauri runtime coupling (spawn_blocking, tokio async)
// ────────────────────────────────────────────────────────────────────

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
    use core_foundation::string::CFString;
    use core_foundation::ConcreteCFType;
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }

    fn is_trusted() -> bool {
        unsafe { accessibility_sys::AXIsProcessTrusted() }
    }

    pub fn node_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        if !is_trusted() {
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
        if !is_trusted() {
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
                .map(|c| {
                    let node = convert(c, depth_remaining - 1);
                    CFRelease(c as *const c_void);
                    node
                })
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
        let cftype = core_foundation::base::CFType::wrap_under_get_rule(value);
        cftype.downcast_into::<CFString>().map(|s| s.to_string())
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
        let cftype = core_foundation::base::CFType::wrap_under_get_rule(value);
        cftype.downcast_into::<CFBoolean>().map(bool::from)
    }

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

    pub async fn node_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let _ = (x, y, max_depth);
        Err("Linux AT-SPI backend is wired but not yet implemented".into())
    }

    pub async fn focused_node(max_depth: u32) -> Result<AxNode, String> {
        let _ = max_depth;
        Err("Linux AT-SPI backend is wired but not yet implemented".into())
    }
}
