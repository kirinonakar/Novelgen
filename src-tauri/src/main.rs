#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod generator;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

pub struct AppState {
    pub stop_flag: Arc<AtomicBool>,
}

#[tauri::command]
fn stop_generation(state: State<'_, AppState>) {
    println!("[Backend] Stop requested");
    state.stop_flag.store(true, Ordering::Relaxed);
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
    api_base: String, model_name: String, api_key: String, system_prompt: String, 
    language: String, temperature: f32, top_p: f32
) -> Result<String, String> {
    generator::generate_seed_impl(&api_base, &model_name, &api_key, &system_prompt, &language, temperature, top_p).await
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
    max_tokens: u32
}

#[tauri::command]
async fn generate_plot(
    state: State<'_, AppState>,
    params: GenerationParams, 
    on_event: Channel<generator::StreamEvent>
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    generator::generate_plot_stream(
        &params.api_base, &params.model_name, &params.api_key, &params.system_prompt,
        &params.prompt, params.temperature, params.top_p, params.repetition_penalty, params.max_tokens, 
        on_event, state.stop_flag.clone()
    ).await
}

#[tauri::command]
async fn generate_novel(
    state: State<'_, AppState>,
    params: generator::NovelGenerationParams, 
    on_event: Channel<generator::StreamEvent>
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    generator::generate_novel_stream(params, on_event, state.stop_flag.clone()).await
}

#[tauri::command]
fn suggest_next_chapter(text: String, language: String) -> u32 {
    generator::suggest_next_chapter(&text, &language)
}

#[tauri::command]
async fn chat_completion(
    api_base: String, model_name: String, api_key: String, system_prompt: String, prompt: String,
    temperature: f32, top_p: f32, max_tokens: u32, repetition_penalty: f32
) -> Result<String, String> {
    generator::chat_completion(&api_base, &model_name, &api_key, &system_prompt, &prompt, temperature, top_p, max_tokens, repetition_penalty).await
}

// File System Commands
fn get_base_dir() -> PathBuf {
    // Priority 1: Current Working Directory (if we're in dev/debug mode)
    if let Ok(cwd) = std::env::current_dir() {
        // If current dir has tauri.conf.json or source files, it's likely the root
        if cwd.join("src-tauri").exists() || cwd.join("tauri.conf.json").exists() {
            return cwd;
        }
    }
    
    // Priority 2: Executable directory (for production/distribution)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.to_path_buf();
        }
    }
    
    // Priority 3: Fallback to current dir
    std::env::current_dir().unwrap_or_default()
}

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
fn save_plot(content: String, language: String) -> Result<String, String> {
    let dir = get_plot_dir();
    
    // Ported Title Extraction from app.py
    let mut title = "untitled_plot".to_string();
    
    // Robust Title Extraction
    let keywords = match language.as_str() {
        "Japanese" => vec!["タイトル", "1. タイトル", "1.タイトル"],
        "English" => vec!["Title", "1. Title", "1.Title"],
        _ => vec!["제목", "1. 제목", "1.제목"],
    };

    let mut found = false;
    let lines: Vec<&str> = content.lines().collect();
    for i in 0..lines.len() {
        let line = lines[i].trim();
        // Remove markdown formatting before checking keywords
        let clean_line = line.replace("*", "").replace("#", "").trim().to_string();
        
        for kw in &keywords {
            if clean_line.to_lowercase().starts_with(&kw.to_lowercase()) {
                // 1. Try to get title from the same line
                let mut t = clean_line[kw.len()..].trim()
                    .trim_start_matches(':').trim_start_matches('-').trim().to_string();
                
                // 2. If same line is empty, try the next non-empty line
                if t.is_empty() {
                    let mut j = i + 1;
                    while j < lines.len() {
                        let next_line = lines[j].trim();
                        if !next_line.is_empty() {
                            t = next_line.replace("*", "").replace("#", "")
                                .trim_start_matches(':').trim_start_matches('-').trim().to_string();
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
        if found { break; }
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
    
    let safe_name = if clean_name.is_empty() { "untitled_plot.txt".to_string() } else { format!("{}.txt", clean_name) };
    let path = dir.join(&safe_name);
    
    println!("[Backend] Saving plot to: {:?}", path);
    fs::write(&path, content).map_err(|e| e.to_string())?;
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
                if name.ends_with(".txt") {
                    files.push(name.to_string());
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[tauri::command]
fn load_plot(filename: String) -> Result<String, String> {
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
    app_handle.opener().open_path(clean_path, None::<String>).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_system_prompt() -> Result<String, String> {
    let path = get_config_path("system_prompt.txt");
    println!("[Backend] Loading system prompt from: {:?}", path);
    
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("You are a professional novelist. Write engaging and immersive stories.".to_string())
    }
}

#[tauri::command]
fn save_system_prompt(content: String) -> Result<String, String> {
    let path = get_config_path("system_prompt.txt");
    println!("[Backend] Saving system prompt to: {:?}", path);
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok("✅ System prompt saved successfully!".to_string())
}

#[tauri::command]
fn load_api_key() -> Result<String, String> {
    let path = get_config_path("gemini.txt");
    println!("[Backend] Loading API key from: {:?}", path);
    
    if path.exists() {
        fs::read_to_string(path).map(|s| s.trim().to_string()).map_err(|e| e.to_string())
    } else {
        Ok("".to_string())
    }
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    let path = get_config_path("gemini.txt");
    println!("[Backend] Saving API key to: {:?}", path);
    fs::write(path, key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_novel_state(filename: String, text_content: String, metadata_json: String) -> Result<(), String> {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    
    let txt_path = dir.join(&filename);
    let json_path = dir.join(filename.replace(".txt", ".json"));
    
    fs::write(&txt_path, text_content).map_err(|e| e.to_string())?;
    fs::write(&json_path, metadata_json).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn get_latest_novel_metadata() -> Result<Option<(String, String)>, String> {
    let base = get_base_dir();
    let mut dir = base.clone();
    dir.push("output");
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
    
    files.sort();
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
fn get_next_novel_filename() -> Result<String, String> {
    Ok(generator::get_next_novel_filename())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState { stop_flag: Arc::new(AtomicBool::new(false)) })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_models,
            generate_seed,
            generate_plot,
            stop_generation,
            chat_completion,
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
            save_api_key,
            generate_novel,
            suggest_next_chapter
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
