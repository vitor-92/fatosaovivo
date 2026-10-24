// Placar ao vivo das checagens do checagemaovivo.org.
//
// Não espelha o site: busca só o placar público (`manifest.json` da sala) no
// servidor, com cache curto, e serve uma página própria com o crédito e o
// link para o original. Todos os visitantes compartilham a mesma consulta a
// cada CACHE_MS — a fonte não recebe uma requisição por pessoa.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const SOURCE = (process.env.SOURCE_ORIGIN ?? 'https://www.checagemaovivo.org').replace(/\/$/, '');
const API = `${SOURCE}/api/stream/public`;
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

async function fetchPlacar(roomId) {
  const id = roomId ?? pickRoom((await getJson(`${API}/rooms.json`)).rooms ?? [])?.id;
  if (!id) throw new Error('nenhuma sala publicada');
  const m = await getJson(`${API}/rooms/${encodeURIComponent(id)}/manifest.json`);
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
    sourceUpdatedAt: m.updatedAt ?? null,
    fetchedAt: new Date().toISOString(),
    source: SOURCE,
  };
}

// cache por sala; uma busca em andamento é compartilhada por quem chegar junto
const cache = new Map();
async function placar(roomId) {
  const key = roomId ?? '';
  const hit = cache.get(key);
  if (hit?.data && Date.now() - hit.at < CACHE_MS) return hit.data;
  if (hit?.pending) return hit.pending;
  const pending = fetchPlacar(roomId)
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      // fonte fora do ar: segue servindo o último placar, marcado como antigo
      if (hit?.data) {
        cache.set(key, { ...hit, pending: null });
        return { ...hit.data, stale: true, error: err.message };
      }
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ...hit, pending });
  return pending;
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') return send(res, 200, 'text/plain', 'ok');
  if (url.pathname === '/api/placar') {
    const sala = url.searchParams.get('sala');
    if (sala && !/^[\w-]{1,80}$/.test(sala)) return send(res, 400, 'application/json', '{"error":"sala inválida"}');
    try {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await placar(sala)));
    } catch (err) {
      return send(res, 502, 'application/json; charset=utf-8', JSON.stringify({ error: err.message }));
    }
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, 'text/html; charset=utf-8', INDEX);
  send(res, 404, 'text/plain; charset=utf-8', 'não encontrado');
}).listen(PORT, () => console.log(`placar em http://localhost:${PORT} (fonte: ${SOURCE})`));
