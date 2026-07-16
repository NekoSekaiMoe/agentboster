use base64::{engine::general_purpose::STANDARD, Engine};
use image::imageops::FilterType;
use xcap::Monitor;

const DEFAULT_MAX_WIDTH: u32 = 1400;

pub struct ScreenshotResult {
    pub png_base64: String,
    pub native_size: (u32, u32),
    pub scaled_size: (u32, u32),
    pub scale_factor: f64,
}

pub fn capture_and_scale(
    max_width: Option<u32>,
) -> Result<ScreenshotResult, Box<dyn std::error::Error>> {
    let max_w = max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let monitors = Monitor::all()?;
    let monitor = monitors.first().ok_or("No monitors found")?;
    let frame = monitor.capture_image()?;
    let (w, h) = (frame.width(), frame.height());

    let (scaled, scaled_size) = if w > max_w {
        let ratio = max_w as f64 / w as f64;
        let new_h = (h as f64 * ratio) as u32;
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
    })
}
