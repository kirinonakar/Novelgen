use std::path::PathBuf;

pub fn get_base_dir() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("src-tauri").exists() || cwd.join("tauri.conf.json").exists() {
            return cwd;
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.to_path_buf();
        }
    }

    std::env::current_dir().unwrap_or_default()
}

pub fn output_dir() -> PathBuf {
    get_base_dir().join("output")
}

pub fn output_json_dir() -> PathBuf {
    output_dir().join("json")
}

pub fn novel_metadata_filename(novel_filename: &str) -> String {
    if let Some(stem) = novel_filename.strip_suffix(".txt") {
        format!("{}.json", stem)
    } else {
        format!("{}.json", novel_filename)
    }
}
