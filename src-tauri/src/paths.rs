use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        // Same-directory rename replaces an existing file on Windows as well.
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

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

pub fn validate_filename(
    filename: &str,
    expected_extension: &str,
    required_prefix: Option<&str>,
) -> Result<String, String> {
    let filename = filename.trim();
    if filename.is_empty() {
        return Err("Filename cannot be empty.".to_string());
    }

    let path = Path::new(filename);
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(name)), None) if name.to_str() == Some(filename) => {}
        _ => {
            return Err("Invalid filename: path components are not allowed.".to_string());
        }
    }

    if let Some(prefix) = required_prefix {
        if !filename.starts_with(prefix) {
            return Err(format!("Invalid filename: expected prefix '{}'.", prefix));
        }
    }

    if !filename
        .to_ascii_lowercase()
        .ends_with(&expected_extension.to_ascii_lowercase())
    {
        return Err(format!(
            "Invalid filename: expected '{}' file.",
            expected_extension
        ));
    }

    Ok(filename.to_string())
}

pub fn validate_plot_filename(filename: &str) -> Result<String, String> {
    validate_filename(filename, ".txt", None)
}

pub fn validate_novel_filename(filename: &str) -> Result<String, String> {
    validate_filename(filename, ".txt", Some("novel_"))
}
