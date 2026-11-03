// Shared "Code notes" inbox, stored server-side in a private Vercel Blob store.
// Open access (Ima's choice): anyone with the link can view/add. Abuse guards: honeypot field,
// per-IP rate limit (best-effort, per function instance), 500 KB max note, delete needs confirm:true.
import { put, list, del, get } from '@vercel/blob';
import { randomUUID } from 'crypto';

const MAX_BYTES = 500 * 1024;
const hits = new Map<string, number[]>();
function limited(ip: string, max: number, windowMs: number) {
  const now = Date.now(); const arr = (hits.get(ip) || []).filter(t => now - t < windowMs);
  arr.push(now); hits.set(ip, arr); if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

const PREFIX = 'code-notes/';

async function readNote(pathname: string) {
  const r: any = await get(pathname, { access: 'private' });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'Blob storage not connected (BLOB_READ_WRITE_TOKEN).' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (req.method !== 'GET' && limited(ip, 12, 10 * 60 * 1000)) return res.status(429).json({ error: 'Too many saves — wait a few minutes and try again.' });
  if (req.method === 'GET' && limited('r:' + ip, 120, 60 * 1000)) return res.status(429).json({ error: 'Slow down a little.' });
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: PREFIX, limit: 200 });
      blobs.sort((x: any, y: any) => +new Date(y.uploadedAt) - +new Date(x.uploadedAt));
      const notes = (await Promise.all(blobs.slice(0, 100).map((b: any) => readNote(b.pathname).catch(() => null)))).filter(Boolean);
      return res.status(200).json({ notes });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.website) return res.status(201).json({ ok: true }); // honeypot: bots fill hidden field
      const code = typeof b.code === 'string' ? b.code : '';
      if (Buffer.byteLength(code) > MAX_BYTES) return res.status(413).json({ error: 'That note is over 500 KB — split it into two notes.' });
      if (!code.trim()) return res.status(400).json({ error: 'Code is empty' });
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const note = { id, author: String(b.author || 'Anonymous').slice(0, 60), title: String(b.title || 'Untitled snippet').slice(0, 120), createdAt: new Date().toISOString(), code };
      await put(`${PREFIX}${id}.json`, JSON.stringify(note), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
      return res.status(201).json({ note });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (String(req.query?.confirm) !== 'yes') return res.status(400).json({ error: 'Delete needs confirmation.' });
      if (!/^[\w-]+$/.test(id)) return res.status(400).json({ error: 'Bad id' });
      await del(`${PREFIX}${id}.json`);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[api/notes]', e);
    return res.status(500).json({ error: 'Storage error, please retry.', detail: String(e?.message || e).slice(0, 200) });
  }
}
