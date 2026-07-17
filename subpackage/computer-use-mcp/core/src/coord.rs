pub struct CoordMapper {
    pub scale_factor: f64,
}

impl CoordMapper {
    pub fn new(scale_factor: f64) -> Self {
        Self { scale_factor }
    }

    pub fn to_native(&self, x: f64, y: f64) -> (f64, f64) {
        (x * self.scale_factor, y * self.scale_factor)
    }

    pub fn to_scaled(&self, x: f64, y: f64) -> (f64, f64) {
        (x / self.scale_factor, y / self.scale_factor)
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
}
