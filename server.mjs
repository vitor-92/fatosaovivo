// Placar ao vivo das checagens do checagemaovivo.org.
//
// Não espelha o site: busca só os dados públicos da sala (manifest.json e os
// blocos de checagens) no servidor, com cache, e serve uma página própria com
// o crédito e o link para o original. Todos os visitantes compartilham a mesma
// consulta a cada CACHE_MS — a fonte não recebe uma requisição por pessoa.
//
// Da checagem só sai o que identifica a fala (frase, falante, veredito,
// horário, tipo de revisão). Explicação, relatório e fontes são o trabalho
// editorial do site: ficam lá, e a página leva o leitor até ele.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const SOURCE = (process.env.SOURCE_ORIGIN ?? 'https://www.checagemaovivo.org').replace(/\/$/, '');
const API = `${SOURCE}/api/stream`;
const PORT = Number(process.env.PORT ?? 3000);
const CACHE_MS = Number(process.env.CACHE_MS ?? 10_000);
const INDEX = readFileSync(new URL('./public/index.html', import.meta.url));

async function getJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'fatosaovivo-placar' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${res.status} em ${url.replace(SOURCE, '')}`);
  return res.json();
}

/** Sala ao vivo; sem nenhuma ao vivo, a que começou por último. */
function pickRoom(rooms) {
  const live = rooms.find((r) => r.status === 'live');
  if (live) return live;
  return [...rooms].sort((a, b) => String(b.startedAt ?? b.scheduledAt).localeCompare(String(a.startedAt ?? a.scheduledAt)))[0];
}

/**
 * Busca com cache curto e busca em andamento compartilhada. Fonte fora do ar:
 * segue servindo o último valor, marcado como antigo.
 */
function cached(fn) {
  const cache = new Map();
  return async (key) => {
    const hit = cache.get(key);
    if (hit?.data && Date.now() - hit.at < CACHE_MS) return hit.data;
    if (hit?.pending) return hit.pending;
    const pending = fn(key)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });
        return data;
      })
      .catch((err) => {
        if (hit?.data) {
          cache.set(key, { ...hit, pending: null });
          return { ...hit.data, stale: true, error: err.message };
        }
        cache.delete(key);
        throw err;
      });
    cache.set(key, { ...hit, pending });
    return pending;
  };
}

const manifest = cached(async (roomId) => {
  const id = roomId || pickRoom((await getJson(`${API}/public/rooms.json`)).rooms ?? [])?.id;
  if (!id) throw new Error('nenhuma sala publicada');
  return { id, m: await getJson(`${API}/public/rooms/${encodeURIComponent(id)}/manifest.json`) };
});

// blocos têm o hash do conteúdo no nome: imutáveis, então cada um é baixado
// uma vez. O teto só evita crescer sem fim num processo que fica dias no ar
const blocks = new Map();
const MAX_BLOCKS = 200;
async function getBlock(path) {
  if (!/^\/public\/rooms\/[\w-]+\/blocks\/[a-f0-9]{16,}\.json$/.test(path)) throw new Error('bloco inválido');
  if (!blocks.has(path)) {
    if (blocks.size >= MAX_BLOCKS) blocks.delete(blocks.keys().next().value);
    blocks.set(path, getJson(API + path).catch((err) => {
      blocks.delete(path);
      throw err;
    }));
  }
  return blocks.get(path);
}

function placarOf(id, m) {
  const score = m.score ?? {};
  // `values` de cada falante vem na ordem [Fato, Fake, Não é bem assim]
  // (conferido contra os vereditos das checagens: verdadeiro/falso/parcial)
  const speakers = (score.speakers ?? []).map((s) => {
    const [fato = 0, fake = 0, parcial = 0] = s.values ?? [];
    return { id: s.id, name: s.name, fato, fake, parcial, total: fato + fake + parcial };
  });
  const sum = (k) => speakers.reduce((a, s) => a + s[k], 0);
  return {
    room: {
      id,
      title: m.room?.title ?? id,
      status: m.room?.status ?? null,
      topic: m.room?.topic ?? null,
      startedAt: m.room?.startedAt ?? null,
    },
    totals: {
      fato: sum('fato'),
      fake: sum('fake'),
      parcial: sum('parcial'),
      total: sum('total'),
      inconclusivo: score.inconclusive ?? 0,
      pendente: score.pending ?? 0,
    },
    speakers,
    version: m.version ?? m.updatedAt ?? null,
    sourceUpdatedAt: m.updatedAt ?? null,
    fetchedAt: new Date().toISOString(),
    source: SOURCE,
  };
}

const VERDICTS = new Set(['verdadeiro', 'falso', 'parcial', 'inconclusivo']);

async function checagensOf(id, m) {
  const byId = new Map();
  for (const path of m.blocks ?? []) {
    for (const c of (await getBlock(path)).claims ?? []) {
      if (c.publication !== 'published' || !VERDICTS.has(c.verdict)) continue;
      // a mesma checagem revisada em outro bloco: fica a revisão mais nova
      const prev = byId.get(c.id);
      if (prev && (prev.revision ?? 0) >= (c.revision ?? 0)) continue;
      byId.set(c.id, c);
    }
  }
  const items = [...byId.values()]
    .map((c) => ({
      id: c.id,
      quote: String(c.quote ?? '').replace(/\s*\n\s*/g, ' ').trim(),
      speaker: {
        id: c.speaker?.id ?? 'falante-nao-identificado',
        name: c.speaker?.name ?? c.speaker_name ?? 'Não identificado',
      },
      verdict: c.verdict,
      at: c.captured_at ?? null,
      review: c.review === 'reviewed' ? 'IA + Humano' : 'Revisão por IA',
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { room: id, version: m.version ?? m.updatedAt ?? null, items, source: SOURCE };
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');
  if (url.pathname === '/api/placar' || url.pathname === '/api/checagens') {
    const sala = url.searchParams.get('sala') ?? '';
    if (sala && !/^[\w-]{1,80}$/.test(sala)) return json(res, 400, { error: 'sala inválida' });
    try {
      const { id, m, stale, error } = await manifest(sala);
      const data = url.pathname === '/api/placar' ? placarOf(id, m) : await checagensOf(id, m);
      return json(res, 200, stale ? { ...data, stale, error } : data);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', INDEX);
  send(res, 404, 'text/plain; charset=utf-8', 'não encontrado');
}).listen(PORT, () => console.log(`placar em http://localhost:${PORT} (fonte: ${SOURCE})`));
