# 🖋️ NovelGen AI

**NovelGen AI** is a personalized AI story generator for readers who have a story they want to experience but lack the time, skill, or confidence to write it themselves.

Instead of helping professional writers manage a manuscript, NovelGen AI focuses on turning your favorite settings, characters, genres, and story ideas into complete readable novels with minimal effort.

Enter a seed, generate or refine a plot, and let the app produce a full chapter-by-chapter story that matches the kind of novel you personally want to read.

![UI Preview](screenshot.png)

## ✨ Key Features

- **Desktop AI Story Generating Environment**
  - Standalone Rust/Tauri app with no dependencies (except for Edge WebView2 runtime which is included in Windows).
  - Supports local generation through **LM Studio** and cloud generation through **Google Gemini API**.
  - Generates stories in **Korean**, **Japanese**, or **English**.

- **Hands-Off Novel Creation**
  - Enter a **Seed**, choose the chapter count, generate a plot, and start novel generation.
  - Use **🚀 Batch Start** to automatically create multiple story variations from your idea.
    - Pick the version that best matches your taste.
  - **Seamless Previewing:** Review your work instantly with a feature-rich built-in viewer supporting **Markdown**, **KaTeX**, word wrap, per-pane font sizing, **Comfort mode**, and persistent Light / Dark themes for a truly pleasant experience.

- **Customize the Story You Want to Read**
  - Full automation is available, but you can still edit the plot, adjust the tone, refine chapters, or guide the story when you want more control.

- **Precision Plot Planning & Refinement**
  - Manually sculpt your story by creating and editing chapter-by-chapter plot outlines to your exact specifications.
  - Add highly specific custom refine instructions to control pacing, tone, relationships, conflict, expansion targets, or details to preserve.
  - Automatically generate professional plot improvement ideas using the **✨ Auto Instructions** feature when you need inspiration.
  - Refine long plots in structured chunks, starting with setup sections and progressing through each story part in order.
  - Monitor estimated plot token usage with a CJK-aware counter.

- **Advanced Generation & Continuity Management**
  - Maintain absolute consistency with layered context, chapter summaries, and sliding-window memory under the hood.
  - Resume interrupted generation from the exact last written chapter with continuity fully intact.
  - Save all generated novels, plot files, and metadata locally for manual editing and safe-keeping.

- **Targeted Novel Revision Tools**
  - Refine completed drafts chapter by chapter against your specific plot requirements.
  - Limit manuscript refinement to an exact chapter range using optional **Start Chapter** and **End Chapter** fields.
  - Provide specific manual instructions or use **✨ Auto Instructions** on a single chapter to automatically review it against adjacent chapters and generate 10 targeted improvement points.
  - Precisely improve scene purpose, emotional progression, dialogue clarity, prose flow, and fix repetitive expression patterns.

- **Batch & Productivity Tools**
  - Queue multiple generation jobs and process them sequentially.
  - Optionally auto-refine plots before generation and novels after generation in batch mode.
  - Import `.txt` / `.md` files by drag and drop into prompt, seed, plot, and novel editors.


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
1.  **Input Initial Idea**: Enter a brief concept in the "Plot Seed" box, and/or click **🎲 Auto Seed** to let the AI brainstorm a unique starting point.
2.  **Generate Plot**: Click **Generate Plot Outline**. The AI will create a chapter-by-chapter summary.
3.  **Refine Plot (Optional)**: Click **✨ Auto Instructions** to have the AI automatically review your plot and suggest 5-10 specific improvement points, or manually add your own guidance in **Plot Refine Instructions**. Then click **✨ Refine Plot**. The AI first rewrites the setup sections, then refines each story part in order using the revised setup, already-refined earlier parts, and the remaining original chapter outline as boundary/context.
4.  **Review & Edit**: You can manually edit the generated plot directly in the UI to fix inconsistencies.
5.  **Save Plot**: Use the **💾 Save Plot** button to store your outline locally in `output/plot/`.
6.  **Start Generation**: Click **Start Novel Generation**. The AI will follow your plot exactly, chapter by chapter.
7.  **Refine Novel (Optional)**: Add manuscript-specific guidance in **Novel Refine Instructions**, then click **✨ Refine Novel** to revise the draft against the plot.
    - Use **Start Chapter** and/or **End Chapter** to refine only part of the draft.
    - Start only: refines from that chapter through the end.
    - End only: refines from the beginning through that chapter.
    - Same Start and End: refines only that chapter. When specifying a single chapter this way, you can click **✨ Auto Instructions** to have the AI automatically review that specific chapter against the plot, previous chapter, and next chapter to generate 10 specific improvement points.

### Workflow B: Automated Batch Mode
Generate multiple novels or handle high-volume creation automatically.

1.  **Setup**: Enter your concept in the **Plot Seed** box and set the **Batch Count**.
2.  **Optional Refinement Settings**:
    - **Auto refine plot**: Automatically refines the outline in chunks before starting novel generation.
        - **Auto instructions**: Dynamically generates tailored improvement points for the plot during the refinement process.
    - **Auto refine novel**: Automatically runs the chapter-by-chapter refinement pipeline after the draft is complete.
        - **Auto instructions**: Dynamically generates tailored improvement points for each specific chapter during the refinement process.
          > [!CAUTION]
          > This may cause unintended major changes to the novel. Rather than applying Auto instructions as-is, it is highly recommended to manually verify them and keep only the strictly necessary instructions.
3.  **Execution**: Click **🚀 Batch Start**. The system will sequentially:
    - Brainstorm unique plots for each batch job.
    - Apply requested auto-refinements to plots and manuscripts.
    - Save all files (`.txt` and metadata `.json`) to the `output/` directory.
4.  **Queue Management**: Jobs are added to a task queue and processed one by one. Monitor progress via the **Queue Size** display.

---

## ⚙️ Configuration & Advanced Settings

### 📂 File & Directory Structure
The application manages its configuration and storage through the following structure:

- **Key Configuration Files**
    - `system_prompt.txt`: Stores your default system prompt. Use the **Save** icon in the UI to update this file.
    - `gemini.txt`: Stores your Google Gemini API key for automatic loading.
- **Storage Paths**
    - `output/`: Primary directory for generated novel manuscripts (`.txt`).
    - `output/plot/`: Storage for generated and refined plot outlines (`.txt`).
    - `output/json/`: Essential metadata and continuity JSON files used for resuming generation or refining drafts.

### 📜 System Prompt Management
Define the global persona, tone, and constraints of your AI novelist.
- Use the **System Preset** dropdown to switch between styles (Standard, Web Novel, Epic Fantasy, etc.).
- Selecting **Custom (File Default)** reloads the contents of `system_prompt.txt`.
- Drag and drop a `.txt/md` file into **System Prompt Details** to load text instantly.
- Click the **Save** icon to persist your custom prompt to `system_prompt.txt`.

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

Continuity metadata is saved as JSON files in `output/json/`.

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
- **Recommended Minimum**: `≈ plot_tokens * 2 + target_tokens + 1000 + 3000~5000`
- **Short plot outlines**: `16k` to `24k` context is usually enough.
- **General long-form novel generation**: `32k` context is the recommended default.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
