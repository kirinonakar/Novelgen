# 🖋️ NovelGen AI

NovelGen AI is a powerful, standalone AI novel generator built with **Rust** and **Tauri**. It is the desktop evolution of the original Python-based AI Novel Generator, designed to provide a premium, native experience for immersive story creation.

![UI Preview](app.png)

## ✨ key Features

- **Standalone Executable**: Runs entirely as a local desktop app without needing a background Python environment or web server.
- **Dual Provider Support**: Seamlessly switch between local models via **LM Studio** and cloud models via **Google Gemini API**.
- **Context-Aware Streaming**: Streams chapter generation intelligently using hierarchical chapter summarization and sliding window context to maintain narrative logic without hitting token limits.
- **Multi-language Support**: Generate stories in **Korean**, **Japanese**, or **English**.
- **Interactive Plot Management**: 
  - **AI-powered Seed Generation**: Instantly brainstorm creative story ideas based on your chosen writing style.
  - **Detailed Plot Outlines**: Generate comprehensive 5-part plot structures.
  - **Creative Refinement**: Use the **✨ Refine Plot** feature to add emotional depth, sensory details, and polished pacing.
  - **Local Storage**: Securely save, load, and edit plot outlines as local text files.
- **Batch Queue Management**: Add multiple generation tasks to a queue. The system processes them sequentially, allowing for high-volume content creation.
- **Robust Resumption**: Automatically detect the last written chapter and resume generation with full context awareness.
- **Modern Aesthetics**: A stunning, glassmorphism-inspired interface with real-time Markdown rendering for both plots and novel content.

## 🛠️ Technology Stack

- **Frontend**: Vanilla HTML / CSS / JavaScript (Lightweight & Fast)
- **Backend**: Rust 🦀 (Safety & Performance)
- **App Framework**: [Tauri V2](https://v2.tauri.app/)
- **State Management**: Local persistence via `localStorage` and native File System.

## 🚀 Getting Started

### Prerequisites

1. **[Node.js](https://nodejs.org/)** (v18 or higher)
2. **[Rust](https://www.rust-lang.org/tools/install)** & Cargo (Required for building from source)
3. **AI Provider**:
   - **LM Studio**: Local server running on port `1234`.
   - **Google Gemini**: A valid API key (automatically saved to `gemini.txt`).

### Installation (Development)

1. Clone or download this project folder.
2. Navigate to the project directory:
   ```bash
   cd Novelgen
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Launch the application:
   ```bash
   npm run tauri dev
   ```

### Build Standing Alone Executable

To package the app into a single native installer or executable:
```bash
npm run tauri build
```
The final binary will be located in `src-tauri/target/release`.

---

## 📖 Narrative Generation Workflows

You can generate your novel using two distinct workflows:

### Workflow A: Manual Full-Control (Recommended)
This mode allows you to refine the story's direction before final generation.
1.  **Input Initial Idea**: Enter a brief concept in the "Plot Seed" box, or click **🎲 Auto Seed** to let the AI brainstorm a unique starting point.
2.  **Generate Plot**: Click **Generate Plot Outline**. The AI will create a chapter-by-chapter summary.
3.  **Refine Plot (Optional)**: Click **✨ Refine Plot**. The AI will act as a master story architect to elaborate on the outline, adding emotional depth and vivid sensory details.
4.  **Review & Edit**: You can manually edit the generated plot directly in the UI to fix inconsistencies.
5.  **Save Plot**: Use the **💾 Save Plot** button to store your outline locally in `output/plot/`.
6.  **Start Generation**: Click **Start Novel Generation**. The AI will follow your plot exactly, chapter by chapter.

### Workflow B: Automated Batch Mode
Perfect for creating multiple variations or generating large volumes of content automatically.
1.  **Input Idea & Batch Count**: Enter your initial idea and the number of independent novels you want to create.
2.  **Launch**: Click **Batch Start**.
3.  **Automatic Execution**: The system will automatically:
    - Generate a unique plot outline for each batch.
    - Start generating the novel based on that specific plot.
    - Save each completed novel and its metadata in the `output/` directory.
4. **Queue Management**: New requests are added to a queue and processed sequentially.

---

## ⚙️ Configuration & Advanced Settings

### System Prompt (`system_prompt.txt`)
Define the global persona, tone, and constraints of your AI novelist.
- Use the **System Preset** dropdown to quickly switch between styles (Standard, Web Novel, Epic Fantasy, Romance, Sci-Fi).
- Click the **Save** icon to persist your custom prompt to `system_prompt.txt`.

### Generation Parameters
Adjust these in the sidebar for fine-grained control:
- **Temperature**: Higher values (e.g., 1.2) increase creativity; lower values (e.g., 0.5) make output more focused.
- **Top-P**: Controls the diversity of the vocabulary.
- **Repetition Penalty**: Helps prevent the model from repeating phrases or sentences.

### Context Management
NovelGen AI uses a sophisticated "Grand Summary" system. As chapters are generated, the backend:
1. Summarizes the chapter.
2. Appends it to a narrative "history".
3. Feeds this history back into the prompt for the next chapter.
This ensures your story remains logically consistent from start to finish.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
