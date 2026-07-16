use base64::{Engine, engine::general_purpose::STANDARD};
use image::imageops::FilterType;
use xcap::Monitor;

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
    let origin = (monitor.x(), monitor.y());
    let frame = monitor.capture_image()?;
    let (w, h) = (frame.width(), frame.height());

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
