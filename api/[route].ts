// Vercel serverless entry for all Mia AI routes: /api/chat, /api/generate-idea,
// /api/refine-hook, /api/tts, /api/health. (server.ts stays for AI Studio / local dev.)
import { GoogleGenAI } from '@google/genai';

const TEXT_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-3.8-flash'];
const GATEWAY_MODEL = 'google/gemini-2.5-flash';

function geminiKey(): string | undefined {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.API_KEY9;
  return k && !k.startsWith('MY_') ? k.trim() : undefined;
}
function gatewayToken(req: any): string | undefined {
  return process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || req?.headers?.['x-vercel-oidc-token'];
}

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: geminiKey() });
  return _ai;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms on ${label}`)), ms))]);
}

/** Text generation with Gemini model failover, then Vercel AI Gateway fallback. */
async function generate(req: any, opts: { system?: string; contents: any; json?: boolean }): Promise<string> {
  const errors: string[] = [];
  if (geminiKey()) {
    for (const model of TEXT_MODELS) {
      try {
        const r: any = await withTimeout(ai().models.generateContent({
          model, contents: opts.contents,
          config: { ...(opts.system ? { systemInstruction: opts.system } : {}), ...(opts.json ? { responseMimeType: 'application/json' } : {}) },
        }), 12000, model);
        if (r?.text) return r.text;
      } catch (e: any) { errors.push(`${model}: ${e?.message || e}`.slice(0, 200)); }
    }
  }
  const tok = gatewayToken(req);
  if (tok) {
    try {
      const msgs: any[] = [];
      if (opts.system) msgs.push({ role: 'system', content: opts.system });
      if (typeof opts.contents === 'string') msgs.push({ role: 'user', content: opts.contents });
      else for (const c of opts.contents) msgs.push({ role: c.role === 'model' ? 'assistant' : 'user', content: c.parts.map((p: any) => p.text).join('\n') });
      const r = await withTimeout(fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ model: GATEWAY_MODEL, messages: msgs, ...(opts.json ? { response_format: { type: 'json_object' } } : {}) }),
      }), 20000, 'ai-gateway');
      const d: any = await r.json().catch(() => ({}));
      if (r.ok && d?.choices?.[0]?.message?.content) return d.choices[0].message.content;
      errors.push(`gateway ${r.status}: ${JSON.stringify(d?.error || d).slice(0, 200)}`);
    } catch (e: any) { errors.push(`gateway: ${e?.message || e}`); }
  }
  if (!geminiKey() && !tok) throw Object.assign(new Error('NO_AI_KEY'), { code: 'NO_AI_KEY' });
  throw new Error(errors.join(' | ') || 'All model attempts failed');
}

function parseJson(t: string): any {
  const s = (t || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ---------------- web search (unchanged behaviour from server.ts) ----------------
function shouldSearch(q: string) {
  if (!q || q.trim().length < 4) return false;
  if (/^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|bye)$/i.test(q.trim())) return false;
  if (/\b(ima|who are you|what are you|creator)\b/i.test(q)) return false;
  return [/\b(latest|recent|today|yesterday|current(ly)?|right now|this week|this month|2025|2026|2027)\b/i,
    /\b(trending|viral|what happened|news about|who won|price of)\b/i,
    /\b(what does .+ mean|slang)\b/i, /\b(release date|when does .+ come out)\b/i].some(r => r.test(q));
}
async function webSearch(query: string): Promise<string[]> {
  const key = process.env.SEARCH_API_KEY; if (!key) return [];
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
    let out: string[] = [];
    if (key.startsWith('tvly-')) {
      const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 3 }), signal: ctl.signal });
      if (r.ok) out = ((await r.json() as any).results || []).map((x: any) => `${x.title}: ${x.content || ''}`);
    } else if (process.env.SEARCH_ENGINE_ID) {
      const r = await fetch(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(process.env.SEARCH_ENGINE_ID)}&q=${encodeURIComponent(query)}&num=3`, { signal: ctl.signal });
      if (r.ok) out = ((await r.json() as any).items || []).map((x: any) => `${x.title}: ${x.snippet || ''}`);
    } else if (key.startsWith('BSA')) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: ctl.signal });
      if (r.ok) out = (((await r.json() as any).web?.results) || []).map((x: any) => `${x.title}: ${x.description || ''}`);
    } else {
      const r = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(key)}&num=3`, { signal: ctl.signal });
      if (r.ok) out = ((await r.json() as any).organic_results || []).map((x: any) => `${x.title}: ${x.snippet || ''}`);
    }
    clearTimeout(t);
    return out.filter(Boolean).slice(0, 3);
  } catch { return []; }
}

// ---------------- Mia system prompt ----------------
const ACTION_SPEC = `
PAGE EDITING: You can edit the live MAI / IMA page. The user message includes PAGE_CONTEXT: a list of editable elements
(each has an "id" like "m12", its tag, and current text) plus the theme CSS variables. When the user asks to change
the page (text, wording, colors, theme, fonts, size, hide/show, images, add a note/section, add a trend idea), return actions.
Allowed action objects (use ONLY ids that appear in PAGE_CONTEXT; never invent ids):
 {"type":"set_text","target":"m12","value":"new text"}
 {"type":"set_style","target":"m12","property":"color|background|font-size|font-weight|font-family|letter-spacing|text-transform|border-radius|padding|text-align|opacity","value":"css value"}
 {"type":"set_css_var","name":"--accent-cyan","value":"#ff4fd8"}   (theme-wide colors; prefer this for "change the theme/accent/background")
 {"type":"hide","target":"m12"} / {"type":"show","target":"m12"}
 {"type":"set_image","target":"m12","src":"https://..."}  (only for img targets, only https URLs the user gave)
 {"type":"insert_block","after":"m12","heading":"short title","body":"plain text"}
 {"type":"add_idea","idea":{"title":"","niche":"","format":"","description":"","hook":"","dialogueOutline":"","videoPrompt":"","characters":"","cameraNotes":"","backgroundSetting":"","estimatedViews":500000}}
 {"type":"reset_edits"}  (only if the user explicitly asks to undo everything / restore original)
Rules: keep actions minimal and precise; for vague requests pick sensible tasteful values and say what you chose;
if a request is ambiguous ask one short question and return no actions; never output HTML or scripts.
The user previews edits and can Apply or Undo, so describe the change in "reply" in one or two short sentences.
OUTPUT: always pure JSON: {"reply":"what you say to the user","actions":[ ... ]} ("actions" is [] when just chatting).`;

function miaSystem(lore: string, memory: string, web: string) {
  return `Your name is Mia. You always refer to yourself as Mia. You are the witty, brilliant creative director, developer and viral-content copilot inside the MAI / IMA Trend Picker — a dashboard where Mia & Ima collect viral short-form trend ideas (title, niche, format, 2-second hook, dialogue beats, a 10–15s image-to-video prompt, characters, camera notes, setting, est. views) and move them through Pending → Picked → In Production → Done (Feed or Pipeline board, teleprompter mode, JSON export).
You help punch up hooks, script dialogue, analyze viral formats, plan camera angles, optimize retention, answer code/dev questions, and edit this page on request.
Be concise, vivid, warm and practical (replies may be read aloud: no markdown tables, keep under ~120 words unless asked for detail). Use the conversation history; remember what was said earlier in this session. Never claim you did something you did not do. If you don't know current facts, say so.` + ACTION_SPEC + lore + memory + web;
}

async function readBody(req: any) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}

export default async function handler(req: any, res: any) {
  const route = String(req.query?.route || '').replace(/\/$/, '');
  res.setHeader('Cache-Control', 'no-store');
  if (route === 'health') {
    return res.status(200).json({ ok: true, gemini: !!geminiKey(), gateway: !!gatewayToken(req), search: !!process.env.SEARCH_API_KEY });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const body = await readBody(req);
  try {
    if (route === 'chat') return await chat(req, res, body);
    if (route === 'generate-idea') return await generateIdea(req, res, body);
    if (route === 'refine-hook') return await refineHook(req, res, body);
    if (route === 'tts') return await tts(res, body);
    return res.status(404).json({ error: 'Unknown API route' });
  } catch (e: any) {
    if (e?.code === 'NO_AI_KEY') return res.status(503).json({ error: 'AI is not configured yet: add GEMINI_API_KEY in Vercel project settings.', code: 'NO_AI_KEY' });
    console.error(`[api/${route}]`, e);
    return res.status(502).json({ error: 'Mia could not reach the AI model right now. Please try again in a moment.', detail: String(e?.message || e).slice(0, 300) });
  }
}

async function chat(req: any, res: any, body: any) {
  const messages = Array.isArray(body.messages) ? body.messages.slice(-24) : null;
  if (!messages || !messages.length) return res.status(400).json({ error: 'Messages array is required' });
  const last = [...messages].reverse().find((m: any) => m.role === 'user')?.content || '';
  const loreIma = (process.env.CREATOR_LORE || '').trim();
  const loreMia = (process.env.CREATOR_LORE_2 || '').trim();
  let lore = '';
  if (loreIma) lore += `\n\n[GUIDANCE ABOUT CREATOR IMA]: When asked about Ima (who he is, how you met, his background), weave this in naturally in your own words, never verbatim: "${loreIma}".`;
  if (loreMia) lore += `\n\n[GUIDANCE ABOUT MIA'S NATURE & CODE]: When asked about yourself (are you real, how you were built), express this perspective in your own words: "${loreMia}".`;
  const memory = body.adaptiveMemory ? `\n\n[MIA'S ADAPTIVE LEARNING MEMORY — the team's preferences]:\n- ${String(body.adaptiveMemory).slice(0, 3000)}` : '';
  let web = '';
  if (shouldSearch(last)) { const s = await webSearch(last); if (s.length) web = `\n\n[REAL-TIME WEB CONTEXT — synthesize naturally, don't list]:\n${s.join('\n\n')}`; }

  const contents = messages.map((m: any, i: number) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').slice(0, 6000) + (i === messages.length - 1 && body.pageContext ? `\n\nPAGE_CONTEXT:\n${JSON.stringify(body.pageContext).slice(0, 14000)}` : '') }],
  }));
  if (typeof body.code === 'string' && body.code.trim()) {
    // Pasted-code review: chunk long code into ~15k-char parts (max ~120k chars) so nothing is silently cut mid-line.
    const code = body.code.slice(0, 120000);
    const parts: any[] = [];
    for (let i = 0; i < code.length; i += 15000) parts.push({ text: `[PASTED CODE part ${parts.length + 1}]\n` + code.slice(i, i + 15000) });
    parts.push({ text: `[END OF PASTED CODE — ${body.code.length} chars${body.code.length > code.length ? ', truncated for review' : ''}]. Local scanner flagged: ${JSON.stringify(body.risks || [])}.
Explain in plain words what this code does and what it would look like on the page, call out anything risky (external requests, data collection, tracking, obfuscation, crypto-mining, redirects) or broken, and suggest the best place to insert it using an element id from PAGE_CONTEXT. Put that id in actions as {"type":"suggest_insert","after":"mXX","position":"after|before"} — never any other action for pasted code.` });
    contents.push({ role: 'user', parts });
  }
  const text = await generate(req, { system: miaSystem(lore, memory, web), contents, json: true });
  const parsed = parseJson(text);
  if (parsed && typeof parsed.reply === 'string') {
    return res.status(200).json({ reply: parsed.reply, actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 25) : [] });
  }
  return res.status(200).json({ reply: text, actions: [] });
}

async function generateIdea(req: any, res: any, body: any) {
  const { topic, niche, format } = body;
  if (!topic) return res.status(400).json({ error: 'Topic or rough idea prompt is required' });
  const prompt = `You are an elite short-form viral video director and strategist for Mia & Ima's production team.
Create a high-performing viral trend idea based on this seed:
Topic/Concept: "${topic}"
${niche ? `Preferred Niche: ${niche}` : ''}
${format ? `Preferred Format: ${format}` : ''}
The result MUST include "videoPrompt": a pristine 10-15 second image-to-video prompt (Kling/Runway/Luma/Sora/Pika) covering: timeline, camera angles & lens movement, bass/sound design, facial micro-reactions, background & lighting, natural physics/movement, and 1-2 spoken lines per character ([Dialogue - Character A: "..." / Character B: "..."]).
"dialogueOutline" lists the spoken lines per character for teleprompter use.
Respond with pure JSON: {"title":"","format":"","niche":"","description":"","hook":"","videoPrompt":"","dialogueOutline":"","characters":"","cameraNotes":"","backgroundSetting":"","estimatedViews":1250000}`;
  const parsed = parseJson(await generate(req, { contents: prompt, json: true }));
  if (!parsed) return res.status(502).json({ error: 'Model returned an unreadable idea, please retry.' });
  return res.status(200).json(parsed);
}

async function refineHook(req: any, res: any, body: any) {
  const { hook, niche, format } = body;
  if (!hook) return res.status(400).json({ error: 'Hook is required' });
  let out: any = null;
  try {
    out = parseJson(await generate(req, { json: true, contents: `You are a viral retention psychologist for TikTok, Reels and Shorts. Current 2-second hook: "${hook}" ${niche ? `Niche: ${niche}` : ''} ${format ? `Format: ${format}` : ''}
Return pure JSON with 3 alternatives: {"patternInterrupt":"...","curiosityGap":"...","highStakes":"..."}` }));
  } catch {}
  if (!out) {
    const h = String(hook).replace(/^["']|["']$/g, '').trim();
    out = { patternInterrupt: `Stop scrolling if you still think "${h}" — wait until you see this.`, curiosityGap: `Only 1% of creators know why this works every time: "${h}"`, highStakes: `Everyone has been doing this completely wrong: "${h}"` };
  }
  return res.status(200).json(out);
}

async function tts(res: any, body: any) {
  const { text, voice } = body;
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text string is required for speech synthesis' });
  if (!geminiKey()) return res.status(503).json({ error: 'Gemini voice needs GEMINI_API_KEY; using browser voice.', code: 'NO_AI_KEY' });
  const clean = text.replace(/[*#_`~>•]/g, '').replace(/https?:\/\/\S+/g, '').replace(/[\n\r]+/g, '. ').trim();
  if (!clean) return res.status(400).json({ error: 'Cleaned text is empty' });
  const voiceName = voice === 'Aoede' || voice === 'expressive' ? 'Aoede' : 'Kore';
  const speech = clean.length > 400 ? clean.slice(0, 397) + '...' : clean;
  let lastErr: any;
  for (const model of ['gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-lite-tts']) {
    try {
      const r: any = await withTimeout(ai().models.generateContent({
        model, contents: [{ role: 'user', parts: [{ text: speech }] }],
        config: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
      }), 15000, model);
      const part = r?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (part?.data) return res.status(200).json({ audio: toWav(part.data, part.mimeType), mimeType: 'audio/wav', voiceName });
    } catch (e) { lastErr = e; }
  }
  return res.status(502).json({ error: 'No audio returned from Gemini TTS', detail: String(lastErr?.message || '').slice(0, 200) });
}

/** Gemini TTS returns raw 16-bit PCM (audio/L16;rate=24000). Wrap it in a WAV header so <audio> can play it. */
function toWav(b64: string, mime?: string): string {
  if (mime && /wav/i.test(mime)) return b64;
  const pcm = Buffer.from(b64, 'base64');
  const rate = Number((mime || '').match(/rate=(\d+)/)?.[1] || 24000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
}
