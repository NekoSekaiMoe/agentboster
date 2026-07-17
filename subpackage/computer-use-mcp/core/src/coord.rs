pub struct CoordMapper {
    pub scale_factor: f64,
    pub origin: (i32, i32),
}

impl CoordMapper {
    pub fn new(scale_factor: f64) -> Self {
        Self {
            scale_factor,
            origin: (0, 0),
        }
    }

    pub fn new_with_origin(scale_factor: f64, origin: (i32, i32)) -> Self {
        Self {
            scale_factor,
            origin,
        }
    }

    pub fn to_native(&self, x: f64, y: f64) -> (f64, f64) {
        (
            x * self.scale_factor + self.origin.0 as f64,
            y * self.scale_factor + self.origin.1 as f64,
        )
    }

    pub fn to_scaled(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.origin.0 as f64) / self.scale_factor,
            (y - self.origin.1 as f64) / self.scale_factor,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_at_scale_1() {
        let mapper = CoordMapper::new(1.0);
        assert_eq!(mapper.to_native(100.0, 200.0), (100.0, 200.0));
        assert_eq!(mapper.to_scaled(100.0, 200.0), (100.0, 200.0));
    }

    #[test]
    fn retina_scale_roundtrip() {
        let factor = 3456.0 / 1400.0;
        let mapper = CoordMapper::new(factor);
        let (nx, ny) = mapper.to_native(700.0, 450.0);
        let (sx, sy) = mapper.to_scaled(nx, ny);
        assert!((sx - 700.0).abs() < 1e-10);
        assert!((sy - 450.0).abs() < 1e-10);
    }

    #[test]
    fn scale_factor_2x() {
        let mapper = CoordMapper::new(2.0);
        assert_eq!(mapper.to_native(50.0, 100.0), (100.0, 200.0));
        assert_eq!(mapper.to_scaled(100.0, 200.0), (50.0, 100.0));
    }

    #[test]
    fn zero_coords() {
        let mapper = CoordMapper::new(2.5);
        assert_eq!(mapper.to_native(0.0, 0.0), (0.0, 0.0));
        assert_eq!(mapper.to_scaled(0.0, 0.0), (0.0, 0.0));
    }

    #[test]
    fn with_origin_offset() {
        let mapper = CoordMapper::new_with_origin(2.0, (1920, 0));
        assert_eq!(mapper.to_native(50.0, 100.0), (2020.0, 200.0));
        let (sx, sy) = mapper.to_scaled(2020.0, 200.0);
        assert!((sx - 50.0).abs() < 1e-10);
        assert!((sy - 100.0).abs() < 1e-10);
    }
}
