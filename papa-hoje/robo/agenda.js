// Robô da agenda do Papa — "Papa Hoje: Agenda e História" (SoulfulApps).
// Lê o JSON mensal público do vatican.va (o mesmo que o site carrega no calendário) em pt, es e en,
// junta os idiomas por evento e grava uma agenda normalizada em out/agenda.json.
//
// Fonte: https://www.vatican.va/content/vaticanevents/<lang>/<ano>/<mes>.events.js
// robots.txt do vatican.va: Allow, Crawl-delay 2 → 1 requisição a cada 2,5 s, poucas por execução.
// Direitos: só FATOS (data, hora, local, tipo, título do evento) + link oficial. Nada de texto de homilia,
// foto ou vídeo é copiado.
//
// Uso: node agenda.js [meses=3]   (mês atual + seguintes; inclui o mês anterior para "o que aconteceu")
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.vatican.va';
const LANGS = ['pt', 'es', 'en'];
const UA = 'Mozilla/5.0 (compatible; PapaHojeBot/1.0)';
const GAP_MS = 2500;
const OUT = path.join(__dirname, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,*/*' } });
      if (r.status === 404) return { events: [] };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(await r.text());
    } catch (e) {
      if (tentativa === 2) throw new Error(`${url}: ${e.message}`);
      await sleep(GAP_MS * 2);
    }
  }
}

const stripHtml = (s) => (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').split('\n').map((x) => x.trim()).filter(Boolean);

/** Hora de Roma: a descrição traz "17h00"/"17.00"; o start_date vem com "Z" mas é hora local de Roma (e às vezes errado). */
function horaRoma(ev) {
  const linhas = stripHtml(ev.description);
  for (const l of linhas) {
    const m = /\b(\d{1,2})[h.:](\d{2})\b/.exec(l);
    if (m && Number(m[1]) < 24) return `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  const m = /T(\d{2}):(\d{2})/.exec(ev.start_date || '');
  if (m && !(m[1] === '00' && m[2] === '00')) return `${m[1]}:${m[2]}`;
  return null;
}

/** Local = linhas da descrição que não são hora nem rótulo ("CAPELA PAPAL"). */
function localDe(ev) {
  return stripHtml(ev.description)
    .map((l) => l.replace(/\b\d{1,2}[h.:]\d{2}\b/g, '').replace(/\(\s*(hora local|local time|ora locale|heure locale)[^)]*\)/gi, '').trim())
    .filter((l) => l && !/^(CAPELA PAPAL|CAPILLA PAPAL|PAPAL CHAPEL|CAPPELLA PAPALE)$/i.test(l))
    .slice(0, 1)[0] || null;
}

/** Converte data+hora de Roma para instante UTC (ISO), respeitando horário de verão. */
function romaParaUtc(data, hora) {
  const [y, mo, d] = data.split('-').map(Number);
  const [h, mi] = (hora || '00:00').split(':').map(Number);
  const palpite = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(palpite)).map((x) => [x.type, x.value]));
  const comoRoma = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(palpite - (comoRoma - palpite)).toISOString();
}

function tipoDe(tituloPt, tituloIt) {
  const t = `${tituloPt} ${tituloIt || ''}`.toLowerCase();
  if (/angelus|regina c(a|æ)eli|regina coeli/.test(t)) return 'angelus';
  if (/audi[êe]ncia geral|udienza generale/.test(t)) return 'audiencia';
  if (/viagem apost|visita pastoral|viaggio apost/.test(t)) return 'viagem';
  if (/urbi et orbi/.test(t)) return 'urbi';
  if (/consist[óo]rio|concistoro/.test(t)) return 'consistorio';
  if (/canoniza|beatifica/.test(t)) return 'canonizacao';
  if (/missa|celebra[çc][ãa]o eucar|liturgia/.test(t)) return 'missa';
  if (/v[ée]speras|te deum|(^|[\s:–-])ora[çc][ãa]o|ros[áa]rio|via-?sacra|vig[íi]lia/.test(t)) return 'oracao';
  if (/^mensage(m|ns)|^v[íi]deo/.test(tituloPt.toLowerCase())) return 'mensagem';
  if (/^(ao|à|aos|às|encontro|visita|participantes|almoço)(\s|$)/i.test(tituloPt.trim())) return 'encontro';
  if (/^(carta|exorta[çc][ãa]o|enc[íi]clica|constitui[çc][ãa]o|motu proprio|bula)/i.test(tituloPt.trim()) || /^«|^[A-Z][a-z]+ [a-z]+ .*\. /.test(tituloPt.trim())) return 'documento';
  return 'outro';
}

/** "[6-17 de novembro]" → fim da viagem (só para eventos de vários dias). */
function fimDaViagem(titulo, dataIni) {
  const m = /\[(\d{1,2})\s*[-–]\s*(\d{1,2})\s+de\s+([a-zç]+)/i.exec(titulo || '');
  if (!m) return null;
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const mes = meses.indexOf(m[3].toLowerCase());
  if (mes < 0) return null;
  let ano = Number(dataIni.slice(0, 4));
  if (mes + 1 < Number(dataIni.slice(5, 7))) ano += 1;
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const limpaTitulo = (s) => stripHtml(s).join(' ').replace(/\s+/g, ' ').trim();

async function main() {
  const nMeses = Math.max(1, Number(process.argv[2]) || 3);
  const hoje = new Date();
  const meses = [];
  for (let k = -1; k < nMeses; k++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() + k, 1));
    meses.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
  }
  const porChave = new Map(); // "2026/12/31/te-deum" → evento
  let requisicoes = 0;
  for (const [ano, mes] of meses) {
    for (const lang of LANGS) {
      if (requisicoes++) await sleep(GAP_MS);
      const url = `${BASE}/content/vaticanevents/${lang}/${ano}/${mes}.events.js`;
      const j = await getJson(url);
      for (const ev of j.events || []) {
        const m = /\/vaticanevents\/[a-z]{2}\/(\d{4}\/\d{1,2}\/\d{1,2}\/[^/]+)$/.exec(ev.path || '');
        if (!m) continue;
        const chave = m[1];
        const [y, mo, d] = chave.split('/');
        const data = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const e = porChave.get(chave) || { id: chave.replace(/\//g, '-'), data, titulo: {}, local: {}, link: {}, dono: ev.owner || null };
        e.titulo[lang] = limpaTitulo(ev.title);
        e.local[lang] = localDe(ev);
        e.link[lang] = ev.contentUrl ? BASE + ev.contentUrl : null;
        if (lang === 'pt' || !e.hora) e.hora = horaRoma(ev);
        const it = (ev.langs || []).find((x) => x.lang === 'it');
        if (it) e._tituloIt = limpaTitulo(it.title);
        porChave.set(chave, e);
      }
    }
  }
  // Documentos de apoio ("Livreto da celebração", "Indicações") não são eventos da agenda.
  const DOC = /^(livreto|indica[çc][õo]es|libretto|indicazioni|folleto|booklet|instructions)\b/i;
  const eventos = [...porChave.values()].filter((e) => !DOC.test(e.titulo.pt || '') && !DOC.test(e._tituloIt || '')).map((e) => {
    const tituloPt = e.titulo.pt || e.titulo.es || e.titulo.en || e._tituloIt || '';
    const tipo = tipoDe(tituloPt, e._tituloIt);
    const fim = tipo === 'viagem' ? fimDaViagem(e.titulo.pt, e.data) : null;
    // Em viagem a hora publicada é a do país visitado (não a de Roma): guardamos como hora local, sem converter.
    const emViagem = tipo === 'viagem';
    const out = {
      id: e.id,
      tipo,
      data: e.data,
      ...(fim ? { dataFim: fim } : {}),
      horaRoma: emViagem || !e.hora ? null : e.hora,
      ...(emViagem && e.hora && !fim ? { horaLocal: e.hora } : {}),
      inicioUtc: emViagem || !e.hora ? null : romaParaUtc(e.data, e.hora),
      titulo: e.titulo,
      local: e.local,
      link: e.link,
      papa: e.dono,
    };
    return out;
  }).sort((a, b) => (a.inicioUtc || a.data + 'T23:59').localeCompare(b.inicioUtc || b.data + 'T23:59'));

  // Conferências mínimas antes de gravar: um JSON vazio ou quebrado não pode substituir a agenda boa.
  const faltaIdioma = eventos.filter((e) => LANGS.some((l) => !e.titulo[l]));
  if (eventos.length === 0) throw new Error('nenhum evento lido — não gravei (fonte fora do ar ou formato mudou)');
  const destino = process.env.AGENDA_OUT ? path.resolve(process.env.AGENDA_OUT) : path.join(OUT, 'agenda.json');
  let anterior = null;
  try { anterior = JSON.parse(fs.readFileSync(destino, 'utf8')); } catch { /* primeira vez */ }
  if (anterior && anterior.eventos.length > 20 && eventos.length < anterior.eventos.length * 0.5) {
    throw new Error(`só ${eventos.length} eventos contra ${anterior.eventos.length} da agenda anterior — não gravei (conferir a fonte)`);
  }
  if (anterior && JSON.stringify(anterior.eventos) === JSON.stringify(eventos)) {
    console.log(`sem mudança (${eventos.length} eventos) — arquivo mantido`);
    return;
  }
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const agenda = {
    versao: 1,
    geradoEm: new Date().toISOString(),
    fonte: 'vatican.va (calendário público de eventos)',
    meses: meses.map(([a, m]) => `${a}-${String(m).padStart(2, '0')}`),
    eventos,
  };
  fs.writeFileSync(destino, JSON.stringify(agenda, null, 1));
  const porTipo = {};
  for (const e of eventos) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;
  console.log(`agenda.json: ${eventos.length} eventos, ${requisicoes} requisições`, JSON.stringify(porTipo));
  if (faltaIdioma.length) console.log(`aviso: ${faltaIdioma.length} evento(s) sem algum idioma:`, faltaIdioma.slice(0, 5).map((e) => e.id).join(', '));
}

main().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
