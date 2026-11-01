#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::create_dir_all;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WindowEvent,
};

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
                create_dir_all(&data_dir)?;
                let agent_script = resource_dir.join("agent.cjs");
                let web_dir = resource_dir.join("web");
                let child = Command::new("node")
                    .arg(agent_script)
                    .env("STUDIOOPS_ROOT", &resource_dir)
                    .env("STUDIOOPS_WEB_DIR", &web_dir)
                    .env("STUDIOOPS_DATA_DIR", &data_dir)
                    .env("STUDIOOPS_CONFIG", data_dir.join("services.yaml"))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?;
                app.manage(AgentProcess(Mutex::new(Some(child))));
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
