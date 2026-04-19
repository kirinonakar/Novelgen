#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod generator;

use std::fs;
use std::path::PathBuf;
use tauri::ipc::Channel;

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
async fn generate_plot(params: GenerationParams, on_event: Channel<generator::StreamEvent>) -> Result<(), String> {
    generator::generate_plot_stream(
        &params.api_base, &params.model_name, &params.api_key, &params.system_prompt,
        &params.prompt, params.temperature, params.top_p, params.repetition_penalty, params.max_tokens, on_event
    ).await
}

#[tauri::command]
async fn generate_novel(params: generator::NovelGenerationParams, on_event: Channel<generator::StreamEvent>) -> Result<(), String> {
    generator::generate_novel_stream(params, on_event).await
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
fn get_plot_dir() -> PathBuf {
    let mut path = std::env::current_dir().unwrap_or_default();
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
    let pattern_str = match language.as_str() {
        "Japanese" => r"(?i)(?:^|\n)#?\s*1\.\s*タイトル\s*[:\s]*(.*)",
        "English" => r"(?i)(?:^|\n)#?\s*1\.\s*Title\s*[:\s]*(.*)",
        _ => r"(?i)(?:^|\n)#?\s*1\.\s*제목\s*[:\s]*(.*)",
    };
    
    let re = regex::Regex::new(pattern_str).unwrap();
    if let Some(cap) = re.captures(&content) {
        if let Some(m) = cap.get(1) {
            title = m.as_str().trim().to_string();
        }
    }

    let sanitize_re = regex::Regex::new(r#"[\\/*?:"<>|]"#).unwrap();
    let clean_name = sanitize_re.replace_all(&title, "").trim().replace(" ", "_");
    
    let safe_name = if clean_name.is_empty() { "untitled_plot.txt".to_string() } else { format!("{}.txt", clean_name) };
    let path = dir.join(&safe_name);
    
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(safe_name)
}

#[tauri::command]
fn get_saved_plots() -> Result<Vec<String>, String> {
    let dir = get_plot_dir();
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
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_output_folder(app_handle: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    
    // Attempt to get robust base path
    let mut path = std::env::current_dir().unwrap_or_default();
    println!("[Backend] Opening output folder. Current Dir: {:?}", path);
    
    path.push("output");
    if !path.exists() {
        println!("[Backend] Creating output folder at: {:?}", path);
        let _ = fs::create_dir_all(&path);
    }
    
    println!("[Backend] Final path to open: {:?}", path);
    app_handle.opener().open_path(path.to_string_lossy().to_string(), None::<String>).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn load_system_prompt() -> Result<String, String> {
    let path = std::env::current_dir().unwrap_or_default().join("system_prompt.txt");
    if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())
    } else {
        Ok("You are a professional novelist. Write engaging and immersive stories.".to_string())
    }
}

#[tauri::command]
fn save_system_prompt(content: String) -> Result<String, String> {
    let path = std::env::current_dir().unwrap_or_default().join("system_prompt.txt");
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok("✅ System prompt saved successfully!".to_string())
}

#[tauri::command]
fn load_api_key() -> Result<String, String> {
    let path = std::env::current_dir().unwrap_or_default().join("gemini.txt");
    if path.exists() {
        fs::read_to_string(path).map(|s| s.trim().to_string()).map_err(|e| e.to_string())
    } else {
        Ok("".to_string())
    }
}

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    let path = std::env::current_dir().unwrap_or_default().join("gemini.txt");
    fs::write(path, key.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_novel_state(filename: String, text_content: String, metadata_json: String) -> Result<(), String> {
    let mut dir = std::env::current_dir().unwrap_or_default();
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
    let mut dir = std::env::current_dir().unwrap_or_default();
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
    let mut dir = std::env::current_dir().unwrap_or_default();
    dir.push("output");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    
    let mut max_num = 0;
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("novel_") && name.ends_with(".txt") {
                    let num_str = &name[6..name.len()-4];
                    if let Ok(num) = num_str.parse::<u32>() {
                        if num > max_num {
                            max_num = num;
                        }
                    }
                }
            }
        }
    }
    
    Ok(format!("novel_{:03}.txt", max_num + 1))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_models,
            generate_seed,
            generate_plot,
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
