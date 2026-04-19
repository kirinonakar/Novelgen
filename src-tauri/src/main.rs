#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod generator;

use std::fs;
use std::path::PathBuf;
use tauri::ipc::Channel;

#[tauri::command]
async fn fetch_models(api_base: String) -> Result<Vec<String>, String> {
    generator::fetch_models_impl(&api_base).await
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
    top_p: f32
}

#[tauri::command]
async fn generate_plot(params: GenerationParams, on_event: Channel<generator::StreamEvent>) -> Result<(), String> {
    generator::generate_plot_stream(
        &params.api_base, &params.model_name, &params.api_key, &params.system_prompt,
        &params.prompt, params.temperature, params.top_p, on_event
    ).await
}

#[tauri::command]
async fn chat_completion(
    api_base: String, model_name: String, api_key: String, system_prompt: String, prompt: String,
    temperature: f32, top_p: f32, max_tokens: u32
) -> Result<String, String> {
    generator::chat_completion(&api_base, &model_name, &api_key, &system_prompt, &prompt, temperature, top_p, max_tokens).await
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
fn save_plot(filename: String, content: String) -> Result<String, String> {
    let dir = get_plot_dir();
    let sanitize_re = regex::Regex::new(r#"[\\/*?:"<>|]"#).unwrap();
    let clean_name = sanitize_re.replace_all(&filename, "").trim().replace(" ", "_");
    
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
fn open_output_folder() -> Result<(), String> {
    let mut path = std::env::current_dir().unwrap_or_default();
    path.push("output");
    if !path.exists() {
        let _ = fs::create_dir_all(&path);
    }
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    
    Ok(())
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
            open_output_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
