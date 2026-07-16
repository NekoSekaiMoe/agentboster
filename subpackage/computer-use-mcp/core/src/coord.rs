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
