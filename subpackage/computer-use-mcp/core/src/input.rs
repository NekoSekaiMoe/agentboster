use crate::coord::CoordMapper;
use enigo::{Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

pub struct InputController {
    enigo: Enigo,
    coord_mapper: CoordMapper,
}

impl InputController {
    pub fn new(scale_factor: f64) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            enigo: Enigo::new(&Settings::default())?,
            coord_mapper: CoordMapper::new(scale_factor),
        })
    }

    pub fn mouse_move(&mut self, x: f64, y: f64) -> Result<(), Box<dyn std::error::Error>> {
        let (nx, ny) = self.coord_mapper.to_native(x, y);
        self.enigo
            .move_mouse(nx as i32, ny as i32, Coordinate::Abs)?;
        Ok(())
    }

    pub fn mouse_click(
        &mut self,
        x: f64,
        y: f64,
        button: &str,
        double: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.mouse_move(x, y)?;
        let btn = match button {
            "right" => enigo::Button::Right,
            "middle" => enigo::Button::Middle,
            _ => enigo::Button::Left,
        };
        self.enigo.button(btn, Direction::Click)?;
        if double {
            self.enigo.button(btn, Direction::Click)?;
        }
        Ok(())
    }

    pub fn mouse_drag(
        &mut self,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (fx, fy) = self.coord_mapper.to_native(from_x, from_y);
        let (tx, ty) = self.coord_mapper.to_native(to_x, to_y);
        self.enigo
            .move_mouse(fx as i32, fy as i32, Coordinate::Abs)?;
        self.enigo.button(enigo::Button::Left, Direction::Press)?;
        self.enigo
            .move_mouse(tx as i32, ty as i32, Coordinate::Abs)?;
        self.enigo.button(enigo::Button::Left, Direction::Release)?;
        Ok(())
    }

    pub fn type_text(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.enigo.text(text)?;
        Ok(())
    }
}
