# Fatos ao vivo

Placar ao vivo das checagens do [checagemaovivo.org](https://www.checagemaovivo.org): quantidade e porcentagem de **Fato**, **Fake** e **Não é bem assim**, no total e por candidato. Atualiza a cada 10 segundos.

Não espelha o site: o servidor busca só o placar público da sala (`/api/stream/public/rooms/<sala>/manifest.json`) com cache de 10 s compartilhado entre todos os visitantes, e a página dá o crédito com link para o original.

## Rodar

```bash
npm start          # http://localhost:3000
```

Sem dependências — só Node 20+.

## Deploy no Railway

New Project → Deploy from GitHub repo → `fatosaovivo`. O `railway.json` define o start e o healthcheck (`/health`); a `PORT` é injetada pelo Railway. Depois: Settings → Networking → Generate Domain.

## Variáveis (opcionais)

| Variável | Padrão | Para quê |
|---|---|---|
| `SOURCE_ORIGIN` | `https://www.checagemaovivo.org` | origem dos dados |
| `CACHE_MS` | `10000` | intervalo mínimo entre consultas à fonte |

## Rotas

- `/` — a página do placar (`?sala=<id>` fixa uma sala; sem isso, a que está ao vivo ou a mais recente)
- `/api/placar` — o placar em JSON
- `/health` — healthcheck

## Limites

- A ordem dos números por falante (`values` = Fato, Fake, Não é bem assim) foi conferida contra os vereditos das checagens; se a fonte mudar o formato, os rótulos trocam sem erro aparente.
- Checagens inconclusivas ficam fora das porcentagens, como no site original.
