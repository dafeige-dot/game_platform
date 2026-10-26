mod commands;
mod config;
mod engine;
mod model;

use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let engine = Arc::new(engine::Engine::new(app.handle().clone()));
            engine.start_loop();
            app.manage(engine);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::download_action,
            commands::launch_app,
            commands::core_info,
            commands::refresh_catalog,
            commands::cas_selfinstall
        ])
        .run(tauri::generate_context!())
        .expect("failed to run STELLAR");
}
