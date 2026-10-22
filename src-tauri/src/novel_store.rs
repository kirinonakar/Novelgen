//! A single atomic checkpoint is the commit record for the TXT/JSON pair.
//! Interrupted exports are repaired on load; completed exports remain externally editable.
use crate::paths::{novel_metadata_filename, output_dir, validate_novel_filename};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Checkpoint {
    text: String,
    metadata: String,
    #[serde(default)]
    exported: bool,
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
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

fn checkpoint_paths(dir: &Path, filename: &str) -> (PathBuf, PathBuf) {
    let root = dir.join(".checkpoints");
    (
        root.join(format!("{}.json", filename)),
        root.join(format!("{}.previous.json", filename)),
    )
}

fn read_checkpoint(path: &Path) -> Result<Checkpoint, String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let checkpoint: Checkpoint = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    validate_metadata(&checkpoint.metadata)?;
    Ok(checkpoint)
}

fn validate_metadata(metadata: &str) -> Result<(), String> {
    if !metadata.is_empty() {
        serde_json::from_str::<serde_json::Value>(metadata).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn read_legacy(dir: &Path, filename: &str) -> Result<Checkpoint, String> {
    let name = novel_metadata_filename(filename);
    let json = dir.join("json").join(&name);
    let legacy = dir.join(name);
    let metadata = if json.exists() {
        fs::read_to_string(json).map_err(|e| e.to_string())?
    } else if legacy.exists() {
        fs::read_to_string(legacy).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(Checkpoint {
        text: fs::read_to_string(dir.join(filename)).map_err(|e| e.to_string())?,
        metadata,
        exported: true,
    })
}

fn read_committed(dir: &Path, filename: &str) -> Result<Checkpoint, String> {
    let (current, previous) = checkpoint_paths(dir, filename);
    if current.exists() || previous.exists() {
        return match read_checkpoint(&current) {
            // Only a completed current checkpoint permits intentional external edits.
            Ok(checkpoint) if checkpoint.exported => read_legacy(dir, filename),
            Ok(checkpoint) => Ok(checkpoint),
            Err(current_error) => read_checkpoint(&previous)
                .map(|mut checkpoint| {
                    checkpoint.exported = false;
                    checkpoint
                })
                .map_err(|backup_error| {
                    format!("Cannot read checkpoint ({current_error}) or backup ({backup_error})")
                }),
        };
    }
    read_legacy(dir, filename)
}

fn project(dir: &Path, filename: &str, state: &Checkpoint) -> Result<(), String> {
    atomic_write(&dir.join(filename), state.text.as_bytes())?;
    atomic_write(
        &dir.join("json").join(novel_metadata_filename(filename)),
        state.metadata.as_bytes(),
    )
}

fn save_in(dir: &Path, filename: &str, state: &Checkpoint) -> Result<(), String> {
    validate_metadata(&state.metadata)?;
    let (current, previous) = checkpoint_paths(dir, filename);
    // Preserve the last valid pair before advancing the single commit record.
    if current.exists() || previous.exists() || dir.join(filename).exists() {
        let old = read_committed(dir, filename)?;
        validate_metadata(&old.metadata)?;
        atomic_write(
            &previous,
            &serde_json::to_vec(&old).map_err(|e| e.to_string())?,
        )?;
    }
    let mut pending = Checkpoint {
        text: state.text.clone(),
        metadata: state.metadata.clone(),
        exported: false,
    };
    atomic_write(
        &current,
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )?;
    project(dir, filename, state).map_err(|e| {
        format!("Checkpoint committed, but TXT/JSON export failed (load will repair it): {e}")
    })?;
    pending.exported = true;
    atomic_write(
        &current,
        &serde_json::to_vec(&pending).map_err(|e| e.to_string())?,
    )
}

pub fn save(filename: &str, text: &str, metadata: &str) -> Result<(), String> {
    let filename = validate_novel_filename(filename)?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    save_in(
        &output_dir(),
        &filename,
        &Checkpoint {
            text: text.into(),
            metadata: metadata.into(),
            exported: false,
        },
    )
}

pub fn save_text(filename: &str, text: &str) -> Result<(), String> {
    let filename = validate_novel_filename(filename)?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = output_dir();
    let (current, previous) = checkpoint_paths(&dir, &filename);
    let metadata = if current.exists() || previous.exists() || dir.join(&filename).exists() {
        read_committed(&dir, &filename)?.metadata
    } else {
        String::new()
    };
    save_in(
        &dir,
        &filename,
        &Checkpoint {
            text: text.into(),
            metadata,
            exported: false,
        },
    )
}

pub fn load(filename: &str) -> Result<(String, String), String> {
    let filename = validate_novel_filename(filename)?;
    let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
    load_in(&output_dir(), &filename)
}

fn load_in(dir: &Path, filename: &str) -> Result<(String, String), String> {
    let mut state = read_committed(dir, filename)?;
    if !state.exported {
        project(dir, filename, &state)?;
        state.exported = true;
        atomic_write(
            &checkpoint_paths(dir, filename).0,
            &serde_json::to_vec(&state).map_err(|e| e.to_string())?,
        )?;
    }
    Ok((state.text, state.metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn directory() -> Temp {
        Temp(std::env::temp_dir().join(format!("novel-store-test-{}", uuid::Uuid::new_v4())))
    }
    fn state(chapter: u32) -> Checkpoint {
        Checkpoint {
            text: format!("Chapter {chapter}"),
            metadata: format!(r#"{{"current_chapter":{chapter}}}"#),
            exported: false,
        }
    }

    #[test]
    fn interrupted_exports_load_one_committed_pair_and_keep_previous() {
        let dir = directory();
        let filename = "novel_test.txt";
        save_in(&dir.0, filename, &state(1)).unwrap();
        save_in(&dir.0, filename, &state(2)).unwrap();
        // Simulate termination after commit, before both exports and the completion marker.
        atomic_write(
            &checkpoint_paths(&dir.0, filename).0,
            &serde_json::to_vec(&state(2)).unwrap(),
        )
        .unwrap();
        fs::write(dir.0.join(filename), "torn text").unwrap();
        let loaded = read_committed(&dir.0, filename).unwrap();
        assert_eq!(loaded.text, state(2).text);
        assert_eq!(loaded.metadata, state(2).metadata);
        assert_eq!(load_in(&dir.0, filename).unwrap().0, state(2).text);
        assert_eq!(
            fs::read_to_string(dir.0.join(filename)).unwrap(),
            state(2).text
        );
        // Once repair completes, later manual edits remain visible.
        fs::write(dir.0.join(filename), "Manual edit after repair").unwrap();
        assert_eq!(
            load_in(&dir.0, filename).unwrap().0,
            "Manual edit after repair"
        );
        let backup = read_checkpoint(&checkpoint_paths(&dir.0, filename).1).unwrap();
        assert_eq!(backup.text, state(1).text);
        assert_eq!(backup.metadata, state(1).metadata);
    }

    #[test]
    fn corrupt_checkpoint_recovers_previous_pair() {
        let dir = directory();
        let filename = "novel_test.txt";
        save_in(&dir.0, filename, &state(1)).unwrap();
        save_in(&dir.0, filename, &state(2)).unwrap();
        fs::write(checkpoint_paths(&dir.0, filename).0, "{broken").unwrap();
        let recovered = read_committed(&dir.0, filename).unwrap();
        assert_eq!(recovered.text, state(1).text);
        assert_eq!(recovered.metadata, state(1).metadata);
        save_in(&dir.0, filename, &state(3)).unwrap();
        assert_eq!(
            read_committed(&dir.0, filename).unwrap().text,
            state(3).text
        );
    }

    #[test]
    fn failed_export_keeps_new_pair_recoverable_and_invalid_json_cannot_commit() {
        let dir = directory();
        let filename = "novel_test.txt";
        let json = dir.0.join("json").join(novel_metadata_filename(filename));
        fs::create_dir_all(&json).unwrap(); // Force the second export to fail on a new novel.
        assert!(save_in(&dir.0, filename, &state(2)).is_err());
        let loaded = read_committed(&dir.0, filename).unwrap();
        assert_eq!(loaded.text, state(2).text);
        assert_eq!(loaded.metadata, state(2).metadata);
        assert!(save_in(
            &dir.0,
            filename,
            &Checkpoint {
                text: "bad".into(),
                metadata: "{".into(),
                exported: false
            }
        )
        .is_err());
        assert_eq!(
            read_committed(&dir.0, filename).unwrap().text,
            state(2).text
        );
        fs::remove_dir(&json).unwrap();
        assert_eq!(
            load_in(&dir.0, filename).unwrap(),
            (state(2).text, state(2).metadata)
        );
    }

    #[test]
    fn completed_exports_preserve_external_edits_and_legacy_files_migrate() {
        let dir = directory();
        let filename = "novel_test.txt";
        project(&dir.0, filename, &state(1)).unwrap();
        save_in(&dir.0, filename, &state(2)).unwrap();
        fs::write(dir.0.join(filename), "Externally edited text").unwrap();
        assert_eq!(
            read_committed(&dir.0, filename).unwrap().text,
            "Externally edited text"
        );
        save_in(&dir.0, filename, &state(3)).unwrap();
        assert_eq!(
            read_checkpoint(&checkpoint_paths(&dir.0, filename).1)
                .unwrap()
                .text,
            "Externally edited text"
        );
    }
}
