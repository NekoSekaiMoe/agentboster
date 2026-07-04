use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};

// GitHub releases feed for the CLI tarballs. The installer queries the
// `/releases/latest` endpoint at runtime to discover the current version
// (tag_name) and download URL, so Desktop never needs to be in lock-step
// with CLI releases.
const CLI_RELEASES_API: &str = "https://api.github.com/repos/anomalyco/agentboster/releases/latest";

 // Native computer-use commands (screenshots, input injection, AX tree).
 mod computer_use;

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
    handle.stdin_writer = None;
    if let Some(mut child) = handle.process.take() {
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
    let expected_name = format!("agentboster-{}{}", target, extension);

    let mut candidate_dirs: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidate_dirs.push(resource_dir.clone());
        candidate_dirs.push(resource_dir.join("binaries"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidate_dirs.push(parent.to_path_buf());
            candidate_dirs.push(parent.join("binaries"));
            candidate_dirs.push(parent.join(".."));
            candidate_dirs.push(parent.join("..").join("Resources"));
            candidate_dirs.push(parent.join("..").join("Resources").join("binaries"));
        }
    }

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
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        if !user_profile.trim().is_empty() {
            return Some(PathBuf::from(user_profile));
        }
    }
    None
}

fn expand_tilde_path(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if trimmed == "~" {
        if let Some(home) = resolve_home_dir() {
            return home;
        }
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = resolve_home_dir() {
            return home.join(rest);
        }
    }
    if let Some(rest) = trimmed.strip_prefix("~\\") {
        if let Some(home) = resolve_home_dir() {
            return home.join(rest);
        }
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
            candidates.push(app_data_dir.join("npm").join("agentboster.cmd"));
            candidates.push(app_data_dir.join("npm").join("agentboster.exe"));
            candidates.push(app_data_dir.join("npm").join("agentboster.bat"));
            candidates.push(app_data_dir.join("npm").join("agentboster"));
        }

        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local_app_data_dir = PathBuf::from(local_app_data);
            candidates.push(local_app_data_dir.join("npm").join("agentboster.cmd"));
            candidates.push(local_app_data_dir.join("npm").join("agentboster.exe"));
        }

        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_dir = PathBuf::from(user_profile);
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("agentboster.cmd"),
            );
            candidates.push(
                user_dir
                    .join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("agentboster.exe"),
            );
            candidates.push(user_dir.join("scoop").join("shims").join("agentboster.cmd"));
        }

        if let Ok(program_files) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("nodejs").join("agentboster.cmd"));
        }

        if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(program_files_x86).join("nodejs").join("agentboster.cmd"));
        }

        if let Ok(program_data) = std::env::var("ProgramData") {
            let program_data_dir = PathBuf::from(program_data);
            candidates.push(program_data_dir.join("npm").join("agentboster.cmd"));
            candidates.push(program_data_dir.join("npm").join("agentboster.exe"));
        }

        if let Ok(nvm_home) = std::env::var("NVM_HOME") {
            candidates.push(PathBuf::from(nvm_home).join("agentboster.cmd"));
        }

        if let Ok(nvm_symlink) = std::env::var("NVM_SYMLINK") {
            candidates.push(PathBuf::from(nvm_symlink).join("agentboster.cmd"));
        }

        // Auto-installed by `install_cli` (this Desktop app). The installer
        // writes agentboster.cmd next to the .cjs bundle here.
        if let Some(home_dir) = resolve_home_dir() {
            let installed_bin = home_dir.join(".agentboster").join("agent").join("bin");
            candidates.push(installed_bin.join("agentboster.cmd"));
            candidates.push(installed_bin.join("agentboster.exe"));
            candidates.push(installed_bin.join("agentboster"));
        }

        return candidates.into_iter().find(|candidate| candidate.is_file());
    }

    if let Some(home_dir) = resolve_home_dir() {
        // nvm installations (common for npm global installs)
        candidates.push(home_dir.join(".nvm/versions/node/current/bin/agentboster"));
        let nvm_versions_dir = home_dir.join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
            let mut version_dirs: Vec<PathBuf> = entries
                .filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if path.is_dir() {
                        Some(path)
                    } else {
                        None
                    }
                })
                .collect();
            version_dirs.sort_by(|a, b| b.cmp(a));
            for version_dir in version_dirs {
                candidates.push(version_dir.join("bin/agentboster"));
            }
        }

        // Other common per-user install locations
        candidates.push(home_dir.join(".agentboster/agent/bin/agentboster"));
        candidates.push(home_dir.join(".volta/bin/agentboster"));
        candidates.push(home_dir.join(".local/bin/agentboster"));
        candidates.push(home_dir.join(".npm-global/bin/agentboster"));
        candidates.push(home_dir.join(".npm/bin/agentboster"));
    }

    // npm custom prefix installs (common on Linux/macOS desktop launches)
    for key in ["NPM_CONFIG_PREFIX", "PREFIX"] {
        if let Ok(prefix) = std::env::var(key) {
            let trimmed = prefix.trim();
            if !trimmed.is_empty() {
                candidates.push(PathBuf::from(trimmed).join("bin/agentboster"));
                candidates.push(PathBuf::from(trimmed).join("agentboster"));
            }
        }
    }

    // Common system install locations
    candidates.push(PathBuf::from("/opt/homebrew/bin/agentboster"));
    candidates.push(PathBuf::from("/usr/local/bin/agentboster"));
    candidates.push(PathBuf::from("/usr/bin/agentboster"));

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
    for key in ["AGENTBOSTER_DESKTOP_BIN_PATH", "AGENTBOSTER_CLI_PATH", "PI_DESKTOP_PI_PATH", "PI_CLI_PATH"] {
        if let Ok(raw) = std::env::var(key) {
            if let Some(path) = resolve_explicit_pi_path(&raw) {
                return Some(path);
            }
        }
    }
    None
}

fn missing_pi_cli_error(additional: Option<String>) -> String {
    let mut message = String::from(
        "Could not find the agentboster CLI.\n\nInstall it by building subpackage/cli/ (see its README) and placing the `agentboster` binary on your PATH.\n\nThen restart the app.",
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
// per-user bin dir (`~/.agentboster/agent/bin/` — already on the
// discovery candidate list), and emits progress events to the frontend.
//
// The tarball layout (per `subpackage/cli/scripts/package.mjs`) is:
//   agentboster-cli-<tag>/
//     agentboster        # shell wrapper, execs node agentboster.cjs
//     agentboster.cjs    # single-file esbuild bundle
//
// After extraction we point Desktop at `<bin_dir>/agentboster` and let
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
    /// Absolute path to the installed `agentboster` entry script.
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
    emit_progress(app, "checking", None, Some("Looking up latest CLI release…".into()));
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
fn pick_tarball_asset<'a>(release: &'a GithubRelease) -> Result<&'a GithubAsset, String> {
    release
        .assets
        .iter()
        .find(|a| {
            a.name.ends_with(".tar.gz") && a.name.starts_with("agentboster-cli-")
        })
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
    let home = resolve_home_dir()
        .ok_or_else(|| "Could not resolve $HOME / USERPROFILE".to_string())?;
    Ok(home.join(".agentboster").join("agent").join("bin"))
}

/// Stream the asset to a temp file, emitting download progress events.
async fn download_tarball(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    app: &AppHandle,
) -> Result<(), String> {
    use futures_util::StreamExt;

    emit_progress(app, "downloading", Some(0.0), Some(format!("Fetching {}", url)));
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
                    if total > 0 { total.to_string() } else { "?".to_string() }
                )),
            );
            last_emit = std::time::Instant::now();
        }
    }

    file.flush().map_err(|e| format!("Failed flushing download: {}", e))?;
    emit_progress(app, "downloading", Some(1.0), None);
    Ok(())
}

/// Extract the tarball into the bin dir. The archive contains a single
/// top-level dir (`agentboster-cli-<tag>/`) with `agentboster` and
/// `agentboster.cjs`; we flatten that prefix so the files land directly
/// in `bin_dir/`. Existing files are overwritten.
fn extract_tarball(tarball: &Path, bin_dir: &Path, app: &AppHandle) -> Result<(), String> {
    emit_progress(app, "extracting", None, Some("Unpacking archive…".into()));
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("Failed to create {}: {}", bin_dir.display(), e))?;

    let f = fs::File::open(tarball)
        .map_err(|e| format!("Failed to open downloaded tarball: {}", e))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut archive = tar::Archive::new(gz);

    for entry in archive.entries().map_err(|e| format!("tar read error: {}", e))? {
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
        if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
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

fn emit_progress(
    app: &AppHandle,
    stage: &str,
    progress: Option<f64>,
    message: Option<String>,
) {
    let _ = app.emit(
        install_progress_event_name(),
        InstallProgressPayload {
            stage: stage.to_string(),
            progress,
            message,
        },
    );
}

/// Install the latest CLI release into `~/.agentboster/agent/bin/`.
/// Emits `cli-install-progress` events as it goes. Returns the path to
/// the installed `agentboster` entry script + the release tag.
#[tauri::command]
async fn install_cli(app: AppHandle) -> Result<InstallResult, String> {
    let client = http_client()?;
    let release = fetch_latest_release(&client, &app).await?;
    let asset = pick_tarball_asset(&release)?;

    let bin_dir = install_target_bin_dir()?;
    let staging = bin_dir.join(format!(".download-{}.tar.gz", release.tag_name));
    fs::create_dir_all(&staging.parent().unwrap_or(Path::new(".")))
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    // Best-effort cleanup of any previous half-finished download.
    let _ = fs::remove_file(&staging);

    download_tarball(&client, &asset.browser_download_url, &staging, &app).await?;
    extract_tarball(&staging, &bin_dir, &app).await?;

    let _ = fs::remove_file(&staging);

    let bin_path = bin_dir.join("agentboster");
    if !bin_path.exists() {
        return Err(format!(
            "Extraction completed but {} is missing. The tarball may have an unexpected layout.",
            bin_path.display()
        ));
    }

    // The packaging script ships a POSIX shell wrapper
    // (`#!/bin/sh ... exec node agentboster.cjs`). That wrapper works on
    // macOS/Linux, but Windows can't execute `#!/bin/sh`. Synthesize a
    // `agentboster.cmd` shim next to the .cjs so Windows discovery finds
    // an executable that actually runs.
    #[cfg(target_os = "windows")]
    {
        let cjs_path = bin_dir.join("agentboster.cjs");
        let cmd_path = bin_dir.join("agentboster.cmd");
        let cmd_body = format!(
            "@echo off\r\nnode \"%~dp0agentboster.cjs\" %*\r\n"
        );
        fs::write(&cmd_path, cmd_body)
            .map_err(|e| format!("Failed to write {}: {}", cmd_path.display(), e))?;
        let _ = cjs_path; // referenced for clarity
    }

    emit_progress(
        &app,
        "done",
        None,
        Some(format!("Installed agentboster CLI {}", release.tag_name)),
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
    if let Ok(path) = which::which("agentboster") {
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
    if let PiProcess::PathBinary { path } = pi {
        if let Some(parent) = path.parent() {
            prepend_bin_dir_to_path(&mut cmd, parent);
        }
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
                Err(format!("RPC process not started for instance '{}'", instance_id))
            }
        } else {
            Err(format!("RPC process not started for instance '{}'", instance_id))
        }
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

/// Stop an RPC process instance
#[tauri::command]
async fn rpc_stop(state: tauri::State<'_, RpcState>, instance_id: Option<String>) -> Result<(), String> {
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
async fn rpc_is_running(state: tauri::State<'_, RpcState>, instance_id: Option<String>) -> Result<bool, String> {
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
                Err(format!("RPC process not started for instance '{}'", instance_id))
            }
        } else {
            Err(format!("RPC process not started for instance '{}'", instance_id))
        }
    } else {
        Err("Failed to acquire RPC instances lock".to_string())
    }
}

fn get_pi_agent_dir() -> Option<PathBuf> {
    // Respect explicit env override first
    if let Ok(raw) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            if trimmed == "~" {
                return std::env::var_os("HOME")
                    .or(std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from);
            }
            if let Some(rest) = trimmed
                .strip_prefix("~/")
                .or_else(|| trimmed.strip_prefix("~\\"))
            {
                return std::env::var_os("HOME")
                    .or(std::env::var_os("USERPROFILE"))
                    .map(|home| PathBuf::from(home).join(rest));
            }
            return Some(PathBuf::from(trimmed));
        }
    }

    // Default: ~/.agentboster/agent
    std::env::var_os("HOME")
        .or(std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(".agentboster").join("agent"))
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
    pub model_provider: Option<String>,
    pub model_id: Option<String>,
    pub pi_path: Option<String>,
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
            model_provider: None,
            model_id: None,
            pi_path: None,
        }
    }
}

/// Save app settings
#[tauri::command]
async fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // Ensure directory exists
    fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    let settings_path = data_dir.join("settings.json");
    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    fs::write(settings_path, json).map_err(|e| format!("Failed to write settings: {}", e))
}

/// Load app settings
#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let settings_path = data_dir.join("settings.json");

    if !settings_path.exists() {
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

    if let PiProcess::PathBinary { path } = pi {
        if let Some(parent) = path.parent() {
            prepend_bin_dir_to_path(&mut cmd, parent);
        }
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
        return Err(format!("Working directory does not exist: {}", resolved_cwd));
    }

    let discovery_opts = RpcStartOptions {
        cli_path: options.cli_path.clone(),
        pi_path: options.pi_path.clone(),
        cwd: resolved_cwd,
        provider: None,
        model: None,
        env: options.env.clone(),
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
            format!("Could not open file (exit code {})", output.status.code().unwrap_or(-1))
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
            format!("Could not open file (exit code {})", output.status.code().unwrap_or(-1))
        } else {
            format!("Could not open file: {}", stderr)
        });
    }

    #[allow(unreachable_code)]
    Err("Unsupported platform for open_path_in_default_app".to_string())
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
                     let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
                     let _ = window.set_shadow(true);
                 }
             }
             Ok(())
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
             // computer-use commands
             computer_use::screenshot,
             computer_use::mouse_move,
             computer_use::mouse_click,
             computer_use::mouse_drag,
             computer_use::key_event,
             computer_use::type_text,
             computer_use::get_ax_at_point,
             computer_use::get_focused_ax,
         ])
         .run(tauri::generate_context!())
         .expect("error while running tauri application");
 }
