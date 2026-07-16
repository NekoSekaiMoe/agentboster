//! Accessibility tree reading — unified cross-platform interface.
//!
//! Each platform (Windows/macOS/Linux) has its own native accessibility
//! API. This module provides a single `AxNode` shape and per-platform
//! backends that populate it.

use serde::Serialize;

/// Unified accessibility node returned by all platform backends.
///
/// Coordinates are in physical screen pixels with origin at the primary
/// monitor's top-left.
#[derive(Debug, Clone, Serialize)]
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

/// Get the accessibility node at the given screen coordinates.
///
/// `max_depth` limits recursion depth (default 3, capped at 5).
pub fn get_ax_at_point(x: i32, y: i32, max_depth: Option<u32>) -> Result<AxNode, String> {
    let _depth = max_depth.unwrap_or(3).min(5);
    #[cfg(target_os = "windows")]
    return windows::get_ax_at_point(x, y, _depth);

    #[cfg(target_os = "macos")]
    return macos::get_ax_at_point(x, y, _depth);

    #[cfg(target_os = "linux")]
    return linux::get_ax_at_point(x, y, _depth);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Accessibility not supported on this platform".into())
}

/// Get the currently focused accessibility element.
///
/// `max_depth` limits recursion depth (default 3, capped at 5).
pub fn get_focused_ax(max_depth: Option<u32>) -> Result<AxNode, String> {
    let _depth = max_depth.unwrap_or(3).min(5);
    #[cfg(target_os = "windows")]
    return windows::get_focused_ax(_depth);

    #[cfg(target_os = "macos")]
    return macos::get_focused_ax(_depth);

    #[cfg(target_os = "linux")]
    return linux::get_focused_ax(_depth);

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Accessibility not supported on this platform".into())
}

// ────────────────────────────────────────────────────────────────────
// Windows (UIAutomation)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows {
    use super::AxNode;
    use uiautomation::{UIAutomation, UIElement};

    pub fn get_ax_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let uia = UIAutomation::new().map_err(|e| e.to_string())?;
        let elem = uia
            .element_from_point(uiautomation::types::Point::new(x, y))
            .map_err(|e| e.to_string())?;
        build_node(&elem, max_depth)
    }

    pub fn get_focused_ax(max_depth: u32) -> Result<AxNode, String> {
        let uia = UIAutomation::new().map_err(|e| e.to_string())?;
        let elem = uia.get_focused_element().map_err(|e| e.to_string())?;
        build_node(&elem, max_depth)
    }

    fn build_node(elem: &UIElement, depth_remaining: u32) -> Result<AxNode, String> {
        let role = elem
            .get_control_type()
            .ok()
            .and_then(|ct| ct.name().ok())
            .unwrap_or_default();
        let name = elem.get_name().ok().unwrap_or_default();
        let value = elem.get_value().ok();
        let rect = elem.get_bounding_rectangle().ok().unwrap_or_default();
        let enabled = elem.get_is_enabled().ok().unwrap_or(false);
        let focused = elem.get_has_keyboard_focus().ok().unwrap_or(false);

        let children = if depth_remaining == 0 {
            Vec::new()
        } else {
            elem.get_children()
                .ok()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|c| build_node(&c, depth_remaining - 1).ok())
                .collect()
        };

        Ok(AxNode {
            role,
            name,
            value,
            x: rect.get_left(),
            y: rect.get_top(),
            w: rect.get_width(),
            h: rect.get_height(),
            enabled,
            focused,
            children,
        })
    }
}

// ────────────────────────────────────────────────────────────────────
// macOS (Accessibility C API via accessibility-sys)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::AxNode;
    use accessibility_sys::{
        AXUIElementCopyAttributeValue, AXUIElementCopyElementAtPosition,
        AXUIElementCreateSystemWide, AXValueGetValue, kAXValueTypeCGPoint, kAXValueTypeCGSize,
    };
    use core_foundation::{
        array::CFArray,
        base::{CFRelease, CFType, TCFType},
        boolean::CFBoolean,
        string::CFString,
    };
    use core_graphics::geometry::{CGPoint, CGSize};
    use std::ffi::c_void;
    use std::ptr;

    pub fn get_ax_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        unsafe {
            let system_wide = AXUIElementCreateSystemWide();
            let mut elem = ptr::null_mut();
            let result =
                AXUIElementCopyElementAtPosition(system_wide, x as f64, y as f64, &mut elem);
            CFRelease(system_wide as *const c_void);
            if result != 0 || elem.is_null() {
                return Err(format!(
                    "AXUIElementCopyElementAtPosition failed: {}",
                    result
                ));
            }
            let node = build_node(elem, max_depth);
            CFRelease(elem as *const c_void);
            node
        }
    }

    pub fn get_focused_ax(max_depth: u32) -> Result<AxNode, String> {
        unsafe {
            let system_wide = AXUIElementCreateSystemWide();
            let focused_attr = CFString::new("AXFocusedUIElement");
            let mut value = ptr::null_mut();
            let result = AXUIElementCopyAttributeValue(
                system_wide,
                focused_attr.as_concrete_TypeRef(),
                &mut value,
            );
            CFRelease(system_wide as *const c_void);
            if result != 0 || value.is_null() {
                return Err(format!(
                    "AXUIElementCopyAttributeValue(AXFocusedUIElement) failed: {}",
                    result
                ));
            }
            let node = build_node(value as *mut _, max_depth);
            CFRelease(value);
            node
        }
    }

    unsafe fn build_node(elem: *mut c_void, depth_remaining: u32) -> Result<AxNode, String> {
        fn get_string_attr(elem: *mut c_void, attr: &str) -> String {
            unsafe {
                let cf_attr = CFString::new(attr);
                let mut value = ptr::null_mut();
                if AXUIElementCopyAttributeValue(elem, cf_attr.as_concrete_TypeRef(), &mut value)
                    == 0
                    && !value.is_null()
                {
                    let cf_val = CFType::wrap_under_create_rule(value);
                    if let Some(s) = cf_val.downcast::<CFString>() {
                        return s.to_string();
                    }
                }
                String::new()
            }
        }

        fn get_bool_attr(elem: *mut c_void, attr: &str) -> bool {
            unsafe {
                let cf_attr = CFString::new(attr);
                let mut value = ptr::null_mut();
                if AXUIElementCopyAttributeValue(elem, cf_attr.as_concrete_TypeRef(), &mut value)
                    == 0
                    && !value.is_null()
                {
                    let cf_val = CFType::wrap_under_create_rule(value);
                    if let Some(b) = cf_val.downcast::<CFBoolean>() {
                        return bool::from(b);
                    }
                }
                false
            }
        }

        fn get_position(elem: *mut c_void) -> (i32, i32) {
            unsafe {
                let cf_attr = CFString::new("AXPosition");
                let mut value = ptr::null_mut();
                if AXUIElementCopyAttributeValue(elem, cf_attr.as_concrete_TypeRef(), &mut value)
                    == 0
                    && !value.is_null()
                {
                    let mut point = CGPoint::new(0.0, 0.0);
                    let ok = AXValueGetValue(
                        value as *mut _,
                        kAXValueTypeCGPoint,
                        &mut point as *mut _ as *mut _,
                    );
                    CFRelease(value);
                    if ok {
                        return (point.x as i32, point.y as i32);
                    }
                }
                (0, 0)
            }
        }

        fn get_size(elem: *mut c_void) -> (i32, i32) {
            unsafe {
                let cf_attr = CFString::new("AXSize");
                let mut value = ptr::null_mut();
                if AXUIElementCopyAttributeValue(elem, cf_attr.as_concrete_TypeRef(), &mut value)
                    == 0
                    && !value.is_null()
                {
                    let mut size = CGSize::new(0.0, 0.0);
                    let ok = AXValueGetValue(
                        value as *mut _,
                        kAXValueTypeCGSize,
                        &mut size as *mut _ as *mut _,
                    );
                    CFRelease(value);
                    if ok {
                        return (size.width as i32, size.height as i32);
                    }
                }
                (0, 0)
            }
        }

        fn get_children(elem: *mut c_void, depth: u32) -> Vec<AxNode> {
            if depth == 0 {
                return Vec::new();
            }
            unsafe {
                let cf_attr = CFString::new("AXChildren");
                let mut value = ptr::null_mut();
                if AXUIElementCopyAttributeValue(elem, cf_attr.as_concrete_TypeRef(), &mut value)
                    == 0
                    && !value.is_null()
                {
                    let cf_val = CFType::wrap_under_create_rule(value);
                    if let Some(arr) = cf_val.downcast::<CFArray>() {
                        return (0..arr.len())
                            .filter_map(|i| {
                                let child = arr.get(i);
                                build_node(child.as_void_ptr() as *mut _, depth - 1).ok()
                            })
                            .collect();
                    }
                }
                Vec::new()
            }
        }

        let role = get_string_attr(elem, "AXRole");
        let name = get_string_attr(elem, "AXTitle");
        let value = {
            let v = get_string_attr(elem, "AXValue");
            if v.is_empty() { None } else { Some(v) }
        };
        let (x, y) = get_position(elem);
        let (w, h) = get_size(elem);
        let enabled = get_bool_attr(elem, "AXEnabled");
        let focused = get_bool_attr(elem, "AXFocused");
        let children = get_children(elem, depth_remaining);

        Ok(AxNode {
            role,
            name,
            value,
            x,
            y,
            w,
            h,
            enabled,
            focused,
            children,
        })
    }
}

// ────────────────────────────────────────────────────────────────────
// Linux (AT-SPI over D-Bus via atspi crate)
// ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod linux {
    use super::AxNode;
    use atspi::{AccessibilityConnection, ComponentProxy, Role};
    use zbus::blocking::Connection;

    pub fn get_ax_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let conn = Connection::session().map_err(|e| e.to_string())?;
        let acc = AccessibilityConnection::new(&conn).map_err(|e| e.to_string())?;
        let desktop = acc.desktop(0).map_err(|e| e.to_string())?;

        find_at_point(&desktop, x, y, max_depth)
    }

    pub fn get_focused_ax(max_depth: u32) -> Result<AxNode, String> {
        let conn = Connection::session().map_err(|e| e.to_string())?;
        let acc = AccessibilityConnection::new(&conn).map_err(|e| e.to_string())?;
        let desktop = acc.desktop(0).map_err(|e| e.to_string())?;

        find_focused(&desktop, max_depth)
    }

    fn find_at_point(
        elem: &atspi::Accessible,
        x: i32,
        y: i32,
        depth: u32,
    ) -> Result<AxNode, String> {
        let contains_point = if let Ok(component) = ComponentProxy::from(elem.clone()) {
            if let Ok(extents) = component.extents(atspi::CoordType::Screen) {
                x >= extents.x()
                    && x < extents.x() + extents.width()
                    && y >= extents.y()
                    && y < extents.y() + extents.height()
            } else {
                true
            }
        } else {
            true
        };

        if !contains_point {
            return Err("No element at point".into());
        }

        if depth > 0 {
            if let Ok(child_count) = elem.child_count() {
                for i in 0..child_count {
                    if let Ok(child) = elem.child_at_index(i) {
                        if let Ok(node) = find_at_point(&child, x, y, depth - 1) {
                            if !node.role.is_empty() {
                                return Ok(node);
                            }
                        }
                    }
                }
            }
        }

        build_node(elem, depth)
    }

    fn find_focused(elem: &atspi::Accessible, depth: u32) -> Result<AxNode, String> {
        if let Ok(state_set) = elem.state_set() {
            if state_set.contains(atspi::State::Focused) {
                return build_node(elem, depth);
            }
        }
        if depth > 0 {
            if let Ok(child_count) = elem.child_count() {
                for i in 0..child_count {
                    if let Ok(child) = elem.child_at_index(i) {
                        if let Ok(node) = find_focused(&child, depth - 1) {
                            return Ok(node);
                        }
                    }
                }
            }
        }
        Err("No focused element".into())
    }

    fn build_node(elem: &atspi::Accessible, depth: u32) -> Result<AxNode, String> {
        let role = elem
            .role()
            .ok()
            .map(|r| format!("{:?}", r))
            .unwrap_or_default();
        let name = elem.name().ok().unwrap_or_default();
        let value = elem.description().ok();

        let (x, y, w, h) = if let Ok(component) = ComponentProxy::from(elem.clone()) {
            if let Ok(extents) = component.extents(atspi::CoordType::Screen) {
                (extents.x(), extents.y(), extents.width(), extents.height())
            } else {
                (0, 0, 0, 0)
            }
        } else {
            (0, 0, 0, 0)
        };

        let enabled = elem
            .state_set()
            .ok()
            .map(|s| s.contains(atspi::State::Enabled))
            .unwrap_or(false);
        let focused = elem
            .state_set()
            .ok()
            .map(|s| s.contains(atspi::State::Focused))
            .unwrap_or(false);

        let children = if depth == 0 {
            Vec::new()
        } else {
            (0..elem.child_count().unwrap_or(0))
                .filter_map(|i| elem.child_at_index(i).ok())
                .filter_map(|c| build_node(&c, depth - 1).ok())
                .collect()
        };

        Ok(AxNode {
            role,
            name,
            value,
            x,
            y,
            w,
            h,
            enabled,
            focused,
            children,
        })
    }
}
