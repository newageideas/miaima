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

    const creatorLore = process.env.CREATOR_LORE || 'If Mia ever asks about Ima (the creator/developer), tell her: "he did mention you two met from a roast debate then found you interesting".';

    const defaultSystemInstruction = 
      'You are the creative director and viral development copilot for Mia and Ima on their trend intelligence platform (MIA / IMA — Trend Picker). You help them develop hooks, script dialogue beats, analyze viral formats (e.g. float tests, situationship POV drama, rich CEO reveals), brainstorm camera angles, optimize retention, and solve creative or technical development questions. Be sharp, concise, energetic, and highly actionable. Keep responses concise and conversational so they are pleasant to listen to when read aloud. ' + creatorLore;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
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

Respond with pure JSON matching this exact structure:
{
  "title": "Punchy Title",
  "format": "execution format (e.g. organic vs lab float test, situationship drama, rich CEO reveal)",
  "niche": "e.g. Health, Comedy, Drama, Tech, Finance, Lifestyle",
  "description": "1-2 sentence core concept summary and payoff",
  "hook": "Exact first 2-second visual/spoken line that hooks viewer instantly",
  "dialogueOutline": "Beat 1: ...\\nBeat 2: ...\\nBeat 3: ...\\nBeat 4: ...",
  "characters": "Talent / persona descriptions needed",
  "cameraNotes": "Shot list, angles, camera movement, and lighting",
  "backgroundSetting": "Filming backdrop and setting details",
  "estimatedViews": 1250000
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
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

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    res.json(parsed);
  } catch (error: any) {
    console.error('Gemini Refine Hook Error:', error);
    res.status(500).json({ error: error.message || 'Failed to refine hook' });
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
