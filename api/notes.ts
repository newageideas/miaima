// Shared "Code notes" inbox, stored server-side in a private Vercel Blob store.
// Protected by the shared passcode in env CODE_NOTES_PASSCODE (sent as header x-notes-passcode).
import { put, list, del, get } from '@vercel/blob';
import { timingSafeEqual, randomUUID } from 'crypto';

const PREFIX = 'code-notes/';

function authed(req: any) {
  const want = process.env.CODE_NOTES_PASSCODE || '';
  const got = String(req.headers['x-notes-passcode'] || '');
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readNote(pathname: string) {
  const r: any = await get(pathname, { access: 'private' });
  if (!r || r.statusCode !== 200) return null;
  return JSON.parse(await new Response(r.stream).text());
}

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CODE_NOTES_PASSCODE) return res.status(503).json({ error: 'Code notes passcode not configured (CODE_NOTES_PASSCODE).' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'Blob storage not connected (BLOB_READ_WRITE_TOKEN).' });
  if (!authed(req)) { await new Promise(r => setTimeout(r, 400)); return res.status(401).json({ error: 'Wrong passcode' }); }
  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: PREFIX, limit: 200 });
      blobs.sort((x: any, y: any) => +new Date(y.uploadedAt) - +new Date(x.uploadedAt));
      const notes = (await Promise.all(blobs.slice(0, 100).map((b: any) => readNote(b.pathname).catch(() => null)))).filter(Boolean);
      return res.status(200).json({ notes });
    }
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const code = typeof b.code === 'string' ? b.code : '';
      if (!code.trim()) return res.status(400).json({ error: 'Code is empty' });
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const note = { id, author: String(b.author || 'Anonymous').slice(0, 60), title: String(b.title || 'Untitled snippet').slice(0, 120), createdAt: new Date().toISOString(), code };
      await put(`${PREFIX}${id}.json`, JSON.stringify(note), { access: 'private', contentType: 'application/json', addRandomSuffix: false });
      return res.status(201).json({ note });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
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
