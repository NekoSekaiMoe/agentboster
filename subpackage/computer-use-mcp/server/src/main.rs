use computer_use_core::capability::detect_capabilities;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Value,
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();

    let capabilities = detect_capabilities();

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

        let response = match request.method.as_str() {
            "initialize" => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: request.id,
                result: Some(json!({
                    "protocolVersion": "2024-11-05",
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
                    }
                })),
                error: None,
            },
            "tools/list" => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: request.id,
                result: Some(json!({
                    "tools": tools_list(&capabilities)
                })),
                error: None,
            },
            "tools/call" => handle_tool_call(request.id, &request.params, &capabilities),
            _ => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id: request.id,
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

fn tools_list(
    caps: &computer_use_core::capability::Capabilities,
) -> Vec<Value> {
    let mut tools = vec![
        json!({
            "name": "screenshot",
            "description": "Capture the screen. Returns a scaled PNG image.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "max_width": { "type": "integer", "description": "Max width in pixels (default: 1400)" },
                    "monitor_index": { "type": "integer", "description": "Monitor index (default: primary)" }
                }
            }
        }),
    ];

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
            let max_width = args["max_width"].as_u64().map(|v| v as u32);
            if let Some(w) = max_width {
                if w == 0 {
                    return invalid_params("max_width must be > 0".into());
                }
            }
            let monitor_index = args["monitor_index"].as_u64().map(|v| v as usize);
            match computer_use_core::screenshot::capture_and_scale(max_width, monitor_index) {
                Ok(result) => JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: Some(json!({
                        "content": [{
                            "type": "image",
                            "data": result.png_base64,
                            "mimeType": "image/png"
                        }],
                        "_meta": {
                            "nativeSize": result.native_size,
                            "scaledSize": result.scaled_size,
                            "scaleFactor": result.scale_factor,
                        }
                    })),
                    error: None,
                },
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
            let mut ctrl = match computer_use_core::input::InputController::new(caps.scale_factor) {
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
                    ctrl.type_text(text)
                        .map(|_| json!({"typed": text}))
                }
                "key_event" => {
                    let Some(key) = args["key"].as_str() else {
                        return invalid_params("key is required".into());
                    };
                    if key.is_empty() {
                        return invalid_params("key must not be empty".into());
                    }
                    let modifiers: Vec<String> = args["modifiers"]
                        .as_array()
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    if modifiers.is_empty() {
                        ctrl.key_event(key, "click")
                            .map(|_| json!({"key": key}))
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
                    result: Some(json!({"content": [{"type": "text", "text": serde_json::to_string(&node).unwrap_or_default()}]})),
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
                    result: Some(json!({"content": [{"type": "text", "text": serde_json::to_string(&node).unwrap_or_default()}]})),
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
