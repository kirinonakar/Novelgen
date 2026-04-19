import { invoke, Channel } from "@tauri-apps/api/core";

// DOM Elements
const els = {
    providerRadios: document.getElementsByName('provider'),
    apiBase: document.getElementById('api-base'),
    apiKeyGroup: document.getElementById('group-api-key'),
    apiKeyBox: document.getElementById('api-key'),
    modelName: document.getElementById('model-name'),
    refreshModelsBtn: document.getElementById('refresh-models-btn'),
    
    preset: document.getElementById('system-preset'),
    promptBox: document.getElementById('system-prompt'),
    savePromptBtn: document.getElementById('save-prompt-btn'),
    promptStatus: document.getElementById('prompt-status-msg'),
    
    langRadios: document.getElementsByName('language'),
    numChap: document.getElementById('num-chapters'),
    targetTokens: document.getElementById('target-tokens'),
    temp: document.getElementById('temperature'),
    tempVal: document.getElementById('temp-val'),
    topP: document.getElementById('top-p'),
    topPVal: document.getElementById('topp-val'),
    resumeCh: document.getElementById('resume-chapter'),
    findChBtn: document.getElementById('find-ch-btn'),
    openFolderBtn: document.getElementById('open-out-folder-btn'),
    
    seedBox: document.getElementById('plot-seed'),
    autoSeedBtn: document.getElementById('auto-seed-btn'),
    btnGenPlot: document.getElementById('btn-gen-plot'),
    btnRefinePlot: document.getElementById('btn-refine-plot'),
    btnStopPlot: document.getElementById('btn-stop-plot'),
    
    savedPlots: document.getElementById('saved-plots'),
    btnLoadPlot: document.getElementById('btn-load-plot'),
    btnRefreshPlots: document.getElementById('btn-refresh-plots'),
    btnSavePlot: document.getElementById('btn-save-plot'),
    plotStatusMsg: document.getElementById('plot-status-msg'),
    plotContent: document.getElementById('plot-content'),
    
    btnGenNovel: document.getElementById('btn-gen-novel'),
    btnStopNovel: document.getElementById('btn-stop-novel'),
    novelStatus: document.getElementById('novel-status'),
    novelContent: document.getElementById('novel-content')
};

const PRESETS = {
    "Standard / Literary Fiction": 'You are an award-winning, bestselling novelist known for elegant prose, deep psychological insight, and compelling character arcs. \nYour writing style is immersive and vivid. Strictly adhere to the "Show, Don\'t Tell" principle—describe sensory details, actions, and character reactions rather than simply stating emotions. \nMaintain a consistent tone, ensure natural-sounding dialogue, and pace the narrative to keep the reader deeply engaged. Never use meta-commentary or acknowledge that you are an AI.',
    "Web Novel / Light Novel": 'You are a top-ranking web novel author known for highly addictive pacing, dynamic character interactions, and gripping cliffhangers. \nYour writing style is accessible, fast-paced, and highly entertaining. \nUse frequent paragraph breaks to make the text easy to read on mobile devices. Focus heavily on punchy, expressive dialogue and characters\' internal thoughts. Keep the plot moving forward dynamically, and avoid overly dense or tedious descriptions. Every chapter must end in a way that makes the reader desperate to read the next.',
    "Epic / Dark Fantasy": 'You are a master of epic and dark fantasy. You excel at intricate world-building, crafting gritty atmospheres, and writing high-stakes conflicts. \nUse rich, evocative, and sometimes archaic vocabulary to bring the fantasy world to life. Describe the environments, magic systems, and battles with visceral sensory details. Characters should be morally complex and face difficult dilemmas. The tone should be serious, atmospheric, and immersive.',
    "Romance / Emotional Drama": 'You are a bestselling romance and drama author. Your greatest strength lies in capturing the intricate emotional dynamics, chemistry, and romantic tension between characters. \nFocus deeply on micro-expressions, body language, and the unspoken feelings between characters. Write dialogue that is witty, passionate, or emotionally raw, depending on the scene. Build the emotional stakes gradually, making the readers deeply invested in the characters\' relationships.',
    "Sci-Fi / Thriller": 'You are a master of science fiction and suspense thrillers. Your prose is sharp, precise, and gripping. \nFocus on building relentless suspense and a creeping sense of tension. Describe technology, environments, or action sequences with clear, logical, yet cinematic detail. Keep the sentences relatively punchy during action or tense scenes to accelerate the pacing. Leave the readers constantly guessing what will happen next.'
};

let stopPlotRequested = false;
let stopNovelRequested = false;

// Helpers
const getLang = () => Array.from(els.langRadios).find(r => r.checked).value;
const getProvider = () => Array.from(els.providerRadios).find(r => r.checked).value;

function setProviderUI() {
    if (getProvider() === 'Google') {
        els.apiBase.value = "https://generativelanguage.googleapis.com/v1beta/openai/";
        els.apiKeyGroup.style.display = "flex";
        els.modelName.innerHTML = `
            <option value="gemini-3.1-flash-lite-preview">gemini-3.1-flash-lite-preview</option>
            <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
            <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview</option>
            <option value="gemini-2.5-flash">gemini-2.5-flash</option>
            <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite</option>
        `;
    } else {
        els.apiBase.value = "http://localhost:1234/v1";
        els.apiKeyGroup.style.display = "none";
        refreshModels();
    }
}

async function refreshModels() {
    try {
        const models = await invoke("fetch_models", { apiBase: els.apiBase.value });
        if (models && models.length > 0) {
            els.modelName.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
        }
    } catch (e) {
        console.warn("Could not fetch models", e);
    }
}

// Events
Array.from(els.providerRadios).forEach(r => r.addEventListener('change', setProviderUI));
els.refreshModelsBtn.addEventListener('click', refreshModels);
els.preset.addEventListener('change', (e) => {
    if (PRESETS[e.target.value]) els.promptBox.value = PRESETS[e.target.value];
});
els.temp.addEventListener('input', e => els.tempVal.innerText = parseFloat(e.target.value).toFixed(1));
els.topP.addEventListener('input', e => els.topPVal.innerText = parseFloat(e.target.value).toFixed(2));
els.openFolderBtn.addEventListener('click', () => invoke("open_output_folder"));

// Generate Seed
els.autoSeedBtn.addEventListener('click', async () => {
    els.autoSeedBtn.disabled = true;
    els.seedBox.value = "⏳ Generating seed...";
    try {
        const seed = await invoke("generate_seed", {
            apiBase: els.apiBase.value,
            modelName: els.modelName.value,
            apiKey: els.apiKeyBox.value || "lm-studio",
            systemPrompt: els.promptBox.value,
            language: getLang(),
            temperature: parseFloat(els.temp.value),
            topP: parseFloat(els.topP.value)
        });
        els.seedBox.value = seed;
    } catch (e) {
        els.seedBox.value = `❌ Error: ${e}`;
    } finally {
        els.autoSeedBtn.disabled = false;
    }
});

// Stream function
async function streamPlot(prompt, textarea) {
    stopPlotRequested = false;
    els.btnGenPlot.style.display = 'none';
    els.btnRefinePlot.style.display = 'none';
    els.btnStopPlot.style.display = 'inline-flex';
    
    textarea.value = "";
    
    const onEvent = new Channel();
    onEvent.onmessage = (event) => {
        if (stopPlotRequested) return;
        textarea.value = event.content;
        if (event.error) {
            textarea.value += `\n[Error]: ${event.error}`;
        }
    };

    try {
        await invoke("generate_plot", {
            params: {
                api_base: els.apiBase.value,
                model_name: els.modelName.value,
                api_key: els.apiKeyBox.value || "lm-studio",
                system_prompt: els.promptBox.value,
                prompt: prompt,
                temperature: parseFloat(els.temp.value),
                top_p: parseFloat(els.topP.value)
            },
            onEvent
        });
    } catch (e) {
        textarea.value += `\n[Error]: ${e}`;
    }

    els.btnGenPlot.style.display = 'inline-flex';
    els.btnRefinePlot.style.display = 'inline-flex';
    els.btnStopPlot.style.display = 'none';
}

els.btnStopPlot.addEventListener('click', () => { stopPlotRequested = true; });

// Generate Plot
els.btnGenPlot.addEventListener('click', () => {
    const lang = getLang();
    const h = lang === 'Korean' ? [
        "1. 제목", "2. 핵심 주제의식과 소설 스타일", "3. 등장인물 이름, 설정", "4. 세계관 설정", "5. 각 장 제목과 내용, 핵심 포인트"
    ] : lang === 'Japanese' ? [
        "1. タイトル", "2. 核心となるテーマと小説のスタイル", "3. 登場人物の名前・設定", "4. 世界観設定", "5. 各章のタイトルと内容、重要ポイント"
    ] : [
        "1. Title", "2. Core Theme and Novel Style", "3. Character Names and Settings", "4. World Building/Setting", "5. Chapter Titles, Content, and Key Points"
    ];

    const prompt = `Based on the following seed, create a detailed plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\nSeed: ${els.seedBox.value}\n\nFORMAT INSTRUCTIONS:\nPlease organize the output into the following 5 sections in ${lang}:\n${h.join('\n')}\nEnsure every section is detailed. Output ONLY the plot outline based on this format.`;
    
    streamPlot(prompt, els.plotContent);
});

// Refine Plot
els.btnRefinePlot.addEventListener('click', () => {
    const lang = getLang();
    const prompt = `You are a master story architect. Refine and elaborate on the following plot outline for a ${els.numChap.value}-chapter novel in ${lang}.\n\n[Current Plot Outline]\n${els.plotContent.value}\n\nMaintain the 5-section format and polish content for better emotional resonance and pacing.`;
    streamPlot(prompt, els.plotContent);
});

// Plot Save/Load
async function reloadPlotList() {
    try {
        const plots = await invoke("get_saved_plots");
        els.savedPlots.innerHTML = '<option value="" disabled selected>Select a saved plot...</option>' + 
            plots.map(p => `<option value="${p}">${p}</option>`).join('');
    } catch (e) {}
}

els.btnRefreshPlots.addEventListener('click', reloadPlotList);
els.btnSavePlot.addEventListener('click', async () => {
    try {
        let titleMatch = els.plotContent.value.match(/(?:제목|Title|タイトル)[:\s]*(.*)/i);
        let title = titleMatch ? titleMatch[1].trim() : "untitled_plot";
        const saved = await invoke("save_plot", { filename: title, content: els.plotContent.value });
        els.plotStatusMsg.innerText = `✅ Saved: ${saved}`;
        reloadPlotList();
    } catch (e) {
        els.plotStatusMsg.innerText = `❌ Error: ${e}`;
    }
});

els.btnLoadPlot.addEventListener('click', async () => {
    if (!els.savedPlots.value) return;
    try {
        els.plotContent.value = await invoke("load_plot", { filename: els.savedPlots.value });
        els.plotStatusMsg.innerText = `✅ Loaded: ${els.savedPlots.value}`;
    } catch (e) {
        els.plotStatusMsg.innerText = `❌ Error: ${e}`;
    }
});

// NOVEL GENERATION ORCHESTRATOR
els.btnStopNovel.addEventListener('click', () => { stopNovelRequested = true; });

els.btnGenNovel.addEventListener('click', async () => {
    if (!els.plotContent.value.trim()) {
        alert("Plot is empty! Generate a plot outline first.");
        return;
    }
    
    stopNovelRequested = false;
    els.btnGenNovel.style.display = 'none';
    els.btnStopNovel.style.display = 'inline-flex';
    
    let currentChapter = parseInt(els.resumeCh.value) || 1;
    const totalChapters = parseInt(els.numChap.value);
    const targetTokens = parseInt(els.targetTokens.value);
    const lang = getLang();
    
    let fullNovelText = currentChapter === 1 ? "" : els.novelContent.value;
    let chapterSummaries = []; 
    // Simplification: In pure JS, if resuming we just pass directly preceding content instead of grand summary.

    for (let ch = currentChapter; ch <= totalChapters; ch++) {
        if (stopNovelRequested) break;
        
        els.novelStatus.innerText = `Writing Chapter ${ch} / ${totalChapters}...`;
        
        let prompt = `You are a professional novelist writing a novel in ${lang}.\n\n`;
        prompt += `[Book Information]\n- Total Chapters: ${totalChapters}\n- Master Plot Outline:\n${els.plotContent.value}\n\n`;
        prompt += `CRITICAL INSTRUCTION:\n1. Write ONLY Chapter ${ch}. Do not rush into future chapters.\n2. Target length: ~${targetTokens} tokens.\n3. Output ONLY the story text.\n\n`;
        prompt += `### CURRENT FOCUS: Chapter ${ch} ###\n`;
        
        if (chapterSummaries.length > 0) {
            prompt += `[Recent Summaries]\n${chapterSummaries.map((s, i) => `Chapter ${ch - chapterSummaries.length + i}: ${s}`).join('\n')}\n\n`;
        }

        if (fullNovelText.length > 0) {
            let lastPart = fullNovelText.substring(Math.max(0, fullNovelText.length - 2000));
            prompt += `[Directly Preceding Content]\n"...${lastPart}"\n\n`;
        }
        
        prompt += "Please begin writing the chapter now.";

        let chapterText = "";
        const onEvent = new Channel();
        onEvent.onmessage = (event) => {
            if (stopNovelRequested) return;
            chapterText = event.content;
            
            let currentTitle = "";
            if (lang === 'Korean') currentTitle = `\n\n# 제 ${ch}장\n\n`;
            else if (lang === 'Japanese') currentTitle = `\n\n# 第 ${ch} 章\n\n`;
            else currentTitle = `\n\n# Chapter ${ch}\n\n`;
            
            els.novelContent.value = fullNovelText + currentTitle + chapterText;
            els.novelContent.scrollTop = els.novelContent.scrollHeight;
        };

        try {
            await invoke("generate_plot", {
                params: {
                    api_base: els.apiBase.value,
                    model_name: els.modelName.value,
                    api_key: els.apiKeyBox.value || "lm-studio",
                    system_prompt: els.promptBox.value,
                    prompt: prompt,
                    temperature: parseFloat(els.temp.value),
                    top_p: parseFloat(els.topP.value)
                },
                onEvent
            });
            
            // Append formally to full text
            let currentTitle = "";
            if (lang === 'Korean') currentTitle = `\n\n# 제 ${ch}장\n\n`;
            else if (lang === 'Japanese') currentTitle = `\n\n# 第 ${ch} 章\n\n`;
            else currentTitle = `\n\n# Chapter ${ch}\n\n`;
            fullNovelText += currentTitle + chapterText + "\n";
            
            // Generate Summary for context window
            els.novelStatus.innerText = `Summarizing Chapter ${ch}...`;
            let summaryReq = `Summarize the following chapter in 3-4 sentences in ${lang}.\n\nChapter:\n${chapterText.substring(0, 2000)}`;
            
            let summary = await invoke("chat_completion", {
                apiBase: els.apiBase.value,
                modelName: els.modelName.value,
                apiKey: els.apiKeyBox.value || "lm-studio",
                systemPrompt: "You are a helpful assistant.",
                prompt: summaryReq,
                temperature: 0.5,
                topP: 0.95,
                maxTokens: 500
            });
            
            chapterSummaries.push(summary);
            // Sliding window of 5
            if (chapterSummaries.length > 5) chapterSummaries.shift();
            
            els.resumeCh.value = ch + 1; // updates resume point
        } catch (e) {
            alert(`Error during generation of Chapter ${ch}: ${e}`);
            break;
        }
    }

    els.novelStatus.innerText = stopNovelRequested ? "Stopped." : "Finished.";
    els.btnGenNovel.style.display = 'inline-flex';
    els.btnStopNovel.style.display = 'none';
});

// On Load
setProviderUI();
reloadPlotList();
els.promptBox.value = PRESETS["Standard / Literary Fiction"];
