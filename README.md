# 🖋️ NovelGen AI

NovelGen AI is a powerful, standalone AI novel generator built with **Rust** and **Tauri**. It is the desktop evolution of the original Python-based AI Novel Generator, designed to provide a premium, native experience for immersive story creation.

![UI Preview](screenshot.png)

## ✨ Key Features

- **Desktop AI Writing Environment**
  - Standalone Tauri app with no Python runtime or background web server required.
  - Supports local generation through **LM Studio** and cloud generation through **Google Gemini API**.
  - Generates stories in **Korean**, **Japanese**, or **English**.

- **Plot Planning & Refinement**
  - Create AI-generated seeds and chapter-by-chapter plot outlines.
  - Refine long plots in structured chunks, starting with setup sections and moving through each story part in order.
  - Add custom refine instructions for pacing, tone, relationships, conflict, expansion targets, or details to preserve.
  - Monitor estimated plot token usage with a CJK-aware counter.

- **Chapter Generation & Continuity**
  - Stream chapters with layered context, chapter summaries, and sliding-window memory.
  - Resume interrupted generation from the last written chapter with continuity intact.
  - Save generated novels, plot files, and metadata locally.

- **Novel Revision Tools**
  - Refine completed drafts chapter by chapter against the plot.
  - Limit manuscript refinement to a selected chapter range with optional **Start Chapter** and **End Chapter** fields.
  - Improve scene purpose, emotional progression, dialogue clarity, prose flow, and repetitive expression patterns.
  - Keep plot refinement and manuscript refinement instructions separate.

- **Batch & Productivity Tools**
  - Queue multiple generation jobs and process them sequentially.
  - Optionally auto-refine plots before generation and novels after generation in batch mode.
  - Import `.txt` / `.md` files by drag and drop into prompt, seed, plot, and novel editors.
  - Use Markdown preview, KaTeX rendering, word wrap, per-pane font sizing, Comfort mode, and persistent Light / Dark themes.

## 🛠️ Technology Stack

- **Frontend**: Vanilla HTML / CSS / JavaScript (Lightweight & Fast)
- **Backend**: Rust 🦀 (Safety & Performance)
- **App Framework**: [Tauri V2](https://v2.tauri.app/)
- **State Management**: Local persistence via `localStorage` and native File System.

## 🚀 Getting Started

### 📥 Download
You can download the latest version from the [Releases Page](https://github.com/kirinonakar/Novelgen/releases).

### Manual build
### Prerequisites

1. **[Node.js](https://nodejs.org/)** (v18 or higher)
2. **[Rust](https://www.rust-lang.org/tools/install)** & Cargo (Required for building from source)
3. **AI Provider**:
   - **LM Studio**: Local server running on port `1234`.
   - **Google Gemini**: A valid API key (automatically loaded from `gemini.txt`).

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

### Build Standalone Executable

To package the app into a single native installer or executable:
```bash
npm run tauri build
```
The final binary will be located in `src-tauri/target/release`.

---

## 💻 Runtime Requirements

To run the application (without building from source), ensure the following are available:

### Windows
- **Microsoft Edge WebView2**: Required for the UI to render.
  - Windows 11: Pre-installed.
  - Windows 10: Usually pre-installed via Edge updates.
  - If the app fails to launch, download and install it from [Microsoft's official site](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### AI Backend (Required for generation)
One of the following providers must be accessible:
- **LM Studio**: Must be running a local server on port `1234`.
- **Google Gemini API**: A valid API Key and active internet connection.

---

## 📖 Narrative Generation Workflows

You can generate your novel using two distinct workflows:

### Workflow A: Manual Full-Control (Recommended)
This mode allows you to refine the story's direction before final generation.
1.  **Input Initial Idea**: Enter a brief concept in the "Plot Seed" box, or click **🎲 Auto Seed** to let the AI brainstorm a unique starting point.
2.  **Generate Plot**: Click **Generate Plot Outline**. The AI will create a chapter-by-chapter summary.
3.  **Refine Plot (Optional)**: Add any custom guidance in **Refine Instructions**, then click **✨ Refine Plot**. The AI first rewrites the setup sections, then refines each story part in order using the revised setup, already-refined earlier parts, and the remaining original chapter outline as boundary/context.
4.  **Review & Edit**: You can manually edit the generated plot directly in the UI to fix inconsistencies.
5.  **Save Plot**: Use the **💾 Save Plot** button to store your outline locally in `output/plot/`.
6.  **Start Generation**: Click **Start Novel Generation**. The AI will follow your plot exactly, chapter by chapter.
7.  **Refine Novel (Optional)**: Add manuscript-specific guidance in **Novel Refine Instructions**, then click **✨ Refine Novel** to revise the draft against the plot.
    - Use **Start Chapter** and/or **End Chapter** to refine only part of the draft.
    - Start only: refines from that chapter through the end.
    - End only: refines from the beginning through that chapter.
    - Same Start and End: refines only that chapter.

### Workflow B: Automated Batch Mode
Perfect for creating multiple variations or generating large volumes of content automatically.
1.  **Input Idea & Batch Count**: Enter your initial idea and the number of independent novels you want to create.
2.  **Launch**: Click **Batch Start**.
3.  **Optional Auto Refine**: Enable **Auto refine plot before novel generation** if you want every generated batch plot to pass through the chunked refine pipeline before chapters are written. Enable **Auto refine novel after generation** if you want each completed draft to pass through the chapter-by-chapter novel refinement pipeline automatically.
4.  **Automatic Execution**: The system will automatically:
    - Generate a unique plot outline for each batch.
    - Refine the generated plot first when Auto Refine is enabled.
    - Start generating the novel based on that specific plot.
    - Refine the completed novel when Auto Refine Novel is enabled.
    - Save each completed novel in the `output/` directory and its metadata JSON in `output/json/`.
5. **Queue Management**: New requests are added to a queue and processed sequentially.

---

## ⚙️ Configuration & Advanced Settings

### System Prompt (`system_prompt.txt`)
Define the global persona, tone, and constraints of your AI novelist.
- Use the **System Preset** dropdown to quickly switch between styles (Standard, Web Novel, Epic Fantasy, Romance, Sci-Fi).
- Click the **Save** icon to persist your custom prompt to `system_prompt.txt`.
- Drag and drop a `.txt/md` file into **System Prompt Details** to load prompt text instantly.
- Selecting **Custom (File Default)** reloads the saved contents of `system_prompt.txt`.

### Generation Parameters
Adjust these in the sidebar for fine-grained control:
- **Temperature**: Higher values (e.g., 1.2) increase creativity; lower values (e.g., 0.5) make output more focused.
- **Top-P**: Controls the diversity of the vocabulary.
- **Repetition Penalty**: Helps prevent the model from repeating phrases or sentences.

### Preview, Import, and Theme Tools
- Drag and drop `.txt/md` files into the **Seed**, **Plot**, and **Novel** editors to replace the current text quickly.
- Each **Seed / Plot / Novel** preview includes an independent font size slider for easier editing and proofreading.
- Enable the **Comfort** checkbox beside each preview font slider to use a softer reading surface designed for long-form review.
- Use the theme toggle beside the **NovelGen AI** title in the sidebar to switch the whole app between light and dark appearance.

### Context Management
NovelGen AI maintains long-term continuity using a sophisticated **layered memory architecture**, allowing it to generate cohesive novels of any length:

Continuity metadata is saved as JSON files in `output/json/`, alongside the generated novel text files in `output/`.

1.  **Global Plot Outline**: The full refined plot is always included in the context, ensuring the AI adheres to the master plan and reaches the intended climax.
2.  **Recent Chapter Summaries**: A sliding window of the **last 4 chapter summaries** provides high-density context for immediate narrative flow.
3.  **Layered Story State**:
    *   **Facts**: Established canon facts that must remain consistent.
    *   **Open Threads**: Unresolved plot points and "to-do" items for the narrative.
4.  **Character Status Memory**: Dynamically tracks character locations, emotional states, and evolving relationships.
5.  **Narrative Arc Management**:
    *   **Current Arc**: The immediate conflict or goal being pursued in the present chapters.
    *   **Closed Arcs**: Summarized history of finished story arcs, allowing for long-term recall without wasting tokens.
6.  **Sliding Prose Window**: The final ~1,200 characters of the previous chapter are provided to ensure seamless transitions and consistent writing style.
7.  **Style & Expression Cooldown**: An automated trope-detection system that prevents the AI from overusing specific transition phrases or descriptive clichés in narration.

### Recommended Context Length
If your model runner allows changing context length, these settings work well in practice:
- **Short plot outlines**: `16k` to `24k` context is usually enough.
- **General long-form novel generation**: `32k` context is the recommended default.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
