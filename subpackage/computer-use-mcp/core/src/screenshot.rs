use base64::{Engine, engine::general_purpose::STANDARD};
use image::ImageFormat;
use image::imageops::FilterType;
use xcap::Monitor;

use crate::safety::terminal_window_ids;

const DEFAULT_MAX_WIDTH: u32 = 1400;

/// Output format for screenshots. PNG is lossless; JPEG is ~5-10x smaller
/// at quality 80 with negligible vision-model recognition loss. Default
/// is JPEG to keep per-turn vision input cost and upload latency low.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenshotFormat {
    Png,
    Jpeg,
}

impl ScreenshotFormat {
    /// Parse a format string ("png" | "jpeg"); unknown values fall back
    /// to JPEG, the cost-effective default.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "png" => ScreenshotFormat::Png,
            _ => ScreenshotFormat::Jpeg,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ScreenshotFormat::Png => "image/png",
            ScreenshotFormat::Jpeg => "image/jpeg",
        }
    }

    pub fn image_format(self) -> ImageFormat {
        match self {
            ScreenshotFormat::Png => ImageFormat::Png,
            ScreenshotFormat::Jpeg => ImageFormat::Jpeg,
        }
    }
}

/// Clamp JPEG quality to the valid 1..=100 range; PNG ignores it.
pub fn clamp_quality(q: Option<i32>) -> u8 {
    match q {
        Some(v) if (1..=100).contains(&v) => v as u8,
        _ => 80,
    }
}

pub struct ScreenshotResult {
    /// Base64-encoded image bytes (PNG or JPEG depending on `format`).
    pub image_base64: String,
    pub format: ScreenshotFormat,
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
    format: ScreenshotFormat,
    quality: u8,
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

    if exclude_terminals.unwrap_or(true) {
        frame = mask_terminal_windows(frame, origin)?;
    }

    let (scaled, scaled_size) = if w > max_w {
        let ratio = max_w as f64 / w as f64;
        let new_h = ((h as f64 * ratio) as u32).max(1);
        let resized = image::imageops::resize(&frame, max_w, new_h, FilterType::Lanczos3);
        (image::DynamicImage::ImageRgba8(resized), (max_w, new_h))
    } else {
        (image::DynamicImage::ImageRgba8(frame), (w, h))
    };

    let mut bytes = Vec::new();
    match format {
        ScreenshotFormat::Png => {
            scaled.write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )?;
        }
        ScreenshotFormat::Jpeg => {
            // JPEG has no alpha channel — flatten to RGB over a black
            // background (matches the terminal-mask convention: masked
            // regions are already opaque black, so this is a no-op for
            // them; for genuine translucent UI pixels the loss is
            // imperceptible at q80).
            let rgb = image::DynamicImage::ImageRgba8(scaled.to_rgba8()).to_rgb8();
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
            encoder.encode_image(&image::DynamicImage::ImageRgb8(rgb))?;
        }
    }

    Ok(ScreenshotResult {
        image_base64: STANDARD.encode(&bytes),
        format,
        native_size: (w, h),
        scaled_size,
        scale_factor: w as f64 / scaled_size.0 as f64,
        monitor_origin: origin,
        monitor_index: selected_index,
    })
}

fn mask_terminal_windows(
    mut frame: image::RgbaImage,
    monitor_origin: (i32, i32),
) -> Result<image::RgbaImage, Box<dyn std::error::Error>> {
    let terminal_ids = terminal_window_ids();

    #[cfg(target_os = "macos")]
    if !terminal_ids.is_empty() {
        use core_foundation::array::CFArray;
        use core_foundation::base::{CFType, TCFType};
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::number::CFNumber;
        use core_foundation::string::CFString;
        use core_graphics::window::{kCGNullWindowID, kCGWindowListOptionOnScreenOnly};
        use std::ffi::c_void;

        let (monitor_x, monitor_y) = monitor_origin;

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
                        let id_key = CFString::from_static_string("kCGWindowNumber");
                        if let Some(window_id) =
                            window_dict.find(id_key.as_concrete_TypeRef() as *const c_void)
                        {
                            let id_cf = CFType::wrap_under_get_rule(*window_id as _);
                            let id = id_cf.downcast::<CFNumber>().and_then(|n| n.to_i64());
                            if let Some(id) = id {
                                if terminal_ids.contains(&(id as u64)) {
                                    let bounds_key =
                                        CFString::from_static_string("kCGWindowBounds");
                                    if let Some(bounds_dict) = window_dict
                                        .find(bounds_key.as_concrete_TypeRef() as *const c_void)
                                    {
                                        let bounds_cf =
                                            CFType::wrap_under_get_rule(*bounds_dict as _);

                                        if let Some(bounds_cf) =
                                            bounds_cf.downcast::<CFDictionary>()
                                        {
                                            let x_key = CFString::from_static_string("X");
                                            let y_key = CFString::from_static_string("Y");
                                            let w_key = CFString::from_static_string("Width");
                                            let h_key = CFString::from_static_string("Height");

                                            let get_i64 = |key: &CFString| -> Option<i64> {
                                                let val =
                                                    bounds_cf
                                                        .find(key.as_concrete_TypeRef()
                                                            as *const c_void)?;
                                                let num = CFType::wrap_under_get_rule(*val as _);
                                                num.downcast::<CFNumber>()?.to_i64()
                                            };

                                            if let (Some(x), Some(y), Some(w), Some(h)) = (
                                                get_i64(&x_key),
                                                get_i64(&y_key),
                                                get_i64(&w_key),
                                                get_i64(&h_key),
                                            ) {
                                                // Compute intersection of window rect with current monitor
                                                let win_left = x as i32;
                                                let win_top = y as i32;
                                                let win_right = win_left + w as i32;
                                                let win_bottom = win_top + h as i32;
                                                let mon_left = monitor_x;
                                                let mon_top = monitor_y;
                                                let mon_right = monitor_x + frame.width() as i32;
                                                let mon_bottom = monitor_y + frame.height() as i32;

                                                let ix_left = win_left.max(mon_left);
                                                let iy_top = win_top.max(mon_top);
                                                let ix_right = win_right.min(mon_right);
                                                let iy_bottom = win_bottom.min(mon_bottom);

                                                if ix_left < ix_right && iy_top < iy_bottom {
                                                    let rx = (ix_left - monitor_x) as u32;
                                                    let ry = (iy_top - monitor_y) as u32;
                                                    let rw = (ix_right - ix_left) as u32;
                                                    let rh = (iy_bottom - iy_top) as u32;
                                                    draw_black_rect(&mut frame, rx, ry, rw, rh);
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
    }

    #[cfg(target_os = "windows")]
    if !terminal_ids.is_empty() {
        use winapi::shared::windef::RECT;
        use winapi::um::winuser::GetWindowRect;

        let (monitor_x, monitor_y) = monitor_origin;
        for window_id in terminal_ids {
            unsafe {
                let hwnd = window_id as winapi::shared::windef::HWND;
                let mut rect: RECT = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut rect) != 0 {
                    // Compute intersection of window rect with current monitor
                    let win_right = rect.right;
                    let win_bottom = rect.bottom;
                    let mon_right = monitor_x + frame.width() as i32;
                    let mon_bottom = monitor_y + frame.height() as i32;

                    let ix_left = rect.left.max(monitor_x);
                    let iy_top = rect.top.max(monitor_y);
                    let ix_right = win_right.min(mon_right);
                    let iy_bottom = win_bottom.min(mon_bottom);

                    if ix_left < ix_right && iy_top < iy_bottom {
                        let rx = (ix_left - monitor_x) as u32;
                        let ry = (iy_top - monitor_y) as u32;
                        let w = (ix_right - ix_left) as u32;
                        let h = (iy_bottom - iy_top) as u32;
                        draw_black_rect(&mut frame, rx, ry, w, h);
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Official Anthropic/claude-code do NOT mask terminal windows on Linux.
        // Conservative fallback: mask bottom 1/3 of screen where terminals typically sit.
        // Controlled by the allow_terminal_edit setting — when allow_terminal_edit=false
        // the caller passes exclude_terminals=true and we reach this code path.
        let _ = terminal_ids;
        let _ = monitor_origin;
        let fh = frame.height();
        let fw = frame.width();
        let mask_y = (fh * 2) / 3;
        draw_black_rect(&mut frame, 0, mask_y, fw, fh - mask_y);
    }

    Ok(frame)
}

fn draw_black_rect(frame: &mut image::RgbaImage, x: u32, y: u32, w: u32, h: u32) {
    let (img_w, img_h) = (frame.width(), frame.height());
    let black = image::Rgba([0, 0, 0, 255]);

    for py in y..y.saturating_add(h).min(img_h) {
        for px in x..x.saturating_add(w).min(img_w) {
            frame.put_pixel(px, py, black);
        }
    }
}
