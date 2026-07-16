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
    use atspi::proxy::accessible::AccessibleProxy;
    use atspi::proxy::component::ComponentProxy;
    use atspi::{AccessibilityConnection, CoordType, State};

    pub fn get_ax_at_point(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(get_ax_at_point_async(x, y, max_depth))
    }

    pub fn get_focused_ax(max_depth: u32) -> Result<AxNode, String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        rt.block_on(get_focused_ax_async(max_depth))
    }

    async fn get_ax_at_point_async(x: i32, y: i32, max_depth: u32) -> Result<AxNode, String> {
        let a11y = AccessibilityConnection::new()
            .await
            .map_err(|e| e.to_string())?;
        let conn = a11y.connection();
        let root = a11y
            .root_accessible_on_registry()
            .await
            .map_err(|e| e.to_string())?;
        find_at_point(conn, &root, x, y, max_depth).await
    }

    async fn get_focused_ax_async(max_depth: u32) -> Result<AxNode, String> {
        let a11y = AccessibilityConnection::new()
            .await
            .map_err(|e| e.to_string())?;
        let conn = a11y.connection();
        let root = a11y
            .root_accessible_on_registry()
            .await
            .map_err(|e| e.to_string())?;
        find_focused(conn, &root, max_depth).await
    }

    async fn child_accessible<'a>(
        conn: &'a zbus::Connection,
        parent: &AccessibleProxy<'_>,
        index: i32,
    ) -> Result<AccessibleProxy<'a>, String> {
        let obj_ref = parent
            .get_child_at_index(index)
            .await
            .map_err(|e| e.to_string())?;
        let name = obj_ref.name_as_str().ok_or("Null accessible reference")?;
        let path = obj_ref.path_as_str();
        AccessibleProxy::builder(conn)
            .destination(name)
            .map_err(|e| e.to_string())?
            .path(path)
            .map_err(|e| e.to_string())?
            .build()
            .await
            .map_err(|e| e.to_string())
    }

    async fn component_for<'a>(
        conn: &'a zbus::Connection,
        accessible: &AccessibleProxy<'_>,
    ) -> Option<ComponentProxy<'a>> {
        let dest = accessible.inner().destination().to_string();
        let path = accessible.inner().path().to_string();
        ComponentProxy::builder(conn)
            .destination(dest.as_str())
            .ok()?
            .path(path.as_str())
            .ok()?
            .build()
            .await
            .ok()
    }

    async fn find_at_point(
        conn: &zbus::Connection,
        elem: &AccessibleProxy<'_>,
        x: i32,
        y: i32,
        depth: u32,
    ) -> Result<AxNode, String> {
        let contains_point = if let Some(component) = component_for(conn, elem).await {
            match component.get_extents(CoordType::Screen).await {
                Ok((ex, ey, ew, eh)) => x >= ex && x < ex + ew && y >= ey && y < ey + eh,
                Err(_) => true,
            }
        } else {
            true
        };

        if !contains_point {
            return Err("No element at point".into());
        }

        if depth > 0 {
            let child_count = elem.child_count().await.unwrap_or(0);
            for i in 0..child_count {
                if let Ok(child) = child_accessible(conn, elem, i).await {
                    if let Ok(node) = Box::pin(find_at_point(conn, &child, x, y, depth - 1)).await {
                        if !node.role.is_empty() {
                            return Ok(node);
                        }
                    }
                }
            }
        }

        build_node(conn, elem, depth).await
    }

    async fn find_focused(
        conn: &zbus::Connection,
        elem: &AccessibleProxy<'_>,
        display_depth: u32,
    ) -> Result<AxNode, String> {
        const MAX_SEARCH_DEPTH: u32 = 50;
        search_focused(conn, elem, display_depth, MAX_SEARCH_DEPTH).await
    }

    async fn search_focused(
        conn: &zbus::Connection,
        elem: &AccessibleProxy<'_>,
        display_depth: u32,
        search_depth: u32,
    ) -> Result<AxNode, String> {
        if let Ok(state_set) = elem.get_state().await {
            if state_set.contains(State::Focused) {
                return build_node(conn, elem, display_depth).await;
            }
        }
        if search_depth > 0 {
            let child_count = elem.child_count().await.unwrap_or(0);
            for i in 0..child_count {
                if let Ok(child) = child_accessible(conn, elem, i).await {
                    if let Ok(node) = Box::pin(search_focused(
                        conn,
                        &child,
                        display_depth,
                        search_depth - 1,
                    ))
                    .await
                    {
                        return Ok(node);
                    }
                }
            }
        }
        Err("No focused element".into())
    }

    async fn build_node(
        conn: &zbus::Connection,
        elem: &AccessibleProxy<'_>,
        depth: u32,
    ) -> Result<AxNode, String> {
        let role = elem
            .get_role()
            .await
            .ok()
            .map(|r| format!("{r:?}"))
            .unwrap_or_default();
        let name = elem.name().await.ok().unwrap_or_default();
        let value = elem.description().await.ok();

        let (x, y, w, h) = if let Some(component) = component_for(conn, elem).await {
            component
                .get_extents(CoordType::Screen)
                .await
                .unwrap_or((0, 0, 0, 0))
        } else {
            (0, 0, 0, 0)
        };

        let state_set = elem.get_state().await.ok();
        let enabled = state_set
            .as_ref()
            .map(|s| s.contains(State::Enabled))
            .unwrap_or(false);
        let focused = state_set
            .as_ref()
            .map(|s| s.contains(State::Focused))
            .unwrap_or(false);

        let mut children = Vec::new();
        if depth > 0 {
            let child_count = elem.child_count().await.unwrap_or(0);
            for i in 0..child_count {
                if let Ok(child) = child_accessible(conn, elem, i).await {
                    if let Ok(node) = build_node(conn, &child, depth - 1).await {
                        children.push(node);
                    }
                }
            }
        }

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
