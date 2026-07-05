# LSP Integration Example

This document shows how agents can use the LSP tools in agentd.

## Example 1: Find definition of a Rust function

Given a Rust project with this structure:

```
my-project/
├── Cargo.toml
└── src/
    └── main.rs
```

Where `main.rs` contains:

```rust
fn hello() {
    println!("Hello, world!");
}

fn main() {
    hello();  // Line 6, character 5
}
```

The agent can use `lsp_definition` to jump to the definition:

```json
{
  "tool": "lsp_definition",
  "args": {
    "file": "src/main.rs",
    "line": 6,
    "character": 5
  }
}
```

Result:

```json
{
  "success": true,
  "data": {
    "locations": [
      {
        "uri": "file:///path/to/my-project/src/main.rs",
        "line": 1,
        "character": 4
      }
    ],
    "projectType": "rust"
  }
}
```

## Example 2: Get type information with hover

```json
{
  "tool": "lsp_hover",
  "args": {
    "file": "src/main.rs",
    "line": 6,
    "character": 5
  }
}
```

Result:

```json
{
  "success": true,
  "data": {
    "content": "```rust\nfn hello()\n```\n\nDefined at main.rs:1:1",
    "kind": "markdown",
    "projectType": "rust"
  }
}
```

## Example 3: Find all references

```json
{
  "tool": "lsp_references",
  "args": {
    "file": "src/main.rs",
    "line": 1,
    "character": 4,
    "include_declaration": true
  }
}
```

Result:

```json
{
  "success": true,
  "data": {
    "references": [
      {
        "uri": "file:///path/to/my-project/src/main.rs",
        "line": 1,
        "character": 4
      },
      {
        "uri": "file:///path/to/my-project/src/main.rs",
        "line": 6,
        "character": 5
      }
    ],
    "count": 2,
    "projectType": "rust"
  }
}
```

## Example 4: List all symbols in a file

```json
{
  "tool": "lsp_symbols",
  "args": {
    "file": "src/main.rs"
  }
}
```

Result:

```json
{
  "success": true,
  "data": {
    "symbols": [
      {
        "name": "hello",
        "kind": 12,
        "range": {
          "start": {"line": 0, "character": 0},
          "end": {"line": 2, "character": 1}
        },
        "selectionRange": {
          "start": {"line": 0, "character": 3},
          "end": {"line": 0, "character": 8}
        }
      },
      {
        "name": "main",
        "kind": 12,
        "range": {
          "start": {"line": 4, "character": 0},
          "end": {"line": 7, "character": 1}
        },
        "selectionRange": {
          "start": {"line": 4, "character": 3},
          "end": {"line": 4, "character": 7}
        }
      }
    ],
    "projectType": "rust"
  }
}
```

## Automatic Installation

When an agent uses an LSP tool for the first time in a project:

1. **Project detection**: Scans for `Cargo.toml`, `go.mod`, `package.json`, etc.
2. **Check installation**: Runs `command -v rust-analyzer` (or gopls, clangd, etc.) **inside the container**
3. **Auto-install if missing**: 
   - Rust: `curl https://sh.rustup.rs | sh -s -- -y && rustup component add rust-analyzer`
   - Go: `go install golang.org/x/tools/gopls@latest`
   - C/C++: `apt-get install -y clangd`
   - Python: `pip install pyright`
   - TypeScript/JavaScript: `npm install -g typescript-language-server typescript`
4. **Start LSP server inside container**: Launches via `lxc-attach -n <container> -- /bin/sh -c "cd <workdir> && rust-analyzer"`
5. **Bridge stdio**: Communication between host and container LSP via stdin/stdout pipes
6. **Cache**: Keeps the server running for subsequent requests (10 min idle timeout)

## Architecture

```
┌─────────────────────────────────────┐
│  agentd (Host)                      │
│  ┌─────────────────────────────┐   │
│  │ LSP Manager                 │   │
│  │  - Client (JSON-RPC)        │   │
│  │  - stdin/stdout pipes       │   │
│  └──────────┬──────────────────┘   │
│             │                        │
│             │ lxc-attach bridge     │
│             ↓                        │
│  ┌─────────────────────────────┐   │
│  │ LXC Container               │   │
│  │  ┌─────────────────────┐   │   │
│  │  │ rust-analyzer       │   │   │
│  │  │ (or gopls, clangd)  │   │   │
│  │  │                     │   │   │
│  │  │ Reads project files │   │   │
│  │  │ in /workspace/      │   │   │
│  │  └─────────────────────┘   │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

The LSP server runs inside the container with the same view of the filesystem as other agent tools (exec, read, write, etc.). This ensures consistency and proper isolation.

## Supported Languages

| Language   | LSP Server | Project Markers | Auto-install Command |
|------------|-----------|-----------------|---------------------|
| Rust       | rust-analyzer | Cargo.toml | rustup component add |
| Go         | gopls | go.mod, go.work | go install |
| C/C++      | clangd | CMakeLists.txt, compile_commands.json | apt-get install |
| Python     | pyright-langserver | pyproject.toml, requirements.txt | pip install |
| TypeScript | typescript-language-server | tsconfig.json | npm install -g |
| JavaScript | typescript-language-server | package.json | npm install -g |

## Performance

- **First call**: 30s-2min (includes installation + initialization)
- **Subsequent calls**: 100-500ms (server already running)
- **Memory**: ~50-200MB per LSP server (inside container)
- **Idle timeout**: 10 minutes (server auto-closes if unused)

## Benefits of Container-Internal LSP

✅ **Full isolation** - LSP runs in the same security boundary as other agent tools  
✅ **Consistent view** - LSP sees exactly the same filesystem as exec/read/write  
✅ **No host pollution** - LSP installations don't affect the host system  
✅ **Multi-version support** - Different containers can have different LSP versions  
✅ **Reproducible** - Container state includes LSP configuration

## Implementation Details

- Uses `lxc-attach` to execute LSP commands inside the container
- JSON-RPC 2.0 messages flow over stdin/stdout pipes
- Host-side client handles protocol framing (Content-Length headers)
- No network sockets required - pure stdio communication
