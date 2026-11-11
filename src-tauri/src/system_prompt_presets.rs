use crate::paths::{atomic_write, get_base_dir};
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static STORE_LOCK: Mutex<()> = Mutex::new(());

// A null entry hides a preset supplied by the app or the legacy TXT file.
pub(crate) type PresetChanges = BTreeMap<String, Option<String>>;

fn preset_path() -> PathBuf {
    get_base_dir().join("system_prompt_presets.json")
}

fn read_presets(path: &Path) -> Result<PresetChanges, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(PresetChanges::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn update_presets(
    path: &Path,
    update: impl FnOnce(&mut PresetChanges),
) -> Result<PresetChanges, String> {
    let _guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    let mut presets = read_presets(path)?;
    update(&mut presets);
    let bytes = serde_json::to_vec_pretty(&presets).map_err(|error| error.to_string())?;
    atomic_write(path, &bytes)?;
    Ok(presets)
}

#[tauri::command]
pub(crate) fn load_system_prompt_presets() -> Result<PresetChanges, String> {
    let _guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    read_presets(&preset_path())
}

#[tauri::command]
pub(crate) fn save_system_prompt_preset(
    name: String,
    content: String,
) -> Result<PresetChanges, String> {
    if name.trim().is_empty() {
        return Err("Enter a preset name.".to_string());
    }
    update_presets(&preset_path(), |presets| {
        presets.insert(name, Some(content));
    })
}

#[tauri::command]
pub(crate) fn delete_system_prompt_preset(
    name: String,
    has_default: bool,
) -> Result<PresetChanges, String> {
    update_presets(&preset_path(), |presets| {
        if has_default {
            presets.insert(name, None);
        } else {
            presets.remove(&name);
        }
    })
}

#[tauri::command]
pub(crate) fn reset_system_prompt_presets() -> Result<(), String> {
    reset_presets(&preset_path())
}

fn reset_presets(path: &Path) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|error| error.to_string())?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_removes_preset_changes_and_preserves_the_txt_file() {
        let dir = std::env::temp_dir().join(format!("novelgen-presets-{}", uuid::Uuid::new_v4()));
        let presets = dir.join("system_prompt_presets.json");
        let legacy = dir.join("system_prompt.txt");
        let original = b"Original file prompt\r\n";
        atomic_write(&legacy, original).unwrap();

        update_presets(&presets, |changes| {
            changes.insert("New preset".to_string(), Some("Draft".to_string()));
            changes.insert("Hidden preset".to_string(), None);
        })
        .unwrap();
        update_presets(&presets, |changes| {
            changes.insert("New preset".to_string(), Some("Updated".to_string()));
        })
        .unwrap();
        let saved = read_presets(&presets).unwrap();
        assert_eq!(saved["New preset"].as_deref(), Some("Updated"));
        assert_eq!(saved["Hidden preset"], None);

        reset_presets(&presets).unwrap();
        reset_presets(&presets).unwrap();
        assert!(read_presets(&presets).unwrap().is_empty());
        assert_eq!(fs::read(&legacy).unwrap(), original);
        fs::remove_file(legacy).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
