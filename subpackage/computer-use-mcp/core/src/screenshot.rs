use base64::{Engine, engine::general_purpose::STANDARD};
use image::imageops::FilterType;
use xcap::Monitor;

use crate::safety::terminal_window_ids;

const DEFAULT_MAX_WIDTH: u32 = 1400;

pub struct ScreenshotResult {
    pub png_base64: String,
    pub native_size: (u32, u32),
    pub scaled_size: (u32, u32),
    pub scale_factor: f64,
    pub monitor_origin: (i32, i32),
    pub monitor_index: usize,
}

pub fn capture_and_scale(
    max_width: Option<u32>,
    monitor_index: Option<usize>,
    exclude_terminals: Option<bool>,
) -> Result<ScreenshotResult, Box<dyn std::error::Error>> {
    let max_w = max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let monitors = Monitor::all()?;
    if monitors.is_empty() {
        return Err("No monitors found".into());
    }
    let (selected_index, monitor) = match monitor_index {
        Some(idx) if idx < monitors.len() => (idx, &monitors[idx]),
        Some(idx) => {
            return Err(format!(
                "monitor_index {} out of range (available: 0..{})",
                idx,
                monitors.len()
            )
            .into());
        }
        None => {
            let idx = monitors
                .iter()
                .position(|m| m.is_primary().unwrap_or(false))
                .unwrap_or(0);
            (idx, &monitors[idx])
        }
    };
    let origin = (monitor.x()?, monitor.y()?);
    let mut frame = monitor.capture_image()?;
    let (w, h) = (frame.width(), frame.height());

    // Exclude terminal windows from screenshot for privacy
    if exclude_terminals.unwrap_or(true) {
        frame = mask_terminal_windows(frame)?;
    }

    let (scaled, scaled_size) = if w > max_w {
        let ratio = max_w as f64 / w as f64;
        let new_h = ((h as f64 * ratio) as u32).max(1);
        let resized = image::imageops::resize(&frame, max_w, new_h, FilterType::Lanczos3);
        (image::DynamicImage::ImageRgba8(resized), (max_w, new_h))
    } else {
        (image::DynamicImage::ImageRgba8(frame), (w, h))
    };

    let mut png_bytes = Vec::new();
    scaled.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )?;

    Ok(ScreenshotResult {
        png_base64: STANDARD.encode(&png_bytes),
        native_size: (w, h),
        scaled_size,
        scale_factor: w as f64 / scaled_size.0 as f64,
        monitor_origin: origin,
        monitor_index: selected_index,
    })
}

/// Mask terminal windows by drawing black rectangles over them.
fn mask_terminal_windows(
    frame: image::RgbaImage,
) -> Result<image::RgbaImage, Box<dyn std::error::Error>> {
    let terminal_ids = terminal_window_ids();

    if terminal_ids.is_empty() {
        return Ok(frame);
    }

    // Get window bounds for each terminal window and mask them
    #[cfg(target_os = "macos")]
    {
        use core_foundation::array::CFArray;
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_graphics::window::{kCGNullWindowID, kCGWindowListOptionOnScreenOnly};

        unsafe {
            let window_list = core_graphics::window::CGWindowListCopyWindowInfo(
                kCGWindowListOptionOnScreenOnly,
                kCGNullWindowID,
            );

            if !window_list.is_null() {
                let windows: CFArray<CFDictionary> =
                    CFArray::wrap_under_create_rule(window_list as _);

                for i in 0..windows.len() {
                    if let Some(window_dict) = windows.get(i) {
                        // Get window ID
                        let id_key = CFString::from_static_string("kCGWindowNumber");
                        if let Some(window_id) = window_dict.find(&id_key as *const _ as *const _) {
                            let id_cf: CFNumber = CFType::wrap_under_get_rule(*window_id as _);
                            if let Some(id) = id_cf.to_i64() {
                                if terminal_ids.contains(&(id as u64)) {
                                    // Get window bounds
                                    let bounds_key =
                                        CFString::from_static_string("kCGWindowBounds");
                                    if let Some(bounds_dict) =
                                        window_dict.find(&bounds_key as *const _ as *const _)
                                    {
                                        let bounds_cf: CFDictionary =
                                            CFType::wrap_under_get_rule(*bounds_dict as _);

                                        let x_key = CFString::from_static_string("X");
                                        let y_key = CFString::from_static_string("Y");
                                        let w_key = CFString::from_static_string("Width");
                                        let h_key = CFString::from_static_string("Height");

                                        if let (Some(x), Some(y), Some(w), Some(h)) = (
                                            bounds_cf.find(&x_key as *const _ as *const _),
                                            bounds_cf.find(&y_key as *const _ as *const _),
                                            bounds_cf.find(&w_key as *const _ as *const _),
                                            bounds_cf.find(&h_key as *const _ as *const _),
                                        ) {
                                            let x_num: CFNumber =
                                                CFType::wrap_under_get_rule(*x as _);
                                            let y_num: CFNumber =
                                                CFType::wrap_under_get_rule(*y as _);
                                            let w_num: CFNumber =
                                                CFType::wrap_under_get_rule(*w as _);
                                            let h_num: CFNumber =
                                                CFType::wrap_under_get_rule(*h as _);

                                            if let (Some(x), Some(y), Some(w), Some(h)) = (
                                                x_num.to_i64(),
                                                y_num.to_i64(),
                                                w_num.to_i64(),
                                                h_num.to_i64(),
                                            ) {
                                                // Draw black rectangle over terminal window
                                                draw_black_rect(
                                                    &mut frame, x as u32, y as u32, w as u32,
                                                    h as u32,
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use winapi::shared::windef::RECT;
        use winapi::um::winuser::GetWindowRect;

        for window_id in terminal_ids {
            unsafe {
                let hwnd = window_id as winapi::shared::windef::HWND;
                let mut rect: RECT = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rect) != 0 {
                    let x = rect.left as u32;
                    let y = rect.top as u32;
                    let w = (rect.right - rect.left) as u32;
                    let h = (rect.bottom - rect.top) as u32;
                    draw_black_rect(&mut frame, x, y, w, h);
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Linux: window bounds detection is complex due to X11/Wayland differences
        // For now, skip masking on Linux (terminal_window_ids_linux returns empty vec anyway)
        let _ = terminal_ids;
    }

    Ok(frame)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn draw_black_rect(frame: &mut image::RgbaImage, x: u32, y: u32, w: u32, h: u32) {
    let (img_w, img_h) = (frame.width(), frame.height());
    let black = image::Rgba([0, 0, 0, 255]);

    for py in y..y.saturating_add(h).min(img_h) {
        for px in x..x.saturating_add(w).min(img_w) {
            frame.put_pixel(px, py, black);
        }
    }
}
