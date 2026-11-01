#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};

/// Initial config copied into the App data directory on first launch. It is only
/// a starting point; a user edited services.yaml is never overwritten.
#[cfg_attr(debug_assertions, allow(dead_code))]
const FIRST_RUN_CONFIG: &str = include_str!("../../../../config/services.first-run.yaml");

struct AgentProcess(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开 StudioOps", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 StudioOps", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let tray_icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;
            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .menu(&menu)
                .tooltip("StudioOps")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app.path().resource_dir()?;
                let data_dir = app.path().app_data_dir()?;
                let config_path = data_dir.join("services.yaml");

                if let Err(error) = seed_first_run_config(&data_dir, &config_path) {
                    append_agent_log(&data_dir, &format!("config setup failed: {error}"));
                }

                let child = if studioops_agent_running() {
                    append_agent_log(&data_dir, "reusing the agent already listening on 7227");
                    None
                } else if port_open() {
                    append_agent_log(
                        &data_dir,
                        "port 7227 is already in use by another process; not starting a second agent",
                    );
                    None
                } else {
                    match spawn_agent(&resource_dir, &data_dir, &config_path) {
                        Ok(child) => Some(child),
                        Err(error) => {
                            append_agent_log(&data_dir, &format!("agent failed to start: {error}"));
                            None
                        }
                    }
                };
                app.manage(AgentProcess(Mutex::new(child)));
            }
            #[cfg(debug_assertions)]
            app.manage(AgentProcess(Mutex::new(None)));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building StudioOps desktop")
        .run(|app_handle: &tauri::AppHandle, event: RunEvent| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AgentProcess>() {
                    if let Ok(mut process) = state.0.lock() {
                        if let Some(mut child) = process.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}

/// Copy the bundled template to the App data directory when no user config exists.
/// Uses create_new so an existing config (including one created at the same moment)
/// is never truncated.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn seed_first_run_config(data_dir: &Path, config_path: &Path) -> std::io::Result<()> {
    create_dir_all(data_dir)?;
    let body = FIRST_RUN_CONFIG.replace("{{UID}}", &current_uid());
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(config_path)
    {
        Ok(mut file) => file.write_all(body.as_bytes()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn current_uid() -> String {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|uid| uid.trim().to_string())
        .filter(|uid| !uid.is_empty())
        .unwrap_or_else(|| "501".to_string())
}

/// Resolve a Node binary without relying on the GUI app's minimal PATH.
/// Finder launches do not inherit the user's shell profile, so Homebrew and nvm
/// installations must be probed explicitly.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn resolve_node() -> PathBuf {
    if let Some(configured) = std::env::var_os("STUDIOOPS_NODE") {
        let configured = PathBuf::from(configured);
        if configured.is_file() {
            return configured;
        }
    }

    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("/usr/bin/node"),
    ];
    if let Some(home) = &home {
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".local/bin/node"));
        if let Some(nvm_node) = newest_nvm_node(home) {
            candidates.push(nvm_node);
        }
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn newest_nvm_node(home: &Path) -> Option<PathBuf> {
    let versions_dir = home.join(".nvm/versions/node");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(versions_dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .collect();
    versions.sort();
    versions
        .into_iter()
        .rev()
        .map(|version| version.join("bin/node"))
        .find(|node| node.is_file())
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn port_open() -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], 7227)),
        Duration::from_millis(300),
    )
    .is_ok()
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn studioops_agent_running() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], 7227)),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    if stream
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response.contains("studioops-agent")
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn spawn_agent(resource_dir: &Path, data_dir: &Path, config_path: &Path) -> std::io::Result<Child> {
    create_dir_all(data_dir)?;
    let agent_script = resource_dir.join("agent.cjs");
    let web_dir = resource_dir.join("web");
    let node = resolve_node();
    let node_dir = node.parent().unwrap_or(Path::new("/usr/bin"));
    let path = format!(
        "{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        node_dir.display()
    );
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("agent.log"))?;
    let stderr = log.try_clone()?;

    Command::new(node)
        .arg(agent_script)
        .env("STUDIOOPS_ROOT", resource_dir)
        .env("STUDIOOPS_WEB_DIR", &web_dir)
        .env("STUDIOOPS_DATA_DIR", data_dir)
        .env("STUDIOOPS_CONFIG", config_path)
        .env("STUDIOOPS_HOST", "127.0.0.1")
        .env("PATH", path)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr))
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_config_is_seeded_once_and_never_overwritten() {
        let unique = format!(
            "studioops-seed-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let dir = std::env::temp_dir().join(unique);
        let config = dir.join("services.yaml");
        create_dir_all(&dir).unwrap();

        seed_first_run_config(&dir, &config).unwrap();
        let seeded = std::fs::read_to_string(&config).unwrap();
        assert!(seeded.contains("services:"));
        assert!(seeded.contains("gui/"));
        assert!(!seeded.contains("{{UID}}"));

        std::fs::write(&config, "services: []\n").unwrap();
        seed_first_run_config(&dir, &config).unwrap();
        assert_eq!(
            std::fs::read_to_string(&config).unwrap(),
            "services: []\n",
            "an existing user config must not be overwritten"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn append_agent_log(data_dir: &Path, message: &str) {
    let _ = create_dir_all(data_dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("agent.log"))
    {
        let _ = writeln!(file, "[studioops] {message}");
    }
}
