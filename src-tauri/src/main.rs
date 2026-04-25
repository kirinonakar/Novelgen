#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod continuity_json;
mod generator;
mod paths;
mod plot_structure;
mod prompt_templates;

const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../prompts/system_prompt_default.txt");

use crate::paths::{
    get_base_dir, novel_metadata_filename, output_dir, output_json_dir, validate_novel_filename,
    validate_plot_filename,
};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{Manager, State};

pub struct AppState {
    pub stop_flag: Arc<AtomicBool>,
}

#[tauri::command]
fn stop_generation(state: State<'_, AppState>) {
    println!("[Backend] Stop requested");
    state.stop_flag.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn resume_generation(state: State<'_, AppState>) {
    println!("[Backend] Resume requested");
    state.stop_flag.store(false, Ordering::Relaxed);
}

#[tauri::command]
async fn fetch_models(api_base: String) -> Result<Vec<String>, String> {
    println!("[Backend] Fetching models from: {}", api_base);
    let res = generator::fetch_models_impl(&api_base).await;
    match &res {
        Ok(models) => println!("[Backend] Found {} models", models.len()),
        Err(e) => println!("[Backend] Fetch error: {}", e),
    }
    res
}

#[tauri::command]
async fn generate_seed(
    api_base: String,
    model_name: String,
    api_key: String,
    system_prompt: String,
    language: String,
    temperature: f32,
    top_p: f32,
    input_seed: String,
) -> Result<String, String> {
    generator::generate_seed_impl(
        &api_base,
        &model_name,
        &api_key,
        &system_prompt,
        &language,
        temperature,
        top_p,
        &input_seed,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct GenerationParams {
    api_base: String,
    model_name: String,
    api_key: String,
    system_prompt: String,
    prompt: String,
    temperature: f32,
    top_p: f32,
    repetition_penalty: f32,
    max_tokens: u32,
}

#[tauri::command]
async fn generate_plot(
    state: State<'_, AppState>,
    params: GenerationParams,
    on_event: Channel<generator::StreamEvent>,
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    generator::generate_plot_stream(
        &params.api_base,
        &params.model_name,
        &params.api_key,
        &params.system_prompt,
        &params.prompt,
        params.temperature,
        params.top_p,
        params.repetition_penalty,
        params.max_tokens,
        on_event,
        state.stop_flag.clone(),
    )
    .await
}

#[tauri::command]
async fn generate_novel(
    state: State<'_, AppState>,
    params: generator::NovelGenerationParams,
    on_event: Channel<generator::StreamEvent>,
) -> Result<generator::NovelGenerationResult, String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    generator::generate_novel_stream(params, on_event, state.stop_flag.clone()).await
}

#[tauri::command]
fn suggest_next_chapter(text: String, language: String, last_completed_ch: Option<u32>) -> u32 {
    generator::suggest_next_chapter(&text, &language, last_completed_ch)
}

#[tauri::command]
async fn chat_completion(
    api_base: String,
    model_name: String,
    api_key: String,
    system_prompt: String,
    prompt: String,
    temperature: f32,
    top_p: f32,
    max_tokens: u32,
    repetition_penalty: f32,
) -> Result<String, String> {
    generator::chat_completion(
        &api_base,
        &model_name,
        &api_key,
        &system_prompt,
        &prompt,
        temperature,
        top_p,
        max_tokens,
        repetition_penalty,
    )
    .await
}

#[tauri::command]
fn set_window_theme(app_handle: tauri::AppHandle, theme: String) -> Result<(), String> {
    let preferred_theme = match theme.to_ascii_lowercase().as_str() {
        "dark" => Some(tauri::utils::Theme::Dark),
        "light" => Some(tauri::utils::Theme::Light),
        "system" | "auto" => None,
        other => return Err(format!("Unsupported theme: {}", other)),
    };

    let main_window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    main_window
        .set_theme(preferred_theme)
        .map_err(|e| e.to_string())
}

// File System Commands
fn get_config_path(filename: &str) -> PathBuf {
    let base = get_base_dir();
    base.join(filename)
}

fn get_plot_dir() -> PathBuf {
    let base = get_base_dir();
    let mut path = base.clone();
    path.push("output");
    path.push("plot");
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    path
}

#[tauri::command]
fn save_plot(content: String, _language: String) -> Result<String, String> {
    let dir = get_plot_dir();

    let mut title = "untitled_plot".to_string();

    // Robust Title Extraction via Regex
    let re_title =
        regex::Regex::new(r"(?i)^[\s#*]*(?:1\.)?[\s*]*(?:제목|Title|タイトル)[\s*:\-]*(.*)$")
            .unwrap();

    let mut found = false;
    let lines: Vec<&str> = content.lines().collect();

    for i in 0..lines.len() {
        let line = lines[i].trim();

        if let Some(caps) = re_title.captures(line) {
            let mut t = caps
                .get(1)
                .map_or("", |m| m.as_str())
                .replace("*", "")
                .replace("#", "")
                .trim()
                .to_string();

            // If the title is on the next line
            if t.is_empty() {
                let mut j = i + 1;
                while j < lines.len() {
                    let next_line = lines[j].trim();
                    if !next_line.is_empty() {
                        t = next_line
                            .replace("*", "")
                            .replace("#", "")
                            .trim_start_matches(':')
                            .trim_start_matches('-')
                            .trim()
                            .to_string();
                        break;
                    }
                    j += 1;
                }
            }

            if !t.is_empty() {
                title = t;
                found = true;
                break;
            }
        }
    }

    // Fallback: use first non-empty line if no keyword found
    if !found {
        for line in content.lines() {
            let t = line.trim().replace("*", "").replace("#", "");
            if !t.is_empty() && t.len() < 100 {
                title = t.to_string();
                break;
            }
        }
    }

    let sanitize_re = regex::Regex::new(r#"[\\/*?:"<>|]"#).unwrap();
    let clean_name = sanitize_re.replace_all(&title, "").trim().replace(" ", "_");

    let now = chrono::Local::now();
    let date_prefix = now.format("%Y%m%d").to_string();

    let safe_name = if clean_name.is_empty() {
        format!("{}_untitled_plot.txt", date_prefix)
    } else {
        format!("{}_{}.txt", date_prefix, clean_name)
    };
    let path = dir.join(&safe_name);

    println!("[Backend] Saving plot to: {:?}", path);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(safe_name)
}

#[tauri::command]
fn get_saved_plots() -> Result<Vec<String>, String> {
    let dir = get_plot_dir();
    println!("[Backend] Scanning plots in: {:?}", dir);
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if validate_plot_filename(name).is_ok() {
                    files.push(name.to_string());
                }
            }
        }
    }
    files.sort_by(|a, b| b.cmp(a));
    Ok(files)
}

#[tauri::command]
fn load_plot(filename: String) -> Result<String, String> {
    let filename = validate_plot_filename(&filename)?;
    let path = get_plot_dir().join(filename);
    println!("[Backend] Loading plot from: {:?}", path);
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_output_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let base = get_base_dir();
    let mut path = base.clone();
    path.push("output");

    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }

    // Convert to absolute path to ensure opening works correctly
    let absolute_path = fs::canonicalize(&path).unwrap_or(path);
    let path_str = absolute_path.to_string_lossy().to_string();

    // Strip Windows UNC prefix (\\?\) which can cause Explorer UI glitches
    let clean_path = if path_str.starts_with(r"\\?\") {
        path_str[4..].to_string()
    } else {
        path_str
    };

    println!("[Backend] Opening output folder: {:?}", clean_path);
    app_handle
        .opener()
        .open_path(clean_path, None::<String>)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_system_prompt() -> Result<String, String> {
    let path = get_config_path("system_prompt.txt");
    println!("[Backend] Loading system prompt from: {:?}", path);

    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok(DEFAULT_SYSTEM_PROMPT.trim().to_string())
    }
}

#[tauri::command]
fn save_system_prompt(content: String) -> Result<String, String> {
    let path = get_config_path("system_prompt.txt");
    println!("[Backend] Saving system prompt to: {:?}", path);
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok("✅ Saved".to_string())
}
#[tauri::command]
fn load_api_key() -> Result<String, String> {
    let path = get_config_path("gemini.txt");
    println!("[Backend] Loading API key from: {:?}", path);

    if path.exists() {
        fs::read_to_string(path)
            .map(|s| s.trim().to_string())
            .map_err(|e| e.to_string())
    } else {
        Ok("".to_string())
    }
}

#[tauri::command]
fn save_novel_state(
    filename: String,
    text_content: String,
    metadata_json: String,
) -> Result<(), String> {
    let filename = validate_novel_filename(&filename)?;
    let dir = output_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let json_dir = output_json_dir();
    if !json_dir.exists() {
        fs::create_dir_all(&json_dir).map_err(|e| e.to_string())?;
    }

    let txt_path = dir.join(&filename);
    let json_path = json_dir.join(novel_metadata_filename(&filename));

    fs::write(&txt_path, text_content).map_err(|e| e.to_string())?;
    fs::write(&json_path, metadata_json).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn get_latest_novel_metadata() -> Result<Option<(String, String)>, String> {
    let dir = output_json_dir();
    if !dir.exists() {
        return get_latest_legacy_novel_metadata();
    }

    let mut files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("novel_") && name.ends_with(".json") {
                    files.push(name.to_string());
                }
            }
        }
    }

    files.sort_by_key(|f| {
        // Extract numeric parts including underscores for natural sorting
        let re = regex::Regex::new(r"novel_([\d_]+)").unwrap();
        re.captures(f)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', ""))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    });
    if let Some(latest) = files.last() {
        let json_path = dir.join(latest);
        let txt_name = latest.replace(".json", ".txt");
        if let Ok(content) = fs::read_to_string(json_path) {
            return Ok(Some((txt_name, content)));
        }
    }

    get_latest_legacy_novel_metadata()
}

fn get_latest_legacy_novel_metadata() -> Result<Option<(String, String)>, String> {
    let dir = output_dir();
    if !dir.exists() {
        return Ok(None);
    }

    let mut files: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("novel_") && name.ends_with(".json") {
                    files.push(name.to_string());
                }
            }
        }
    }

    files.sort_by_key(|f| {
        let re = regex::Regex::new(r"novel_([\d_]+)").unwrap();
        re.captures(f)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', ""))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    });

    if let Some(latest) = files.last() {
        let json_path = dir.join(latest);
        let txt_name = latest.replace(".json", ".txt");
        if let Ok(content) = fs::read_to_string(json_path) {
            return Ok(Some((txt_name, content)));
        }
    }

    Ok(None)
}

#[tauri::command]
fn get_saved_novels() -> Result<Vec<String>, String> {
    let base = get_base_dir();
    let dir = base.join("output");
    println!("[Backend] Scanning novels in: {:?}", dir);
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if validate_novel_filename(name).is_ok() {
                    files.push(name.to_string());
                }
            }
        }
    }
    // Sort reverse to show latest first using numeric key
    files.sort_by_key(|f| {
        let re = regex::Regex::new(r"novel_([\d_]+)").unwrap();
        let val = re
            .captures(f)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace('_', ""))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        std::cmp::Reverse(val)
    });
    Ok(files)
}

#[tauri::command]
fn load_novel(filename: String) -> Result<(String, String), String> {
    let filename = validate_novel_filename(&filename)?;
    let dir = output_dir();
    let txt_path = dir.join(&filename);
    let json_path = output_json_dir().join(novel_metadata_filename(&filename));
    let legacy_json_path = dir.join(novel_metadata_filename(&filename));

    println!("[Backend] Loading novel from: {:?}", txt_path);
    let txt_content = fs::read_to_string(txt_path).map_err(|e| e.to_string())?;

    let json_content = if json_path.exists() {
        fs::read_to_string(json_path).unwrap_or_default()
    } else if legacy_json_path.exists() {
        fs::read_to_string(legacy_json_path).unwrap_or_default()
    } else {
        String::new()
    };

    Ok((txt_content, json_content))
}

#[tauri::command]
fn get_next_novel_filename() -> Result<String, String> {
    Ok(generator::get_next_novel_filename())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            stop_flag: Arc::new(AtomicBool::new(false)),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_models,
            generate_seed,
            generate_plot,
            stop_generation,
            resume_generation,
            chat_completion,
            set_window_theme,
            save_plot,
            get_saved_plots,
            load_plot,
            open_output_folder,
            load_system_prompt,
            save_system_prompt,
            save_novel_state,
            get_latest_novel_metadata,
            get_next_novel_filename,
            load_api_key,
            generate_novel,
            suggest_next_chapter,
            get_saved_novels,
            load_novel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
