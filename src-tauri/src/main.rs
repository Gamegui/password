// Препятствует появлению консольного окна в release-сборке на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    safekey_lib::run()
}
