use crate::coord::CoordMapper;
use enigo::{Coordinate, Enigo, Keyboard, Mouse, Settings};

pub struct InputController {
    enigo: Enigo,
    coord_mapper: CoordMapper,
}

impl InputController {
    pub fn new(scale_factor: f64) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            enigo: Enigo::new(&Settings::default()).map_err(|e| e.to_string())?,
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
            "back" | "Back" => enigo::Button::Back,
            "forward" | "Forward" => enigo::Button::Forward,
            _ => enigo::Button::Left,
        };
        self.enigo.button(btn, enigo::Direction::Click)?;
        if double {
            self.enigo.button(btn, enigo::Direction::Click)?;
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
        self.enigo
            .button(enigo::Button::Left, enigo::Direction::Press)?;
        self.enigo
            .move_mouse(tx as i32, ty as i32, Coordinate::Abs)?;
        self.enigo
            .button(enigo::Button::Left, enigo::Direction::Release)?;
        Ok(())
    }

    pub fn type_text(&mut self, text: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.enigo.text(text)?;
        Ok(())
    }

    pub fn key_event(
        &mut self,
        key: &str,
        direction: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let k = parse_key(key)?;
        let dir = match direction {
            "press" => enigo::Direction::Press,
            "release" => enigo::Direction::Release,
            "click" => enigo::Direction::Click,
            _ => return Err(format!("unknown direction: {direction}").into()),
        };
        self.enigo.key(k, dir)?;
        Ok(())
    }

    pub fn key_combo(
        &mut self,
        key: &str,
        modifiers: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let k = parse_key(key)?;
        let mods: Vec<enigo::Key> = modifiers
            .iter()
            .map(|m| parse_key(m))
            .collect::<Result<_, _>>()?;
        for m in &mods {
            self.enigo.key(*m, enigo::Direction::Press)?;
        }
        self.enigo.key(k, enigo::Direction::Click)?;
        for m in mods.iter().rev() {
            self.enigo.key(*m, enigo::Direction::Release)?;
        }
        Ok(())
    }
}

pub fn parse_key(s: &str) -> Result<enigo::Key, Box<dyn std::error::Error>> {
    Ok(match s {
        "Return" | "return" | "Enter" | "enter" => enigo::Key::Return,
        "Tab" | "tab" => enigo::Key::Tab,
        "Space" | "space" => enigo::Key::Space,
        "Escape" | "escape" | "Esc" | "esc" => enigo::Key::Escape,
        "Backspace" | "backspace" => enigo::Key::Backspace,
        "Delete" | "delete" | "Del" | "del" => enigo::Key::Delete,
        #[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
        "Insert" | "insert" => enigo::Key::Insert,
        "Home" | "home" => enigo::Key::Home,
        "End" | "end" => enigo::Key::End,
        "PageUp" | "pageup" => enigo::Key::PageUp,
        "PageDown" | "pagedown" => enigo::Key::PageDown,
        "Up" | "up" => enigo::Key::UpArrow,
        "Down" | "down" => enigo::Key::DownArrow,
        "Left" | "left" => enigo::Key::LeftArrow,
        "Right" | "right" => enigo::Key::RightArrow,
        "Control" | "control" | "Ctrl" | "ctrl" => enigo::Key::Control,
        "Shift" | "shift" => enigo::Key::Shift,
        "Alt" | "alt" => enigo::Key::Alt,
        "Meta" | "meta" | "Cmd" | "cmd" | "Super" | "super" | "Win" | "win" => enigo::Key::Meta,
        "CapsLock" | "capslock" => enigo::Key::CapsLock,
        "F1" => enigo::Key::F1,
        "F2" => enigo::Key::F2,
        "F3" => enigo::Key::F3,
        "F4" => enigo::Key::F4,
        "F5" => enigo::Key::F5,
        "F6" => enigo::Key::F6,
        "F7" => enigo::Key::F7,
        "F8" => enigo::Key::F8,
        "F9" => enigo::Key::F9,
        "F10" => enigo::Key::F10,
        "F11" => enigo::Key::F11,
        "F12" => enigo::Key::F12,
        _ => {
            let mut chars = s.chars();
            let only = chars.next();
            if let Some(c) = only {
                if chars.next().is_none() {
                    enigo::Key::Unicode(c)
                } else {
                    return Err(format!("unknown key: {s}").into());
                }
            } else {
                return Err(format!("unknown key: {s}").into());
            }
        }
    })
}
