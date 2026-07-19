use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

// GitHub releases feed for the CLI tarballs. The installer queries the
// `/releases/latest` endpoint at runtime to discover the current version
// (tag_name) and download URL, so Desktop never needs to be in lock-step
// with CLI releases.
const CLI_RELEASES_API: &str =
    "https://api.github.com/repos/NekoSekaiMoe/agentboster/releases/latest";

#[derive(Default)]
struct RpcProcessHandle {
    generation: u64,
    process: Option<Child>,
    stdin_writer: Option<std::process::ChildStdin>,
}

/// State for managing multiple RPC child processes (one per instance)
pub struct RpcState {
    instances: Arc<Mutex<HashMap<String, RpcProcessHandle>>>,
}

impl Default for RpcState {
    fn default() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[derive(Debug, Serialize, Clone)]
struct RpcLineEventPayload {
    instance_id: String,
    generation: u64,
    line: String,
}

#[derive(Debug, Serialize, Clone)]
struct RpcClosedEventPayload {
    instance_id: String,
    generation: u64,
    reason: String,
}

#[derive(Debug, Serialize)]
struct RpcStartResult {
    discovery: String,
    generation: u64,
}

fn normalize_instance_id(instance_id: Option<String>) -> String {
    let raw = instance_id.unwrap_or_else(|| "default".to_string());
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

fn stop_rpc_instance(handle: &mut RpcProcessHandle) {
    // Drop the stdin writer first. RPC mode's `process.stdin.on('end')`
    // handler triggers its `shutdown()` path, which POSTs `/release` to
    // the Web backend — that clears the KV online state promptly
    // instead of waiting for the 120s TTL after a hard kill.
    handle.stdin_writer = None;
    if let Some(mut child) = handle.process.take() {
        // Give the CLI up to ~2s to exit on its own after stdin closed.
        // `try_wait` is non-blocking, so we poll every 50ms.
        const GRACE_MS: u64 = 2000;
        const POLL_MS: u64 = 50;
        let mut waited_ms = 0u64;
        while waited_ms < GRACE_MS {
            match child.try_wait() {
                Ok(Some(_status)) => return, // exited cleanly
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
                    waited_ms += POLL_MS;
                }
                Err(_) => break, // weird state; fall through to kill
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RpcStartOptions {
    /// Dev-mode only: path to the CLI JS file (e.g. "../coding-agent/dist/cli.js").
    /// When null/empty, the backend discovers the pi binary automatically.
    cli_path: Option<String>,
    /// Optional explicit pi binary path override from Desktop settings.
    /// When set, this takes precedence over sidecar/PATH/common-location discovery.
    pi_path: Option<String>,
    cwd: String,
    provider: Option<String>,
    model: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    /// When set together with `backend_url`, the CLI registers itself
    /// with the Web backend as online for this session id and listens
    /// for incoming tool-request events. Lets Web-side `computer-use-remote`
    /// dispatch to a CLI that Desktop spawned.
    session_id: Option<String>,
    /// Web backend base URL. Paired with `session_id`.
    backend_url: Option<String>,
}

/// How the pi process was resolved
#[derive(Debug, Clone)]
enum PiProcess {
    /// Dev mode: node <script> --mode rpc
    DevNode { script: String },
    /// Packaged sidecar binary bundled with the desktop app
    SidecarBinary { path: std::path::PathBuf },
    /// Production/dev fallback: standalone pi binary found on PATH
    PathBinary { path: std::path::PathBuf },
}

fn find_sidecar_in_dir(dir: &Path, expected_name: &str) -> Option<PathBuf> {
    let exact = dir.join(expected_name);
    if exact.is_file() {
        return Some(exact);
    }

    None
}

fn sidecar_candidate_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        dirs.push(resource_dir.clone());
        dirs.push(resource_dir.join("binaries"));
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        dirs.push(parent.to_path_buf());
        dirs.push(parent.join("binaries"));
        dirs.push(parent.join(".."));
        dirs.push(parent.join("..").join("Resources"));
        dirs.push(parent.join("..").join("Resources").join("binaries"));
    }

    dirs
}

fn discover_mcp_binary(app: &AppHandle) -> Option<PathBuf> {
    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let expected_name = format!("computer-use-mcp{}", extension);

    let candidate_dirs = sidecar_candidate_dirs(app);

    for dir in candidate_dirs {
        if !dir.exists() || !dir.is_dir() {
            continue;
        }
        if let Some(found) = find_sidecar_in_dir(&dir, &expected_name) {
            return Some(found);
        }
    }

    None
}

fn discover_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let default_target = if cfg!(target_os = "windows") {
        format!("{}-pc-windows-msvc", std::env::consts::ARCH)
    } else if cfg!(target_os = "macos") {
        format!("{}-apple-darwin", std::env::consts::ARCH)
    } else if cfg!(target_os = "linux") {
        format!("{}-unknown-linux-gnu", std::env::consts::ARCH)
    } else {
        format!(
            "{}-unknown-{}",
            std::env::consts::ARCH,
            std::env::consts::OS
        )
    };

    let target = std::env::var("TARGET").unwrap_or(default_target);

    let extension = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    let expected_name = format!("agentboster-cli-{}{}", target, extension);

    let candidate_dirs = sidecar_candidate_dirs(app);

    for dir in candidate_dirs {
        if !dir.exists() || !dir.is_dir() {
            continue;
        }
        if let Some(found) = find_sidecar_in_dir(&dir, &expected_name) {
            return Some(found);
        }
    }

    None
}

fn resolve_home_dir() -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME")
        && !home.trim().is_empty()
    {
        return Some(PathBuf::from(home));
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE")
        && !user_profile.trim().is_empty()
    {
        return Some(PathBuf::from(user_profile));
    }
    None
}

fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~"
        && let Some(home) = resolve_home_dir()
    {
        return home;
    }
    if let Some(rest) = trimmed.strip_prefix("~/")
        && let Some(home) = resolve_home_dir()
    {
        return home.join(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("~\\")
        && let Some(home) = resolve_home_dir()
    {
        return home.join(rest);
    }
    PathBuf::from(trimmed)
}

fn resolve_explicit_pi_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let expanded = expand_tilde_path(trimmed);
    if expanded.is_file() {
        return Some(expanded);
    }

    if let Ok(which_path) = which::which(trimmed) {
        return Some(which_path);
    }

    None
}

fn discover_pi_from_common_locations() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "windows") {
        if let Ok(app_data) = std::env::var("APPDATA") {
            let app_data_dir = PathBuf::from(app_data);
            candidates.push(app_data_dir.join("npm").join("agentboster-cli.cmd"));
            candidates.push(app_data_dir.join("npm").join("agentboster-cli.exe"));
            candidates.push(app_data_dir.join("npm").join("agentboster-cli.bat"));
            candidates.push(app_data_dir.join("npm").join("agentboster-cli"));
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local_app_data_dir = PathBuf::from(local_app_data);
            candidates.push(local_app_data_dir.join("npm").join("agentboster-cli.cmd"));
            candidates.push(local_app_data_dir.join("npm").join("agentboster-cli.exe"));
        }

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_dir = PathBuf::from(user_profile);
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("agentboster-cli.cmd"),
            );
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("agentboster-cli.exe"),
            );
            candidates.push(
                user_dir
                    .join("scoop")
                    .join("shims")
                    .join("agentboster-cli.cmd"),
            );
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(
                PathBuf::from(program_files)
                    .join("nodejs")
                    .join("agentboster-cli.cmd"),
            );
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(
                PathBuf::from(program_files_x86)
                    .join("nodejs")
                    .join("agentboster-cli.cmd"),
            );
        }

        if let Ok(program_data) = std::env::var("ProgramData") {
            let program_data_dir = PathBuf::from(program_data);
            candidates.push(program_data_dir.join("npm").join("agentboster-cli.cmd"));
            candidates.push(program_data_dir.join("npm").join("agentboster-cli.exe"));
        }

        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            candidates.push(PathBuf::from(nvm_home).join("agentboster-cli.cmd"));
        }

        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            candidates.push(PathBuf::from(nvm_symlink).join("agentboster-cli.cmd"));
        }

        // Auto-installed by `install_cli` (this Desktop app). The installer
        // writes agentboster-cli.cmd next to the .cjs bundle here.
        if let Some(home_dir) = resolve_home_dir() {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                let installed_bin = PathBuf::from(local)
                    .join("agentboster-cli")
                    .join("agent")
                    .join("bin");
                candidates.push(installed_bin.join("agentboster-cli.cmd"));
                candidates.push(installed_bin.join("agentboster-cli.exe"));
                candidates.push(installed_bin.join("agentboster-cli"));
            }
            let installed_bin = home_dir
                .join(".config")
                .join("agentboster-cli")
                .join("agent")
                .join("bin");
            candidates.push(installed_bin.join("agentboster-cli.cmd"));
            candidates.push(installed_bin.join("agentboster-cli.exe"));
            candidates.push(installed_bin.join("agentboster-cli"));
        }

        return candidates.into_iter().find(|candidate| candidate.is_file());
    }

    if let Some(home_dir) = resolve_home_dir() {
        // nvm installations (common for npm global installs)
        candidates.push(home_dir.join(".nvm/versions/node/current/bin/agentboster-cli"));
        let nvm_versions_dir = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
            let mut version_dirs: Vec<PathBuf> = entries
                .filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if path.is_dir() { Some(path) } else { None }
                })
                .collect();
            version_dirs.sort_by(|a, b| b.cmp(a));
            for version_dir in version_dirs {
                candidates.push(version_dir.join("bin/agentboster-cli"));
            }
        }

        // Other common per-user install locations
        if cfg!(target_os = "macos") {
            candidates.push(
                home_dir
                    .join("Library/Application Support/agentboster-cli/agent/bin/agentboster-cli"),
            );
        }
        candidates.push(home_dir.join(".config/agentboster-cli/agent/bin/agentboster-cli"));
        candidates.push(home_dir.join(".volta/bin/agentboster-cli"));
        candidates.push(home_dir.join(".local/bin/agentboster-cli"));
        candidates.push(home_dir.join(".npm-global/bin/agentboster-cli"));
        candidates.push(home_dir.join(".npm/bin/agentboster-cli"));
    }

    // npm custom prefix installs (common on Linux/macOS desktop launches)
    for key in ["NPM_CONFIG_PREFIX", "PREFIX"] {
        if let Ok(prefix) = std::env::var(key) {
            let trimmed = prefix.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("bin/agentboster-cli"));
                candidates.push(PathBuf::from(trimmed).join("agentboster-cli"));
            }
        }
    }

    // Common system install locations
    candidates.push(PathBuf::from("/opt/homebrew/bin/agentboster-cli"));
    candidates.push(PathBuf::from("/usr/local/bin/agentboster-cli"));
    candidates.push(PathBuf::from("/usr/bin/agentboster-cli"));

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn prepend_bin_dir_to_path(cmd: &mut Command, bin_dir: &Path) {
    let mut path_entries = vec![bin_dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&existing));
    }

    if let Ok(joined) = std::env::join_paths(path_entries) {
        cmd.env("PATH", joined);
    }
}

fn discover_pi_from_env_override() -> Option<PathBuf> {
    for key in [
        "AGENTBOSTER_DESKTOP_BIN_PATH",
        "AGENTBOSTER_CLI_PATH",
        "PI_DESKTOP_PI_PATH",
        "PI_CLI_PATH",
    ] {
        if let Ok(raw) = std::env::var(key)
            && let Some(path) = resolve_explicit_pi_path(&raw)
        {
            return Some(path);
        }
    }
    None
}

fn missing_pi_cli_error(additional: Option<String>) -> String {
    let mut message = String::from(
        "Could not find the agentboster CLI.\n\nInstall it by building subpackage/cli/ (see its README) and placing the `agentboster-cli` binary on your PATH.\n\nThen restart the app.",
    );
    if let Some(extra) = additional {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            message.push_str("\n\n");
            message.push_str(trimmed);
        }
    }
    message
}

// ── CLI auto-installer ────────────────────────────────────────────────
//
// Resolves the latest CLI release from GitHub, downloads the universal
// `agentboster-cli-<tag>.tar.gz` tarball, extracts it into the existing
// per-user bin dir (`~/.config/agentboster-cli/agent/bin/` — already on the
// discovery candidate list), and emits progress events to the frontend.
//
// The tarball layout (per `subpackage/cli/scripts/package.mjs`) is:
//   agentboster-cli-<tag>/
//     agentboster-cli        # shell wrapper, execs node agentboster-cli.cjs
//     agentboster-cli.cjs    # single-file esbuild bundle
//
// After extraction we point Desktop at `<bin_dir>/agentboster-cli` and let
// the existing discovery path pick it up on the next rpc_start.

#[derive(Debug, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Serialize, Clone)]
struct InstallProgressPayload {
    stage: String,
    /// 0.0–1.0 progress within the current stage, when meaningful.
    progress: Option<f64>,
    message: Option<String>,
}

#[derive(Debug, Serialize)]
struct InstallResult {
    /// Absolute path to the installed `agentboster-cli` entry script.
    bin_path: String,
    /// Release tag the installer pulled (e.g. "v0.1.5").
    version: String,
}

fn install_progress_event_name() -> &'static str {
    "cli-install-progress"
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("agentboster-desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Resolve the latest CLI release metadata from GitHub.
async fn fetch_latest_release(
    client: &reqwest::Client,
    app: &AppHandle,
) -> Result<GithubRelease, String> {
    emit_progress(
        app,
        "checking",
        None,
        Some("Looking up latest CLI release…".into()),
    );
    let resp = client
        .get(CLI_RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("GitHub release lookup failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "GitHub release lookup returned {}: {}",
            status,
            body.chars().take(300).collect::<String>()
        ));
    }
    let release: GithubRelease = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub release JSON: {}", e))?;
    if release.tag_name.trim().is_empty() {
        return Err("GitHub returned a release with empty tag_name".to_string());
    }
    Ok(release)
}

/// Pick the universal tarball asset. The packaging script names it
/// `agentboster-cli-<tag>.tar.gz`; we don't pin the tag here so this
/// keeps working as the version moves.
fn pick_tarball_asset(release: &GithubRelease) -> Result<&GithubAsset, String> {
    release
        .assets
        .iter()
        .find(|a| a.name.ends_with(".tar.gz") && a.name.starts_with("agentboster-cli-"))
        .ok_or_else(|| {
            let available: Vec<&str> = release.assets.iter().map(|a| a.name.as_str()).collect();
            format!(
                "Latest release {} has no agentboster-cli-*.tar.gz asset (assets: [{}])",
                release.tag_name,
                available.join(", ")
            )
        })
}

/// Destination dir for the installed CLI. Matches the per-user location
/// already on the discovery candidate list (`discover_pi_from_common_locations`),
/// so no extra wiring is needed for `rpc_start` to find the new binary.
fn install_target_bin_dir() -> Result<PathBuf, String> {
    let home =
        resolve_home_dir().ok_or_else(|| "Could not resolve $HOME / USERPROFILE".to_string())?;
    if cfg!(target_os = "macos") {
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("agentboster-cli")
            .join("agent")
            .join("bin"))
    } else if cfg!(target_os = "windows") {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            Ok(PathBuf::from(local)
                .join("agentboster-cli")
                .join("agent")
                .join("bin"))
        } else {
            Ok(home
                .join("AppData")
                .join("Local")
                .join("agentboster-cli")
                .join("agent")
                .join("bin"))
        }
    } else {
        Ok(home
            .join(".config")
            .join("agentboster-cli")
            .join("agent")
            .join("bin"))
    }
}

/// Stream the asset to a temp file, emitting download progress events.
async fn download_tarball(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    use futures_util::StreamExt;

    emit_progress(
        app,
        "downloading",
        Some(0.0),
        Some(format!("Fetching {}", url)),
    );
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {}", e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("Download returned HTTP {}", status));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut file = fs::File::create(dest)
        .map_err(|e| format!("Failed to create temp file {}: {}", dest.display(), e))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    const EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(120);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed writing download chunk: {}", e))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= EMIT_INTERVAL {
            let pct = if total > 0 {
                Some((received as f64 / total as f64).clamp(0.0, 1.0))
            } else {
                None
            };
            emit_progress(
                app,
                "downloading",
                pct,
                Some(format!(
                    "{} / {} bytes",
                    received,
                    if total > 0 {
                        total.to_string()
                    } else {
                        "?".to_string()
                    }
                )),
            );
            last_emit = std::time::Instant::now();
        }
    }

    file.flush()
        .map_err(|e| format!("Failed flushing download: {}", e))?;
    emit_progress(app, "downloading", Some(1.0), None);
    Ok(())
}

/// Extract the tarball into the bin dir. The archive contains a single
/// top-level dir (`agentboster-cli-<tag>/`) with `agentboster-cli` and
/// `agentboster-cli.cjs`; we flatten that prefix so the files land directly
/// in `bin_dir/`. Existing files are overwritten.
fn extract_tarball(tarball: &Path, bin_dir: &Path, app: &AppHandle) -> Result<(), String> {
    emit_progress(app, "extracting", None, Some("Unpacking archive…".into()));
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("Failed to create {}: {}", bin_dir.display(), e))?;

    let f =
        fs::File::open(tarball).map_err(|e| format!("Failed to open downloaded tarball: {}", e))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut archive = tar::Archive::new(gz);

    for entry in archive
        .entries()
        .map_err(|e| format!("tar read error: {}", e))?
    {
        let mut entry = entry.map_err(|e| format!("tar entry error: {}", e))?;
        let path = entry.path().map_err(|e| format!("tar path error: {}", e))?;
        let path = path.into_owned();

        // Flatten the single top-level dir: skip it, descend one level.
        let components: Vec<_> = path.components().collect();
        if components.len() < 2 {
            continue;
        }
        let relative: PathBuf = components.into_iter().skip(1).collect();
        if relative.as_os_str().is_empty() {
            continue;
        }

        // Guard against path traversal (defense-in-depth; tar already
        // rejects absolute / `..` paths when unpack_in_prefix is used,
        // but we unpack manually here).
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }

        let dest = bin_dir.join(&relative);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
        }

        entry
            .unpack(&dest)
            .map_err(|e| format!("Failed to unpack {}: {}", dest.display(), e))?;

        // The shell entry and the .cjs are shipped with the executable bit
        // set inside the archive, but Windows host unpacking or cross-fs
        // copies can drop it. Re-assert on non-Windows.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
        }
    }
    emit_progress(app, "extracting", Some(1.0), None);
    Ok(())
}

fn emit_progress(app: &AppHandle, stage: &str, progress: Option<f64>, message: Option<String>) {
    let _ = app.emit(
        install_progress_event_name(),
        InstallProgressPayload {
            stage: stage.to_string(),
            progress,
            message,
        },
    );
}

/// Install the latest CLI release into `~/.config/agentboster-cli/agent/bin/`.
/// Emits `cli-install-progress` events as it goes. Returns the path to
/// the installed `agentboster` entry script + the release tag.
#[tauri::command]
async fn install_cli(app: AppHandle) -> Result<InstallResult, String> {
    let client = http_client()?;
    let release = fetch_latest_release(&client, &app).await?;
    let asset = pick_tarball_asset(&release)?;

    let bin_dir = install_target_bin_dir()?;
    let staging = bin_dir.join(format!(".download-{}.tar.gz", release.tag_name));
    fs::create_dir_all(staging.parent().unwrap_or(Path::new(".")))
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    // Best-effort cleanup of any previous half-finished download.
    let _ = fs::remove_file(&staging);

    download_tarball(&client, &asset.browser_download_url, &staging, &app).await?;
    extract_tarball(&staging, &bin_dir, &app)?;

    let _ = fs::remove_file(&staging);

    let bin_path = bin_dir.join("agentboster-cli");
    if !bin_path.exists() {
        return Err(format!(
            "Extraction completed but {} is missing. The tarball may have an unexpected layout.",
            bin_path.display()
        ));
    }

    // The packaging script ships a POSIX shell wrapper
    // (`#!/bin/sh ... exec node agentboster-cli.cjs`). That wrapper works on
    // macOS/Linux, but Windows can't execute `#!/bin/sh`. Synthesize a
    // `agentboster-cli.cmd` shim next to the .cjs so Windows discovery finds
    // an executable that actually runs.
    #[cfg(target_os = "windows")]
    let bin_path = {
        let cjs_path = bin_dir.join("agentboster-cli.cjs");
        let cmd_path = bin_dir.join("agentboster-cli.cmd");
        if !cjs_path.is_file() {
            return Err(format!("Missing {}", cjs_path.display()));
        }
        let cmd_body = format!("@echo off\r\nnode \"%~dp0agentboster-cli.cjs\" %*\r\n");
        fs::write(&cmd_path, cmd_body)
            .map_err(|e| format!("Failed to write {}: {}", cmd_path.display(), e))?;
        cmd_path
    };

    emit_progress(
        &app,
        "done",
        None,
        Some(format!("Installed agentboster-cli {}", release.tag_name)),
    );

    Ok(InstallResult {
        bin_path: bin_path.to_string_lossy().into_owned(),
        version: release.tag_name,
    })
}

/// Discover the pi binary. Strategy:
/// 1. If pi_path is provided (Desktop manual override), use it
/// 2. If cli_path is provided (dev mode), use node + script or explicit binary
/// 3. Try explicit env override (AGENTBOSTER_DESKTOP_BIN_PATH / AGENTBOSTER_CLI_PATH / legacy PI_DESKTOP_PI_PATH / PI_CLI_PATH)
/// 4. Try sidecar discovery (packaged app)
/// 5. Try finding `pi` on PATH (globally installed CLI or standalone binary)
/// 6. Try common install locations (for GUI app launches without shell PATH)
/// 7. Fail with actionable error
fn discover_pi(app: &AppHandle, options: &RpcStartOptions) -> Result<PiProcess, String> {
    // Desktop manual override from settings
    if let Some(ref pi_path) = options.pi_path {
        let trimmed = pi_path.trim();
        if !trimmed.is_empty() {
            if let Some(path) = resolve_explicit_pi_path(trimmed) {
                return Ok(PiProcess::PathBinary { path });
            }
            return Err(missing_pi_cli_error(Some(format!(
                "Configured pi binary path was not found: {}",
                trimmed
            ))));
        }
    }

    // Dev mode: cli_path explicitly provided
    if let Some(ref cli_path) = options.cli_path {
        let trimmed = cli_path.trim();
        if !trimmed.is_empty() {
            if trimmed.ends_with(".js") || trimmed.ends_with(".mjs") || trimmed.ends_with(".cjs") {
                return Ok(PiProcess::DevNode {
                    script: trimmed.to_string(),
                });
            }
            if let Some(path) = resolve_explicit_pi_path(trimmed) {
                return Ok(PiProcess::PathBinary { path });
            }
        }
    }

    // Explicit environment override
    if let Some(path) = discover_pi_from_env_override() {
        return Ok(PiProcess::PathBinary { path });
    }

    // Packaged app: bundled sidecar
    if let Some(path) = discover_sidecar(app) {
        return Ok(PiProcess::SidecarBinary { path });
    }

    // Fallback: pi on PATH
    if let Ok(path) = which::which("agentboster-cli") {
        return Ok(PiProcess::PathBinary { path });
    }

    // GUI launches on macOS often don't inherit shell PATH (e.g. nvm-managed node/npm bins)
    if let Some(path) = discover_pi_from_common_locations() {
        return Ok(PiProcess::PathBinary { path });
    }

    Err(missing_pi_cli_error(None))
}

/// Build a Command for the discovered pi process
fn build_command(pi: &PiProcess, options: &RpcStartOptions) -> Command {
    let mut cmd = match pi {
        PiProcess::DevNode { script } => {
            let mut c = Command::new("node");
            c.arg(script);
            c
        }
        PiProcess::SidecarBinary { path } | PiProcess::PathBinary { path } => Command::new(path),
    };

    cmd.arg("--mode").arg("rpc");

    if let Some(ref provider) = options.provider {
        cmd.arg("--provider").arg(provider);
    }
    if let Some(ref model) = options.model {
        cmd.arg("--model").arg(model);
    }
    // Forward Web session identity so the CLI can register itself online
    // with the Web backend. Without this, Web-side `computer-use-remote`
    // can't dispatch to a Desktop-spawned CLI (silent capability gap).
    // Named `--web-session-id` (not `--session-id`) because the CLI
    // already has a `--session-id` flag for chat history sessions.
    if let Some(ref backend_url) = options.backend_url
        && let Some(ref session_id) = options.session_id
    {
        cmd.arg("--backend-url").arg(backend_url);
        cmd.arg("--web-session-id").arg(session_id);
    }

    cmd.current_dir(&options.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Merge environment variables
    if let Some(ref env) = options.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    // If using a script-based pi binary (e.g. npm global install), ensure its bin dir
    // is on PATH so shebangs like `#!/usr/bin/env node` can resolve node in GUI launches.
    if let PiProcess::PathBinary { path } = pi
        && let Some(parent) = path.parent()
    {
        prepend_bin_dir_to_path(&mut cmd, parent);
    }

    // On Windows, prevent console window from appearing
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

fn write_rpc_line(stdin: &mut std::process::ChildStdin, line: &str) -> Result<(), String> {
    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    stdin
        .write_all(b"\n")
        .map_err(|e| format!("Failed to write newline: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;
    Ok(())
}

/// Start the pi coding agent in RPC mode as a child process.
/// Discovery order: manual pi_path -> dev cli_path -> env override -> sidecar -> PATH/common locations -> error.
#[tauri::command]
async fn rpc_start(
    app: AppHandle,
    state: tauri::State<'_, RpcState>,
    options: RpcStartOptions,
    instance_id: Option<String>,
) -> Result<RpcStartResult, String> {
    let instance_id = normalize_instance_id(instance_id);

    let generation = if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            let next_generation = handle.generation.saturating_add(1).max(1);
            stop_rpc_instance(handle);
            next_generation
        } else {
            1
        }
    } else {
        return Err("Failed to acquire RPC instances lock".to_string());
    };

    let cwd_path = Path::new(&options.cwd);
    if !cwd_path.is_dir() {
        return Err(format!("Working directory does not exist: {}", options.cwd));
    }

    let pi = discover_pi(&app, &options)?;
    let discovery_label = format!("{:?}", pi);

    let mut cmd = build_command(&pi, &options);

    if let Some(mcp_path) = discover_mcp_binary(&app) {
        cmd.env("COMPUTER_USE_MCP_PATH", &mcp_path);
    }

    // Forward screenshot-format settings to the CLI (and from there to the
    // computer-use-mcp subprocess) so the user's choice in the Settings
    // panel is honored as the per-session default for `screenshot` calls.
    // We read from the on-disk settings.json (sync, locked) rather than
    // going through the renderer's IPC, because the spawn happens in the
    // RPC bootstrap path before any settings have necessarily been pushed.
    if let Some((fmt, q)) = read_screenshot_settings_sync() {
        cmd.env("COMPUTER_USE_SCREENSHOT_FORMAT", &fmt);
        cmd.env("COMPUTER_USE_SCREENSHOT_QUALITY", q.to_string());
    }

    let mut child = cmd.spawn().map_err(|e| {
        let lower = e.to_string().to_lowercase();
        let missing_executable = matches!(e.raw_os_error(), Some(2) | Some(3))
            || e.kind() == std::io::ErrorKind::NotFound
            || (lower.contains("createprocess") && lower.contains("cannot find"));
        if missing_executable {
            return missing_pi_cli_error(Some(format!(
                "Discovery details: {:?}\nSpawn error: {}",
                pi, e
            )));
        }
        format!("Failed to spawn pi process ({:?}): {}", pi, e)
    })?;

    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;

    // Store process + stdin handle for this instance
    if let Ok(mut instances) = state.instances.lock() {
        instances.insert(
            instance_id.clone(),
            RpcProcessHandle {
                generation,
                process: Some(child),
                stdin_writer: Some(stdin),
            },
        );
    } else {
        return Err("Failed to acquire RPC instances lock".to_string());
    }

    // Spawn thread to read stdout and emit events to frontend
    let app_handle = app.clone();
    let stdout_instance_id = instance_id.clone();
    let stdout_generation = generation;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let payload = RpcLineEventPayload {
                        instance_id: stdout_instance_id.clone(),
                        generation: stdout_generation,
                        line,
                    };
                    let _ = app_handle.emit("rpc-event", payload);
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit(
            "rpc-closed",
            RpcClosedEventPayload {
                instance_id: stdout_instance_id,
                generation: stdout_generation,
                reason: "process exited".to_string(),
            },
        );
    });

    // Spawn thread to read stderr
    let app_handle_err = app.clone();
    let stderr_instance_id = instance_id.clone();
    let stderr_generation = generation;
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    let payload = RpcLineEventPayload {
                        instance_id: stderr_instance_id.clone(),
                        generation: stderr_generation,
                        line,
                    };
                    let _ = app_handle_err.emit("rpc-stderr", payload);
                }
                Err(_) => break,
            }
        }
    });

    Ok(RpcStartResult {
        discovery: format!("{} [instance:{}]", discovery_label, instance_id),
        generation,
    })
}

/// Send a JSON command to an RPC process stdin
#[tauri::command]
async fn rpc_send(
    state: tauri::State<'_, RpcState>,
    command: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut stdin) = handle.stdin_writer {
                write_rpc_line(stdin, &command)
            } else {
                Err(format!(
                    "RPC process not started for instance '{}'",
                    instance_id
                ))
            }
        } else {
            Err(format!(
                "RPC process not started for instance '{}'",
                instance_id
            ))
        }
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Stop an RPC process instance
#[tauri::command]
async fn rpc_stop(
    state: tauri::State<'_, RpcState>,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(mut handle) = instances.remove(&instance_id) {
            stop_rpc_instance(&mut handle);
        }
        Ok(())
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Stop all RPC process instances
#[tauri::command]
async fn rpc_stop_all(state: tauri::State<'_, RpcState>) -> Result<(), String> {
    if let Ok(mut instances) = state.instances.lock() {
        for (_, mut handle) in instances.drain() {
            stop_rpc_instance(&mut handle);
        }
        Ok(())
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Check if an RPC process instance is running
#[tauri::command]
async fn rpc_is_running(
    state: tauri::State<'_, RpcState>,
    instance_id: Option<String>,
) -> Result<bool, String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut child) = handle.process {
                match child.try_wait() {
                    Ok(None) => Ok(true),
                    Ok(Some(_)) => {
                        handle.process = None;
                        handle.stdin_writer = None;
                        Ok(false)
                    }
                    Err(_) => Ok(false),
                }
            } else {
                Ok(false)
            }
        } else {
            Ok(false)
        }
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Send a response to an extension UI dialog request
#[tauri::command]
async fn rpc_ui_response(
    state: tauri::State<'_, RpcState>,
    response: String,
    instance_id: Option<String>,
) -> Result<(), String> {
    let instance_id = normalize_instance_id(instance_id);
    if let Ok(mut instances) = state.instances.lock() {
        if let Some(handle) = instances.get_mut(&instance_id) {
            if let Some(ref mut stdin) = handle.stdin_writer {
                write_rpc_line(stdin, &response)
            } else {
                Err(format!(
                    "RPC process not started for instance '{}'",
                    instance_id
                ))
            }
        } else {
            Err(format!(
                "RPC process not started for instance '{}'",
                instance_id
            ))
        }
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Settings structure
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub theme: String,
    pub thinking_level: String,
    pub auto_compaction: bool,
    pub auto_retry: bool,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub client_spoof: String,
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub pi_path: Option<String>,
    /// What happens when the user clicks the window close button.
    ///   - `"ask"`: pop a dialog the first time, then remember the choice
    ///   - `"tray"`: hide to tray, keep the app running
    ///   - `"quit"`: quit the app
    ///
    /// Any other value is treated as `"ask"`.
    pub close_action: String,
    /// Default output format for computer-use screenshots spawned via the
    /// `computer-use-mcp` binary. Forwarded to the MCP server as the env
    /// var `COMPUTER_USE_SCREENSHOT_FORMAT`. `"jpeg"` (default) is 5-10x
    /// smaller than PNG at q80 with negligible vision-model recognition
    /// loss; `"png"` is lossless.
    pub screenshot_format: String,
    /// JPEG quality 1-100 for computer-use screenshots. Ignored when
    /// `screenshot_format == "png"`. Forwarded as
    /// `COMPUTER_USE_SCREENSHOT_QUALITY`. Default 80.
    pub screenshot_quality: i64,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".to_string(),
            thinking_level: "medium".to_string(),
            auto_compaction: true,
            auto_retry: true,
            steering_mode: "one-at-a-time".to_string(),
            follow_up_mode: "one-at-a-time".to_string(),
            client_spoof: "off".to_string(),
            model_provider: None,
            model_id: None,
            pi_path: None,
            close_action: "ask".to_string(),
            screenshot_format: "jpeg".to_string(),
            screenshot_quality: 80,
        }
    }
}

/// Normalized close-action enum resolved from the persisted string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseAction {
    Ask,
    Tray,
    Quit,
}

impl CloseAction {
    fn from_settings(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "tray" | "minimize" | "background" => CloseAction::Tray,
            "quit" | "exit" => CloseAction::Quit,
            _ => CloseAction::Ask,
        }
    }
}

/// Sync read of `close_action` from disk. Used on the close-request hot path
/// where we can't await an IPC round-trip to the frontend.
fn load_close_action_sync() -> CloseAction {
    let Ok(dir) = desktop_config_dir() else {
        return CloseAction::Ask;
    };
    let path = dir.join("settings.json");
    let Ok(content) = fs::read_to_string(&path) else {
        return CloseAction::Ask;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return CloseAction::Ask;
    };
    match value.get("close_action").and_then(|v| v.as_str()) {
        Some(s) => CloseAction::from_settings(s),
        None => CloseAction::Ask,
    }
}

/// Sync read of screenshot format/quality from disk. Used on the CLI
/// spawn path so the computer-use-mcp subprocess inherits the user's
/// Settings panel choice without an IPC round-trip to the renderer.
/// Returns None if either field is missing or unparsable — callers
/// fall back to the MCP server's built-in defaults (jpeg q80).
fn read_screenshot_settings_sync() -> Option<(String, i64)> {
    let dir = desktop_config_dir().ok()?;
    let path = dir.join("settings.json");
    let content = fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let fmt = value
        .get("screenshot_format")
        .and_then(|v| v.as_str())
        .filter(|s| *s == "png" || *s == "jpeg")?;
    let q = value.get("screenshot_quality").and_then(|v| v.as_i64())?;
    Some((fmt.to_string(), q))
}

/// Process-wide lock serializing all read-modify-write cycles against
/// settings.json. Without this, `persist_close_action_sync` (fired from
/// the close dialog) and `save_settings` (fired from the renderer's
/// periodic save) can interleave and clobber each other. Atomic rename
/// alone doesn't help because each side reads-then-writes the whole
/// object; the lock makes the entire RMW atomic.
fn settings_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Atomically write `path` by writing to `<path>.tmp.<pid>` then
/// renaming. Returns the underlying IO error if either step fails.
/// Callers must hold `settings_lock()` for RMW sequences — atomic
/// rename alone does not prevent last-writer-wins data loss when
/// two writers each read the same base, mutate, and write back.
fn atomic_write(path: &Path, contents: &str) -> std::io::Result<()> {
    let dir = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp.{}",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("settings.json"),
        std::process::id(),
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        // Best-effort fsync so a crash immediately after the rename
        // doesn't leave an empty file on disk. Ignore errors on
        // platforms that don't support it.
        let _ = f.sync_all();
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Persist `close_action` without touching any other settings field. Used
/// when the user picks "Always tray" / "Always quit" from the first-close
/// dialog so the choice survives restarts even if the renderer hasn't saved
/// its full settings blob yet.
fn persist_close_action_sync(action: CloseAction) -> Result<(), String> {
    let dir = desktop_config_dir()?;
    let path = dir.join("settings.json");
    // Take the lock for the whole RMW; ignore poisoning since a panicked
    // writer still leaves a valid (if stale) file on disk.
    let _guard = settings_lock()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    let mut root: serde_json::Value = match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().unwrap();
    let label = match action {
        CloseAction::Tray => "tray",
        CloseAction::Quit => "quit",
        CloseAction::Ask => "ask",
    };
    obj.insert("close_action".to_string(), serde_json::json!(label));
    atomic_write(
        &path,
        serde_json::to_string_pretty(&root)
            .unwrap_or_default()
            .as_str(),
    )
    .map_err(|e| format!("Failed to persist close action: {}", e))
}

fn desktop_config_dir() -> Result<PathBuf, String> {
    let home =
        resolve_home_dir().ok_or_else(|| "Could not resolve $HOME / USERPROFILE".to_string())?;
    if cfg!(target_os = "macos") {
        Ok(home
            .join("Library")
            .join("Application Support")
            .join("agentboster-desktop"))
    } else if cfg!(target_os = "windows") {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            Ok(PathBuf::from(local).join("agentboster-desktop"))
        } else {
            Ok(home
                .join("AppData")
                .join("Local")
                .join("agentboster-desktop"))
        }
    } else {
        Ok(home.join(".config").join("agentboster-desktop"))
    }
}

/// Save app settings
#[tauri::command]
async fn save_settings(_app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let data_dir = desktop_config_dir()?;

    // Ensure directory exists
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    let settings_path = data_dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    // Take the lock + do an atomic rename so a concurrent
    // `persist_close_action_sync` (close dialog) can't clobber this
    // write, and a crash mid-write can't leave a truncated file.
    let _guard = settings_lock()
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    atomic_write(&settings_path, &json).map_err(|e| format!("Failed to write settings: {}", e))
}

/// Load app settings
#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let data_dir = desktop_config_dir()?;
    let settings_path = data_dir.join("settings.json");

    if !settings_path.exists() {
        // Migrate from legacy Tauri app_data_dir if available
        if let Ok(legacy_dir) = app.path().app_data_dir() {
            let legacy_path = legacy_dir.join("settings.json");
            if legacy_path.exists() {
                let content = fs::read_to_string(&legacy_path)
                    .map_err(|e| format!("Failed to read legacy settings: {}", e))?;
                let settings: AppSettings = serde_json::from_str(&content)
                    .map_err(|e| format!("Failed to parse legacy settings: {}", e))?;
                fs::create_dir_all(&data_dir)
                    .map_err(|e| format!("Failed to create settings directory: {}", e))?;
                let serialized = serde_json::to_string_pretty(&settings)
                    .map_err(|e| format!("Failed to serialize settings: {}", e))?;
                fs::write(&settings_path, serialized)
                    .map_err(|e| format!("Failed to migrate settings: {}", e))?;
                return Ok(settings);
            }
        }
        return Ok(AppSettings::default());
    }

    let content =
        fs::read_to_string(settings_path).map_err(|e| format!("Failed to read settings: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))
}

/// Open a file dialog and return the selected path
#[tauri::command]
async fn open_file_dialog(_app: AppHandle, _multiple: bool) -> Result<Vec<String>, String> {
    // Placeholder: frontend currently uses @tauri-apps/plugin-dialog directly.
    Ok(Vec::new())
}

#[derive(Debug, Deserialize)]
struct PiCliCommandOptions {
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    cli_path: Option<String>,
    pi_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct PiCliCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
    discovery: String,
}

#[derive(Debug, Deserialize)]
struct GitCommandOptions {
    args: Vec<String>,
    cwd: Option<String>,
}

#[derive(Debug, Serialize)]
struct GitCommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Debug, Serialize)]
struct DesktopRuntimeInfo {
    platform: String,
    arch: String,
    version: String,
}

fn build_plain_command(pi: &PiProcess, options: &PiCliCommandOptions) -> Command {
    let mut cmd = match pi {
        PiProcess::DevNode { script } => {
            let mut c = Command::new("node");
            c.arg(script);
            c
        }
        PiProcess::SidecarBinary { path } | PiProcess::PathBinary { path } => Command::new(path),
    };

    for arg in &options.args {
        cmd.arg(arg);
    }

    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(env) = &options.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    if let PiProcess::PathBinary { path } = pi
        && let Some(parent) = path.parent()
    {
        prepend_bin_dir_to_path(&mut cmd, parent);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    cmd
}

/// Run a regular pi CLI command (e.g. package operations: list/install/remove/update)
#[tauri::command]
async fn run_pi_cli_command(
    app: AppHandle,
    options: PiCliCommandOptions,
) -> Result<PiCliCommandResult, String> {
    if options.args.is_empty() {
        return Err("No command arguments provided".to_string());
    }

    let resolved_cwd = options.cwd.clone().unwrap_or_else(|| ".".to_string());
    if !Path::new(&resolved_cwd).is_dir() {
        return Err(format!(
            "Working directory does not exist: {}",
            resolved_cwd
        ));
    }

    let discovery_opts = RpcStartOptions {
        cli_path: options.cli_path.clone(),
        pi_path: options.pi_path.clone(),
        cwd: resolved_cwd,
        provider: None,
        model: None,
        env: options.env.clone(),
        session_id: None,
        backend_url: None,
    };

    let pi = discover_pi(&app, &discovery_opts)?;
    let discovery_label = format!("{:?}", pi);

    let output = build_plain_command(&pi, &options)
        .output()
        .map_err(|e| format!("Failed to run pi command ({:?}): {}", pi, e))?;

    Ok(PiCliCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
        discovery: discovery_label,
    })
}

#[tauri::command]
async fn run_git_command(options: GitCommandOptions) -> Result<GitCommandResult, String> {
    if options.args.is_empty() {
        return Err("No git command arguments provided".to_string());
    }

    let git_path = which::which("git").map_err(|_| "git was not found on PATH".to_string())?;

    let mut cmd = Command::new(git_path);
    cmd.args(&options.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cwd) = options.cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git command: {}", e))?;

    Ok(GitCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
async fn get_desktop_runtime_info(app: AppHandle) -> Result<DesktopRuntimeInfo, String> {
    Ok(DesktopRuntimeInfo {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
async fn open_path_in_default_app(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No path provided".to_string());
    }

    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", trimmed));
    }

    #[cfg(target_os = "macos")]
    {
        let primary = Command::new("open")
            .arg(&target)
            .output()
            .map_err(|e| format!("Failed to launch open command: {}", e))?;

        if primary.status.success() {
            return Ok(());
        }

        // Some files (e.g. .sample hooks in .git) have no associated app.
        // Fall back to TextEdit so "Open in editor" still works.
        let fallback = Command::new("open")
            .arg("-a")
            .arg("TextEdit")
            .arg(&target)
            .output()
            .map_err(|e| format!("Failed to launch TextEdit fallback: {}", e))?;

        if fallback.status.success() {
            return Ok(());
        }

        let primary_stderr = String::from_utf8_lossy(&primary.stderr).trim().to_string();
        let fallback_stderr = String::from_utf8_lossy(&fallback.stderr).trim().to_string();
        return Err(format!(
            "Could not open file. default-app error: {} | TextEdit fallback error: {}",
            if primary_stderr.is_empty() {
                format!("exit code {}", primary.status.code().unwrap_or(-1))
            } else {
                primary_stderr
            },
            if fallback_stderr.is_empty() {
                format!("exit code {}", fallback.status.code().unwrap_or(-1))
            } else {
                fallback_stderr
            }
        ));
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("xdg-open")
            .arg(&target)
            .output()
            .map_err(|e| format!("Failed to launch xdg-open command: {}", e))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Could not open file (exit code {})",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("Could not open file: {}", stderr)
        });
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(target.as_os_str())
            .output()
            .map_err(|e| format!("Failed to launch start command: {}", e))?;

        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Could not open file (exit code {})",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("Could not open file: {}", stderr)
        });
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform for open_path_in_default_app".to_string())
}

/// Build the tray context menu: Show / New Chat / --- / Quit.
/// `new_chat` and `show` are disabled when no main window is connected to
/// the renderer yet, but Tauri 2's menu API doesn't easily let us toggle
/// items at build time without holding MenuItem handles — so we keep it
/// simple and let the click handlers themselves decide what to do.
fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "tray-show", "Show Agentboster", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "tray-new-chat", "New Chat", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Agentboster", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &new_chat, &sep, &quit])
}

/// Show, focus, and un-minimize the main window. Restores taskbar/Dock
/// presence that `hide_main_window_to_tray` stripped.
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Dispatch a `tray-show` / `tray-new-chat` event to the renderer. The
/// renderer decides what "new chat" means (start a fresh session in the
/// current workspace, or open the project picker if none is active).
fn emit_tray_event(app: &AppHandle, name: &str) {
    let _ = app.emit(name, ());
}

/// Hide the main window to the tray. Also drops it from the taskbar /
/// macOS Dock via `set_skip_taskbar` so the app is truly backgrounded
/// until the user summons it back from the tray.
fn hide_main_window_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.set_skip_taskbar(true);
    }
}

/// Stop all RPC child processes and exit the app. Called from the tray
/// Quit item, from `RunEvent::ExitRequested`, and from the renderer when
/// the user picks "Quit" in the first-close dialog.
fn quit_app(app: &AppHandle) {
    // Drain RPC instances via the managed state, mirroring `rpc_stop_all`.
    if let Some(state) = app.try_state::<RpcState>()
        && let Ok(mut instances) = state.instances.lock()
    {
        for (_, mut handle) in instances.drain() {
            stop_rpc_instance(&mut handle);
        }
    }
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ =
                        window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
                    let _ = window.set_shadow(true);
                }
            }

            // Attach the tray icon + context menu. The `trayIcon` block in
            // tauri.conf.json already registers a `main-tray` instance at
            // build time, so reuse it via `tray_by_id` instead of building a
            // second one with the same id (which would otherwise panic or
            // create a duplicate icon depending on the Tauri version). If the
            // config-declared tray is ever removed, fall back to building it.
            let menu = build_tray_menu(app.handle())?;
            let existing = app.tray_by_id("main-tray");
            let tray = match existing {
                Some(tray) => {
                    tray.set_menu(Some(menu))?;
                    tray.set_tooltip(Some("Agentboster Desktop"))?;
                    tray.set_show_menu_on_left_click(false)?;
                    tray.on_menu_event(|app, event| handle_tray_menu_event(app, &event));
                    tray.on_tray_icon_event(|tray, event| {
                        handle_tray_icon_event(tray.app_handle(), &event);
                    });
                    // The config-declared tray uses `iconAsTemplate: false`
                    // already; keep its icon as-is (it loads iconPath from
                    // the bundle).
                    tray
                }
                None => {
                    let mut builder = TrayIconBuilder::with_id("main-tray")
                        .menu(&menu)
                        .show_menu_on_left_click(false)
                        .tooltip("Agentboster Desktop")
                        .on_menu_event(|app, event| handle_tray_menu_event(app, &event))
                        .on_tray_icon_event(|tray, event| {
                            handle_tray_icon_event(tray.app_handle(), &event);
                        });
                    if let Some(image) = app.default_window_icon() {
                        // `to_owned` promotes `Image<'a>` to `Image<'static>` so the
                        // builder doesn't borrow from `app`.
                        builder = builder.icon(image.to_owned());
                    }
                    builder.build(app)?
                }
            };
            let _ = tray;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray interception. We only care about the main window;
            // any auxiliary windows (none currently, but defensive) fall
            // through to default behavior.
            if window.label() != "main" {
                return;
            }
            // WindowEvent is #[non_exhaustive]; the wildcard arm is
            // intentionally omitted because clippy::single_match flags it
            // and we only care about CloseRequested here. Other variants
            // fall through to default Tauri behavior.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let action = load_close_action_sync();
                match action {
                    CloseAction::Tray => {
                        api.prevent_close();
                        hide_main_window_to_tray(window.app_handle());
                    }
                    CloseAction::Quit => {
                        // Allow the close to proceed; the last-window
                        // exit path drains RPC state in the RunEvent
                        // handler below.
                    }
                    CloseAction::Ask => {
                        // Prevent the close; the renderer will pop a
                        // dialog and call `resolve_close_action` once
                        // the user picks.
                        api.prevent_close();
                        let _ = window.app_handle().emit("close-requested", ());
                    }
                }
            }
        })
        .manage(RpcState::default())
        .invoke_handler(tauri::generate_handler![
            rpc_start,
            rpc_send,
            rpc_stop,
            rpc_stop_all,
            rpc_is_running,
            rpc_ui_response,
            install_cli,
            save_settings,
            load_settings,
            open_file_dialog,
            run_pi_cli_command,
            run_git_command,
            get_desktop_runtime_info,
            open_path_in_default_app,
            resolve_close_action,
            set_close_action,
            show_main_window_cmd,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // On the last window closing, Tauri wants to exit. We want the
            // app to keep running (so the tray can bring it back). When the
            // user actually asked to quit (via tray Quit or close_action=quit),
            // `quit_app` is invoked explicitly from those handlers — but
            // `close_action = "quit"` falls through here when the main window
            // closes. So we drain RPC state on every ExitRequested; harmless
            // when there's nothing to drain, essential when the user just
            // closed the window with quit semantics.
            if let RunEvent::ExitRequested { .. } = event
                && let Some(state) = app.try_state::<RpcState>()
                && let Ok(mut instances) = state.instances.lock()
            {
                for (_, mut handle) in instances.drain() {
                    stop_rpc_instance(&mut handle);
                }
            }
        });
}

fn handle_tray_menu_event(app: &AppHandle, event: &MenuEvent) {
    match event.id().as_ref() {
        "tray-show" => show_main_window(app),
        "tray-new-chat" => {
            // Bring the window forward first so the user can see the result
            // of the new-chat action, then ask the renderer to start one.
            show_main_window(app);
            emit_tray_event(app, "tray-new-chat");
        }
        "tray-quit" => quit_app(app),
        _ => {}
    }
}

fn handle_tray_icon_event(app: &AppHandle, event: &TrayIconEvent) {
    // Left-click toggles the main window (show if hidden, hide if visible).
    // Right-click falls through to the default behavior of showing the
    // context menu, which Tauri handles for us.
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        if let Some(window) = app.get_webview_window("main") {
            match window.is_visible() {
                Ok(true) => hide_main_window_to_tray(app),
                _ => show_main_window(app),
            }
        } else {
            show_main_window(app);
        }
    }
    // TrayIconEvent is #[non_exhaustive]; other variants (DoubleClick,
    // Enter, Move, Leave) are intentionally ignored, and future variants
    // fall through here too.
}

/// Renderer → main: the user answered the first-close dialog. `action` is
/// one of `"tray"` / `"quit"` / `"ask"` (ask = "ask again next time", i.e.
/// don't persist a choice). `remember` decides whether to persist.
#[tauri::command]
async fn resolve_close_action(
    app: AppHandle,
    action: String,
    remember: bool,
) -> Result<(), String> {
    let resolved = CloseAction::from_settings(&action);
    if remember && resolved != CloseAction::Ask {
        persist_close_action_sync(resolved)?;
    }

    match resolved {
        CloseAction::Tray => {
            hide_main_window_to_tray(&app);
        }
        CloseAction::Quit => {
            quit_app(&app);
        }
        CloseAction::Ask => {
            // User chose "ask again next time" but picked "hide for now"
            // from the dialog — just hide. The next close will ask again.
            // We infer intent from the action string: "ask-tray" means hide
            // this once without persisting; "ask-quit" means quit this once.
            match action.as_str() {
                "ask-tray" => hide_main_window_to_tray(&app),
                "ask-quit" => quit_app(&app),
                _ => {
                    // No-op: the dialog was dismissed (e.g. Esc). Keep the
                    // window open and let the user decide later.
                }
            }
        }
    }
    Ok(())
}

/// Renderer → main: settings panel changed the close_action preference.
#[tauri::command]
async fn set_close_action(action: String) -> Result<(), String> {
    let resolved = CloseAction::from_settings(&action);
    persist_close_action_sync(resolved)?;
    Ok(())
}

/// Renderer → main: explicitly show and focus the main window (used after
/// clicking the tray's "Show" entry when the window is hidden).
#[tauri::command]
async fn show_main_window_cmd(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}
