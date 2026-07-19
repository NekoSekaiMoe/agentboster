use computer_use_core::capability::detect_capabilities;
use computer_use_core::lock::ComputerUseLock;
use computer_use_core::screenshot::{ScreenshotFormat, clamp_quality};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::PathBuf;

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[serde(rename = "jsonrpc")]
    _jsonrpc: String,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Serialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

/// Server-level settings received from the client during `initialize`.
struct ServerSettings {
    /// When true, terminal windows are NOT masked in screenshots and the model
    /// can interact with terminals. When false (default), terminal windows
    /// are masked and input operations targeting a terminal are rejected.
    allow_terminal_edit: bool,
    /// Default screenshot output format. Overridable per-call via the
    /// `format` argument. Read from COMPUTER_USE_SCREENSHOT_FORMAT env
    /// (set by the desktop app from its Settings panel). Defaults to
    /// "jpeg" — ~5-10x smaller than PNG at q80, with negligible vision
    /// recognition loss.
    screenshot_format: ScreenshotFormat,
    /// Default JPEG quality 1-100. Overridable per-call via `quality`.
    /// Read from COMPUTER_USE_SCREENSHOT_QUALITY env. Defaults to 80.
    screenshot_quality: u8,
}

impl ServerSettings {
    /// Read defaults from the environment (set by the desktop app when
    /// it spawns the CLI, which in turn spawns us). The desktop app
    /// owns these as first-class settings panel entries; the server
    /// treats them as session defaults that per-call args can override.
    fn from_env() -> Self {
        let format = std::env::var("COMPUTER_USE_SCREENSHOT_FORMAT")
            .map(|s| ScreenshotFormat::parse(&s))
            .unwrap_or(ScreenshotFormat::Jpeg);
        let quality = clamp_quality(
            std::env::var("COMPUTER_USE_SCREENSHOT_QUALITY")
                .ok()
                .and_then(|s| s.parse::<i32>().ok()),
        );
        ServerSettings {
            allow_terminal_edit: false,
            screenshot_format: format,
            screenshot_quality: quality,
        }
    }
}

struct LastScreenshot {
    scale_factor: f64,
    monitor_origin: (i32, i32),
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = std::env::var("CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("agentboster-cli")
        });

    let session_id = std::env::var("SESSION_ID").unwrap_or_else(|_| "mcp-server".to_string());

    let _lock = match ComputerUseLock::acquire(&session_id, &config_dir) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!("Failed to acquire computer-use lock: {}", e);
            std::process::exit(1);
        }
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    let capabilities = detect_capabilities();
    let mut settings = ServerSettings::from_env();
    let mut last_screenshot: Option<LastScreenshot> = None;

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id: Value::Null,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {e}"),
                    }),
                };
                writeln!(stdout.lock(), "{}", serde_json::to_string(&resp)?)?;
                continue;
            }
        };

        if request.id.is_none() {
            continue;
        }
        let id = request.id.unwrap();

        let response = match request.method.as_str() {
            "initialize" => {
                // Read allow_terminal_edit from client params if provided
                if let Some(val) = request
                    .params
                    .get("settings")
                    .and_then(|s| s.get("allow_terminal_edit"))
                    .and_then(|v| v.as_bool())
                {
                    settings.allow_terminal_edit = val;
                }

                let supported = ["2024-11-05"];
                let client_version = request
                    .params
                    .get("protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let protocol_version = if supported.contains(&client_version) {
                    client_version
                } else {
                    supported[0]
                };
                JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: Some(json!({
                        "protocolVersion": protocol_version,
                        "capabilities": {
                            "tools": {},
                            "computerUse": {
                                "hasDisplay": capabilities.has_display,
                                "platform": capabilities.platform,
                                "displayServer": capabilities.display_server,
                                "displayResolution": capabilities.display_resolution
                                    .map(|(w, h)| json!({"native": [w, h]})),
                                "scaleFactor": capabilities.scale_factor,
                                "accessibilityGranted": capabilities.accessibility_granted,
                                "isAdmin": capabilities.is_admin,
                                "issues": capabilities.issues,
                            }
                        },
                        "serverInfo": {
                            "name": "computer-use-mcp",
                            "version": env!("CARGO_PKG_VERSION"),
                        },
                        "settings": {
                            "allow_terminal_edit": settings.allow_terminal_edit,
                        }
                    })),
                    error: None,
                }
            }
            "tools/list" => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: Some(json!({
                    "tools": tools_list(&capabilities)
                })),
                error: None,
            },
            "tools/call" => handle_tool_call(
                id,
                &request.params,
                &capabilities,
                &settings,
                &mut last_screenshot,
            ),
            _ => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: None,
                error: Some(JsonRpcError {
                    code: -32601,
                    message: format!("Method not found: {}", request.method),
                }),
            },
        };

        writeln!(stdout.lock(), "{}", serde_json::to_string(&response)?)?;
        stdout.lock().flush()?;
    }

    Ok(())
}

fn tools_list(caps: &computer_use_core::capability::Capabilities) -> Vec<Value> {
    let mut tools = vec![json!({
        "name": "screenshot",
        "description": "Capture the screen. Returns a scaled image (default JPEG quality 80 — 5-10x smaller than PNG at q80 with negligible vision loss; pass format=\"png\" for pixel-perfect output).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_width": { "type": "integer", "description": "Max width in pixels (default: 1400)" },
                "monitor_index": { "type": "integer", "description": "Monitor index (default: primary)" },
                "format": { "type": "string", "enum": ["png", "jpeg"], "description": "Image format. Default: jpeg (set by desktop Settings panel; overrides per-call)." },
                "quality": { "type": "integer", "description": "JPEG quality 1-100. Ignored for png. Default: 80 (set by desktop Settings panel; overrides per-call)." }
            }
        }
    })];

    if caps.has_display && caps.accessibility_granted {
        tools.extend([
            json!({ "name": "mouse_move", "description": "Move cursor to (x, y) in screenshot scale.", "inputSchema": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] } }),
            json!({ "name": "mouse_click", "description": "Click at (x, y).", "inputSchema": { "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" }, "button": { "type": "string", "enum": ["left", "right", "middle", "back", "forward"] }, "click_type": { "type": "string", "enum": ["single", "double"] } }, "required": ["x", "y"] } }),
            json!({ "name": "mouse_drag", "description": "Drag from one point to another.", "inputSchema": { "type": "object", "properties": { "from_x": { "type": "number" }, "from_y": { "type": "number" }, "to_x": { "type": "number" }, "to_y": { "type": "number" } }, "required": ["from_x", "from_y", "to_x", "to_y"] } }),
            json!({ "name": "key_event", "description": "Press a key combination.", "inputSchema": { "type": "object", "properties": { "key": { "type": "string" }, "modifiers": { "type": "array", "items": { "type": "string" } } }, "required": ["key"] } }),
            json!({ "name": "type_text", "description": "Type a string.", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } }),
            json!({ "name": "get_accessibility_tree", "description": "Get the accessibility element at screen coordinates.", "inputSchema": { "type": "object", "properties": { "x": { "type": "integer" }, "y": { "type": "integer" }, "max_depth": { "type": "integer", "description": "Tree depth limit (default: 3, max: 5)" } }, "required": ["x", "y"] } }),
            json!({ "name": "get_focused_element", "description": "Get the currently focused accessibility element.", "inputSchema": { "type": "object", "properties": { "max_depth": { "type": "integer", "description": "Tree depth limit (default: 3, max: 5)" } } } }),
        ]);
    }

    tools
}

fn handle_tool_call(
    id: Value,
    params: &Value,
    caps: &computer_use_core::capability::Capabilities,
    settings: &ServerSettings,
    last_screenshot: &mut Option<LastScreenshot>,
) -> JsonRpcResponse {
    let tool_name = params["name"].as_str().unwrap_or("");
    let args = &params["arguments"];

    let invalid_params = |msg: String| JsonRpcResponse {
        jsonrpc: "2.0".into(),
        id: id.clone(),
        result: None,
        error: Some(JsonRpcError {
            code: -32602,
            message: msg,
        }),
    };

    if !caps.has_display {
        return JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32000,
                message: "No display available".into(),
            }),
        };
    }

    match tool_name {
        "screenshot" => {
            let max_width = if args.get("max_width").is_some_and(|v| !v.is_null()) {
                match args["max_width"].as_u64() {
                    Some(0) => return invalid_params("max_width must be > 0".into()),
                    Some(v) => Some(v as u32),
                    None => return invalid_params("max_width must be a positive integer".into()),
                }
            } else {
                None
            };
            let monitor_index = if args.get("monitor_index").is_some_and(|v| !v.is_null()) {
                match args["monitor_index"].as_u64() {
                    Some(v) => Some(v as usize),
                    None => {
                        return invalid_params(
                            "monitor_index must be a non-negative integer".into(),
                        );
                    }
                }
            } else {
                None
            };
            // Per-call override of session defaults (which themselves default
            // from COMPUTER_USE_SCREENSHOT_FORMAT/QUALITY env vars set by the
            // desktop app's Settings panel).
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .map(ScreenshotFormat::parse)
                .unwrap_or(settings.screenshot_format);
            let quality = clamp_quality(
                args.get("quality")
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32)
                    .or(Some(settings.screenshot_quality as i32)),
            );
            let exclude_terminals = !settings.allow_terminal_edit;
            match computer_use_core::screenshot::capture_and_scale(
                max_width,
                monitor_index,
                Some(exclude_terminals),
                format,
                quality,
            ) {
                Ok(result) => {
                    *last_screenshot = Some(LastScreenshot {
                        scale_factor: result.scale_factor,
                        monitor_origin: result.monitor_origin,
                    });
                    JsonRpcResponse {
                        jsonrpc: "2.0".into(),
                        id,
                        result: Some(json!({
                            "content": [{
                                "type": "image",
                                "data": result.image_base64,
                                "mimeType": result.format.mime()
                            }],
                            "_meta": {
                                "nativeSize": result.native_size,
                                "scaledSize": result.scaled_size,
                                "scaleFactor": result.scale_factor,
                                "monitorOrigin": result.monitor_origin,
                                "monitorIndex": result.monitor_index,
                                "format": match result.format {
                                    ScreenshotFormat::Png => "png",
                                    ScreenshotFormat::Jpeg => "jpeg",
                                },
                            }
                        })),
                        error: None,
                    }
                }
                Err(e) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: format!("Screenshot failed: {e}"),
                    }),
                },
            }
        }
        "mouse_move" | "mouse_click" | "mouse_drag" | "type_text" | "key_event" => {
            if !settings.allow_terminal_edit {
                let terminal_ids = computer_use_core::safety::terminal_window_ids();
                if !terminal_ids.is_empty()
                    && let Some(fg_id) = computer_use_core::input::get_foreground_window_id()
                    && terminal_ids.contains(&fg_id)
                {
                    return JsonRpcResponse {
                        jsonrpc: "2.0".into(),
                        id,
                        result: None,
                        error: Some(JsonRpcError {
                            code: -32000,
                            message: "Input rejected: foreground window is a terminal. Set allow_terminal_edit=true to allow.".into(),
                        }),
                    };
                }
            }

            let input_scale = last_screenshot
                .as_ref()
                .map(|s| s.scale_factor)
                .unwrap_or(caps.scale_factor);
            let input_origin = last_screenshot
                .as_ref()
                .map(|s| s.monitor_origin)
                .unwrap_or((0, 0));

            let mut ctrl = match computer_use_core::input::InputController::new_with_origin(
                input_scale,
                input_origin,
            ) {
                Ok(c) => c,
                Err(e) => {
                    return JsonRpcResponse {
                        jsonrpc: "2.0".into(),
                        id,
                        result: None,
                        error: Some(JsonRpcError {
                            code: -32000,
                            message: format!("Input init failed: {e}"),
                        }),
                    };
                }
            };

            let result = match tool_name {
                "mouse_move" => {
                    let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) else {
                        return invalid_params("x and y are required".into());
                    };
                    ctrl.mouse_move(x, y).map(|_| json!({"moved_to": [x, y]}))
                }
                "mouse_click" => {
                    let (Some(x), Some(y)) = (args["x"].as_f64(), args["y"].as_f64()) else {
                        return invalid_params("x and y are required".into());
                    };
                    let button = args["button"].as_str().unwrap_or("left");
                    let double = args["click_type"].as_str() == Some("double");
                    ctrl.mouse_click(x, y, button, double)
                        .map(|_| json!({"clicked": [x, y], "button": button}))
                }
                "mouse_drag" => {
                    let (Some(fx), Some(fy), Some(tx), Some(ty)) = (
                        args["from_x"].as_f64(),
                        args["from_y"].as_f64(),
                        args["to_x"].as_f64(),
                        args["to_y"].as_f64(),
                    ) else {
                        return invalid_params("from_x, from_y, to_x, to_y are required".into());
                    };
                    ctrl.mouse_drag(fx, fy, tx, ty)
                        .map(|_| json!({"dragged": {"from": [fx, fy], "to": [tx, ty]}}))
                }
                "type_text" => {
                    let Some(text) = args["text"].as_str() else {
                        return invalid_params("text is required".into());
                    };
                    ctrl.type_text(text).map(|_| json!({"typed": text}))
                }
                "key_event" => {
                    let Some(key) = args["key"].as_str() else {
                        return invalid_params("key is required".into());
                    };
                    if key.is_empty() {
                        return invalid_params("key must not be empty".into());
                    }
                    let modifiers: Vec<String> =
                        if let Some(val) = args.get("modifiers").filter(|v| !v.is_null()) {
                            match val.as_array() {
                                Some(arr) => arr
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect(),
                                None => {
                                    return invalid_params(
                                        "modifiers must be an array of strings".into(),
                                    );
                                }
                            }
                        } else {
                            Vec::new()
                        };
                    if modifiers.is_empty() {
                        ctrl.key_event(key, "click").map(|_| json!({"key": key}))
                    } else {
                        ctrl.key_combo(key, &modifiers)
                            .map(|_| json!({"key": key, "modifiers": modifiers}))
                    }
                }
                _ => unreachable!(),
            };

            match result {
                Ok(val) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: Some(json!({"content": [{"type": "text", "text": val.to_string()}]})),
                    error: None,
                },
                Err(e) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: format!("Tool failed: {e}"),
                    }),
                },
            }
        }
        "get_accessibility_tree" => {
            if !caps.accessibility_granted {
                return JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: "Accessibility permission not granted".into(),
                    }),
                };
            }
            let (Some(x), Some(y)) = (args["x"].as_i64(), args["y"].as_i64()) else {
                return invalid_params("x and y are required integers".into());
            };
            let (x, y) = (x as i32, y as i32);
            let max_depth = args["max_depth"].as_u64().map(|v| v as u32);
            match computer_use_core::accessibility::get_ax_at_point(x, y, max_depth) {
                Ok(node) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: Some(
                        json!({"content": [{"type": "text", "text": serde_json::to_string(&node).unwrap_or_default()}]}),
                    ),
                    error: None,
                },
                Err(e) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: format!("get_ax_at_point failed: {e}"),
                    }),
                },
            }
        }
        "get_focused_element" => {
            if !caps.accessibility_granted {
                return JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: "Accessibility permission not granted".into(),
                    }),
                };
            }
            match computer_use_core::accessibility::get_focused_ax(
                args["max_depth"].as_u64().map(|v| v as u32),
            ) {
                Ok(node) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: Some(
                        json!({"content": [{"type": "text", "text": serde_json::to_string(&node).unwrap_or_default()}]}),
                    ),
                    error: None,
                },
                Err(e) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(JsonRpcError {
                        code: -32000,
                        message: format!("get_focused_ax failed: {e}"),
                    }),
                },
            }
        }
        _ => JsonRpcResponse {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code: -32601,
                message: format!("Unknown tool: {tool_name}"),
            }),
        },
    }
}
