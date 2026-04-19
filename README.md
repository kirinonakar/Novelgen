# 🖋️ NovelGen Desktop

NovelGen Desktop is a standalone AI Novel Generator built with **Rust** and **Tauri**. Originally prototyped in Python (Gradio), it has been completely rewritten into a blazing-fast native desktop application with a beautifully crafted Light Theme.

## ✨ Features
- **Standalone Executable**: Runs entirely as a local desktop app without needing a background Python web server.
- **Native performance**: Core logic, API streaming, and File System operations are safely executed in Rust.
- **Dual External API Support**: Seamlessly switch between local AI models via **LM Studio** or cloud models via **Google Gemini API**.
- **Interactive Plot Management**: Automatically generate, securely save, load, and refine plot outlines as local text files.
- **Context-Aware Streaming**: Streams chapter generation intelligently using hierarchical chapter summarization and sliding window context for logic continuity.
- **Beautiful UI**: Modern, glassmorphism-inspired Light Theme built with lightweight Vanilla HTML/CSS.

## 🛠️ Technology Stack
- **Frontend**: Vanilla HTML / CSS / JavaScript
- **Backend**: Rust 🦀
- **App Framework**: [Tauri V2](https://v2.tauri.app/)
- **API Connectivity**: `reqwest`, `eventsource-stream`

## 🚀 Getting Started

### Prerequisites
1. **[Node.js](https://nodejs.org/)** (v18 or higher)
2. **[Rust](https://www.rust-lang.org/tools/install)** & Cargo
3. **LM Studio** (Optional, for local LLM usage) or a **Google Gemini API Key**.

### Installation and Setup
1. Clone or download this project folder.
2. Navigate to the project directory in your terminal:
   ```bash
   cd novelgen-desktop
   ```
3. Install the frontend dependencies:
   ```bash
   npm install
   ```

### Running in Development Mode
To launch the application locally with Hot-Module-Replacement (HMR) for the UI:
```bash
npm run tauri dev
```
*(Note: At first execution, downloading and compiling Rust dependencies might take a minute.)*

### Build for Production
To package the app into a single native installer or executable for your Operating System (`.moco`, `.exe`, or `.AppImage` depending on your OS):
```bash
npm run tauri build
```
You can find your bundled standalone executable in `src-tauri/target/release`.

---

## 📖 Usage Instructions

1. **Provider Setup**: On the left pane, select **LM Studio** (ensure your local LM Studio server is running on port 1234) or **Google**. If using Google, enter your API Key.
2. **Prompt Setup**: Choose a system preset that dictates the AI's writing persona (e.g., *Epic Fantasy*, *Web Novel*, etc.).
3. **Generate a Plot**: Click Auto-Seed to generate an idea, or write your own. Click **Generate Plot Outline** and wait for the AI to construct your 5-part plot. Feel free to manually edit the output.
4. **Generate Novel**: Click **Start Novel Generation**. The Rust backend will stream chapter by chapter straight into the UI, autonomously summarizing previous chapters to maintain context without overloading token limits. All generated files will be safely stored in the `output` folder.
