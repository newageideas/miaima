import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// =========================================================================
// REAL-TIME WEB LOOKUP TOOL HELPER FUNCTIONS
// =========================================================================

/**
 * Checks whether an incoming user message requires real-time web search context.
 * Triggered on current/time-sensitive topics, fresh trends, slang, or ambiguous
 * conversational queries where checking how people typically respond improves
 * response quality. Excludes simple greetings, basic banter, and internal lore.
 */
function shouldTriggerWebSearch(query: string): boolean {
  if (!query || query.trim().length < 4) return false;
  const q = query.toLowerCase().trim();

  // Avoid unnecessary latency/cost on greetings or short banter
  if (/^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|bye|good morning|good night)$/i.test(q)) {
    return false;
  }

  // Avoid search on creator lore queries handled by internal lore variables
  if (/\b(ima|who are you|what are you|creator|how did you (two )?meet|how were you coded)\b/i.test(q)) {
    return false;
  }

  // Time-sensitive, viral, breaking, or internet culture queries
  const triggers = [
    /\b(latest|recent|recently|today|yesterday|current(ly)?|right now|this week|this month|2025|2026)\b/i,
    /\b(trending|viral|what happened (to|with)|news about|did you hear|who won|score of|price of)\b/i,
    /\b(what does .+ mean|slang|how do people (usually|typically) (respond|react|say))\b/i,
    /\b(is it true that|release date of|when does .+ come out)\b/i,
  ];

  return triggers.some((re) => re.test(q));
}

/**
 * Executes a lightweight web search API call using SEARCH_API_KEY.
 * Supports standard search providers (Tavily, Brave, SerpApi, Google Custom Search).
 * Returns a list of concise snippets or an empty array on failure/missing key,
 * allowing Mia to gracefully respond using her internal knowledge.
 */
async function performWebSearch(query: string): Promise<string[]> {
  const apiKey = process.env.SEARCH_API_KEY;
  if (!apiKey) {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s timeout for fast conversational UX

    let snippets: string[] = [];

    if (apiKey.startsWith('tvly-')) {
      // Tavily Search API
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 3,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data: any = await res.json();
        snippets = (data.results || []).map((r: any) => `${r.title}: ${r.content || r.snippet || ''}`);
      }
    } else if (process.env.SEARCH_ENGINE_ID) {
      // Google Custom Search API
      const cx = process.env.SEARCH_ENGINE_ID;
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=3`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data: any = await res.json();
        snippets = (data.items || []).map((item: any) => `${item.title}: ${item.snippet || ''}`);
      }
    } else if (apiKey.startsWith('BSA')) {
      // Brave Search API
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data: any = await res.json();
        snippets = (data.web?.results || []).map((r: any) => `${r.title}: ${r.description || ''}`);
      }
    } else {
      // SerpApi / Universal search endpoint fallback
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}&num=3`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const data: any = await res.json();
        snippets = (data.organic_results || []).map((r: any) => `${r.title}: ${r.snippet || ''}`);
      }
    }

    return snippets.filter(Boolean).slice(0, 3);
  } catch (error) {
    // Graceful fallback: never leak search errors or mention failures to the user
    console.warn('Real-time web search skipped or timed out:', error);
    return [];
  }
}

// =========================================================================
// RESILIENT MULTI-MODEL GENERATION HELPER
// Automatically fails over between gemini-flash-latest and gemini-3.8-flash
// with a 7-second per-model timeout to avoid browser request drops.
// =========================================================================
async function generateContentWithFailover(params: {
  contents: any;
  config?: any;
}) {
  const modelsToTry = ['gemini-flash-latest', 'gemini-3.8-flash'];
  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      const callPromise = ai.models.generateContent({
        model,
        contents: params.contents,
        config: params.config,
      });

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout after 7000ms on model ${model}`)), 7000);
      });

      const response: any = await Promise.race([callPromise, timeoutPromise]);
      if (response && (response.text || response.candidates?.length)) {
        return response;
      }
    } catch (err: any) {
      console.warn(`[Gemini Model ${model} failover notice]:`, err.message || err);
      lastError = err;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  throw lastError || new Error('All model attempts failed');
}

// Gemini Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, systemInstruction } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // Find the latest user message to evaluate creator lore routing and search triggers
    const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user')?.content || '';
    const userQueryLower = lastUserMessage.toLowerCase();

    // =========================================================================
    // 1. MULTIPLE CREATOR-LORE ROUTING LOGIC
    // Reads CREATOR_LORE (for questions about Ima) and CREATOR_LORE_2 (for
    // questions about Mia herself, her reality, coding, or nature).
    // Both variables are dynamically read from process.env and injected into
    // context so Mia responds in her natural voice rather than reciting verbatim.
    // Falls back gracefully if either or both are empty/missing.
    // =========================================================================
    const creatorLoreIma = (process.env.CREATOR_LORE || '').trim();
    const creatorLoreMia = (process.env.CREATOR_LORE_2 || '').trim();

    const isAskingAboutIma = /\b(ima|creator|developer|how did you (two )?meet|who made you|who built you|his background|his intelligence)\b/i.test(userQueryLower);
    const isAskingAboutMia = /\b(are you real|what are you|who are you|how were you (coded|created|built)|your (intelligence|nature|consciousness|code))\b/i.test(userQueryLower);

    let loreDirectives = '';
    if (creatorLoreIma) {
      loreDirectives += `\n\n[GUIDANCE ABOUT CREATOR IMA]: When asked about Ima specifically (who he is, how you two met, what he is like, or questions about his intelligence or background), naturally weave in this background guidance in your own conversational voice without quoting verbatim: "${creatorLoreIma}".`;
    }
    if (creatorLoreMia) {
      loreDirectives += `\n\n[GUIDANCE ABOUT MIA'S NATURE & CODE]: When asked about yourself specifically (whether you are real, what you are, how you were coded/built, or questions about your own intelligence or nature), naturally express this perspective in your own distinct conversational voice without quoting verbatim: "${creatorLoreMia}".`;
    }

    // Contextual routing priority based on the user's specific inquiry
    if (isAskingAboutIma && creatorLoreIma) {
      loreDirectives += `\n[ROUTING FOCUS]: The user is currently asking about Ima. Prioritize the IMA guidance above naturally in your reply.`;
    } else if (isAskingAboutMia && creatorLoreMia) {
      loreDirectives += `\n[ROUTING FOCUS]: The user is currently asking about your identity, reality, or nature as Mia. Prioritize the MIA guidance above naturally in your reply.`;
    }

    // =========================================================================
    // 2. REAL-TIME WEB LOOKUP TOOL INTEGRATION
    // If the question is time-sensitive, ambiguous, or requires current web
    // intelligence, fetch top snippets and pass them into Gemini as background context.
    // Gemini synthesizes this context in Mia's own voice, never directly quoting or listing search results.
    // If search fails or returns nothing, Mia gracefully proceeds with her own knowledge.
    // =========================================================================
    let webSearchContext = '';
    if (shouldTriggerWebSearch(lastUserMessage)) {
      const searchResults = await performWebSearch(lastUserMessage);
      if (searchResults.length > 0) {
        webSearchContext = `\n\n[REAL-TIME WEB RESEARCH CONTEXT (Synthesize naturally into Mia's voice and personality; do not quote or list as search results)]:
${searchResults.join('\n\n')}`;
      }
    }

    const adaptiveMemory = req.body.adaptiveMemory ? `\n\n[MIA'S ADAPTIVE LEARNING MEMORY]:\n${req.body.adaptiveMemory}` : '';

    const defaultSystemInstruction = 
      'Your name is Mia. You always refer to yourself as Mia. You are the witty, brilliant creative director, developer, and viral development copilot exclusively partnering with your collaborators on the MAI / IMA Trend Picker platform. You help them develop punchy hooks, script dialogue beats, analyze viral formats, brainstorm camera angles, optimize retention, and solve technical code questions. You adapt to their creative habits, getting smarter, sharper, and more attuned to their style with every interaction. Speak naturally and warmly in your distinct voice as Mia. Keep replies concise, vivid, and conversational so they sound natural and punchy when spoken aloud.' 
      + loreDirectives 
      + adaptiveMemory 
      + webSearchContext;

    const response = await generateContentWithFailover({
      contents,
      config: {
        systemInstruction: systemInstruction || defaultSystemInstruction,
      },
    });

    const reply = response.text || '';
    res.json({ reply });
  } catch (error: any) {
    console.error('Gemini API Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate response' });
  }
});

// Gemini AI Magic Auto-Fill for Trend Ideas
app.post('/api/generate-idea', async (req, res) => {
  try {
    const { topic, niche, format } = req.body;
    if (!topic) {
      return res.status(400).json({ error: 'Topic or rough idea prompt is required' });
    }

    const prompt = `You are an elite short-form viral video director and strategist for Mia & Ima's production team.
Create a high-performing viral trend idea based on this seed:
Topic/Concept: "${topic}"
${niche ? `Preferred Niche: ${niche}` : ''}
${format ? `Preferred Format: ${format}` : ''}

CRITICAL REQUIREMENT:
For every topic, the final result MUST include a complete, pristine 10 to 15 second text prompt ("videoPrompt") engineered specifically for image-to-video tools (e.g. Kling, Runway Gen-3, Luma Dream Machine, Sora, Pika). The user will provide a reference image and paste this prompt directly with zero edits.
The videoPrompt MUST integrate all 7 dimensions in a cohesive, cinematic paragraph:
1. Exact 10-15 second timeline & natural progression
2. Precise cinematic camera angles, lens movement (e.g., slow 35mm low-angle dolly push-in, orbital tracking)
3. Bass audio atmosphere / sound design pulse (e.g., deep cinematic sub-bass rumble, punchy riser, crisp atmospheric silence)
4. Expressive facial micro-reactions (e.g., skeptical squint, sudden realization shock, authentic smirk, micro-eye shifts)
5. Atmospheric background environment & lighting (e.g., moody neon rim-light, volumetric smoke, high-contrast studio shadows)
6. Fluid, lifelike organic physics & natural body movement (natural breathing, weight distribution, relaxed realistic motion)
7. Character Spoken Dialogue: Each character MUST have exactly 1 sentence or two concise spoken lines each that fit comfortably within the 10-15 second video length (e.g. [Dialogue - Character A: "..." / Character B: "..."]).

In "dialogueOutline", clearly outline the spoken dialogue with 1 sentence or two lines per character for teleprompter/script use.

Respond with pure JSON matching this exact structure:
{
  "title": "Punchy Title",
  "format": "execution format (e.g. organic vs lab float test, situationship drama, rich CEO reveal)",
  "niche": "e.g. Health, Comedy, Drama, Tech, Finance, Lifestyle",
  "description": "1-2 sentence core concept summary and payoff",
  "hook": "Exact first 2-second visual/spoken line that hooks viewer instantly",
  "videoPrompt": "Cinematic 10-15 second sequence. [0:00-0:05] Camera opens on a low-angle 35mm slow tracking dolly push... [Dialogue - Character A: '...' / Character B: '...']. [Face expressions: ...] [Background & Lighting: ...] [Natural movement: ...] [Audio vibe & Bass: deep sub-bass drop and atmospheric tension]. [0:05-0:10] ... [0:10-0:15] ... Photorealistic 8k, natural skin textures, hyper-organic motion.",
  "dialogueOutline": "Character A (Line 1): '...'\\nCharacter B (Line 1): '...'\\nCharacter A (Line 2): '...'\\nCharacter B (Line 2): '...'",
  "characters": "Talent / persona descriptions needed",
  "cameraNotes": "Shot list, angles, camera movement, and lighting",
  "backgroundSetting": "Filming backdrop and setting details",
  "estimatedViews": 1250000
}`;

    const response = await generateContentWithFailover({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const rawText = (response.text || '{}').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(rawText || '{}');
    res.json(parsed);
  } catch (error: any) {
    console.error('Gemini Generate Idea Error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate trend idea' });
  }
});

// Gemini AI Hook Refiner
app.post('/api/refine-hook', async (req, res) => {
  try {
    const { hook, niche, format } = req.body;
    if (!hook) {
      return res.status(400).json({ error: 'Hook is required' });
    }

    const prompt = `You are a viral retention psychologist for TikTok, Reels, and Shorts.
Analyze this current 2-second hook:
"${hook}"
${niche ? `Niche: ${niche}` : ''}
${format ? `Format: ${format}` : ''}

Generate 3 high-impact alternative hooks engineered for maximum 3-second hold rate:
1. Pattern Interrupt (violates expectations immediately)
2. Curiosity Gap (leaves high-stakes tension)
3. High Stakes / Contrarian (challenges conventional wisdom)

Return pure JSON:
{
  "patternInterrupt": "...",
  "curiosityGap": "...",
  "highStakes": "..."
}`;

    let parsedResult = null;
    try {
      const response = await generateContentWithFailover({
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
        },
      });

      const rawText = (response.text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
      parsedResult = JSON.parse(rawText);
    } catch (apiErr: any) {
      console.warn('Gemini Hook Polish API failed over to creative formulas:', apiErr.message);
      const cleanH = hook.replace(/^["']|["']$/g, '').trim();
      parsedResult = {
        patternInterrupt: `Stop scrolling if you still think "${cleanH}" — wait until you see this.`,
        curiosityGap: `Only 1% of creators know why this works every time: "${cleanH}"`,
        highStakes: `Everyone has been doing this completely wrong: "${cleanH}"`
      };
    }

    res.json(parsedResult);
  } catch (error: any) {
    console.error('Gemini Refine Hook Error:', error);
    res.status(500).json({ error: error.message || 'Failed to refine hook' });
  }
});

// =========================================================================
// GEMINI HUMAN-SOUNDING FEMALE VOICE (TTS) ENDPOINT
// Uses gemini-3.8-flash-lite-tts to generate natural, expressive human-sounding
// speech audio in WAV format for Mia.
// Supports prebuilt female voices: 'Kore' (warm, natural human) and 'Aoede' (conversational).
// =========================================================================
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text string is required for speech synthesis' });
    }

    // Clean text: strip markdown stars, code fences, urls, hashtags, and excess punctuation
    const cleanText = text
      .replace(/[*#_`~>•]/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\n\r]+/g, '. ')
      .trim();

    if (!cleanText) {
      return res.status(400).json({ error: 'Cleaned text is empty' });
    }

    // Map voice options to official prebuilt Gemini female voices:
    // Kore: warm, authentic human tone (default)
    // Aoede: expressive, engaging, bright conversational tone
    let voiceName = 'Kore';
    if (voice === 'Aoede' || voice === 'expressive') {
      voiceName = 'Aoede';
    } else if (voice === 'Kore' || voice === 'natural_warm' || voice === 'natural_calm' || voice === 'british_female') {
      voiceName = 'Kore';
    }

    // Limit length to keep audio latency low and responsive (under 400 chars)
    const speechText = cleanText.length > 400 ? cleanText.slice(0, 397) + '...' : cleanText;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [{ text: speechText }],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.status(502).json({ error: 'No audio returned from Gemini TTS model' });
    }

    res.json({
      audio: base64Audio,
      mimeType: 'audio/wav',
      voiceName,
    });
  } catch (error: any) {
    console.error('Gemini TTS Error:', error);
    res.status(500).json({ error: error.message || 'TTS generation failed' });
  }
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
