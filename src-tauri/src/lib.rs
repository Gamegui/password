// SafeKey — тонкая оболочка Tauri: всё приложение остаётся веб-кодом из src/,
// нативных команд не требуется (шифрование и синхронизация идут в Web View).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
