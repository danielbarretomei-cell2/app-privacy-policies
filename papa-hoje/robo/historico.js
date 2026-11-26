// Robô do histórico do pontificado — "Papa Hoje" (SoulfulApps).
// Lê o arquivo anual público do vatican.va (o mesmo que a página do Papa usa) em pt, es e en
// e grava: viagens.json (viagens apostólicas e visitas pastorais com cada compromisso) e
// documentos.json (encíclicas, exortações, cartas apostólicas, motu proprio).
// Fonte: https://www.vatican.va/content/vaticanevents/<lang>/<ano>.events.<papa>.js
// Só fatos (título, data, local) + link oficial. Uso: node historico.js [pastaSaida]
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.vatican.va';
const LANGS = ['pt', 'es', 'en'];
const PAPA = 'leo-xiv';
const ANO_INICIO = 2025; // eleição: 8/5/2025
const UA = 'Mozilla/5.0 (compatible; PapaHojeBot/1.0)';
const GAP_MS = 3000;
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const MESES = { janeiro: 1, fevereiro: 2, 'março': 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const iso = (a, m, d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

async function getJson(url) {
  for (let t = 1; t <= 2; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 404) return { events: [] };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return JSON.parse(await r.text());
    } catch (e) {
      if (t === 2) throw new Error(`${url}: ${e.message}`);
      await sleep(GAP_MS * 2);
    }
  }
}

/** "[6-17 de novembro de 2026]", "[25 a 28 de setembro de 2026]", "[27 de novembro a 2 de dezembro de 2025]", "[8 de maio de 2026]" */
function periodo(titulo) {
  const b = /\[([^\]]+)\]/.exec(titulo || '');
  if (!b) return null;
  const s = b[1].toLowerCase().replace(/\s+/g, ' ');
  let m = /^(\d{1,2})\s*(?:-|–|a)\s*(\d{1,2}) de ([a-zç]+) de (\d{4})$/.exec(s);
  if (m && MESES[m[3]]) return { ini: iso(m[4], MESES[m[3]], m[1]), fim: iso(m[4], MESES[m[3]], m[2]) };
  m = /^(\d{1,2}) de ([a-zç]+)\s*(?:-|–|a)\s*(\d{1,2}) de ([a-zç]+) de (\d{4})$/.exec(s);
  if (m && MESES[m[2]] && MESES[m[4]]) {
    const anoFim = Number(m[5]);
    const anoIni = MESES[m[2]] > MESES[m[4]] ? anoFim - 1 : anoFim;
    return { ini: iso(anoIni, MESES[m[2]], m[1]), fim: iso(anoFim, MESES[m[4]], m[3]) };
  }
  m = /^(\d{1,2}) de ([a-zç]+) de (\d{4})$/.exec(s);
  if (m && MESES[m[2]]) return { ini: iso(m[3], MESES[m[2]], m[1]), fim: iso(m[3], MESES[m[2]], m[1]) };
  return null;
}

function limpaTituloViagem(t) {
  return strip(t).replace(/\s*[[(][^\])]*\d{4}[\])]\s*$/, '')
    .replace(/^(Viagem Apost[óo]lica|Viaje Apost[óo]lico|Apostolic Journey|Apostolic Visit)( do Santo Padre| del Santo Padre| de Su Santidad Le[óo]n XIV| of the Holy Father| of His Holiness Pope Leo XIV)?\s*/i, '')
    .trim();
}
const chaveDe = (ev) => (/\/vaticanevents\/[a-z]{2}\/(.+)$/.exec(ev.path || '') || [])[1] || null;
const dataDaChave = (k) => { const [y, mo, d] = k.split('/'); return iso(y, mo, d); };
const HORA_LOCAL = /\(\s*(hora local|local time|ora locale|heure locale)[^)]*\)/gi;
const localDe = (ev) => strip((ev.description || '').replace(/\b\d{1,2}[h.:]\d{2}\b/g, '').replace(HORA_LOCAL, '')).replace(/^(CAPELA PAPAL|CAPILLA PAPAL|PAPAL CHAPEL)\s*/i, '').replace(/\s+([,.;])/g, '$1').trim() || null;

async function main() {
  const anoAtual = new Date().getUTCFullYear();
  const porLang = {}; // lang → Map(chave → evento)
  let req = 0;
  for (const lang of LANGS) {
    porLang[lang] = new Map();
    for (let ano = ANO_INICIO; ano <= anoAtual + 1; ano++) {
      if (req++) await sleep(GAP_MS);
      const j = await getJson(`${BASE}/content/vaticanevents/${lang}/${ano}.events.${PAPA}.js`);
      for (const ev of j.events || []) { const k = chaveDe(ev); if (k) porLang[lang].set(k, ev); }
    }
  }
  const pt = porLang.pt;
  if (pt.size < 100) throw new Error(`só ${pt.size} eventos em pt — não gravei`);
  const em = (k, lang) => porLang[lang].get(k);
  const tri = (k, f) => Object.fromEntries(LANGS.map((l) => [l, em(k, l) ? f(em(k, l)) : null]));

  // ---- Viagens apostólicas (cabeçalho com período entre colchetes) ----
  const viagens = new Map();
  for (const [k, ev] of pt) {
    const t = strip(ev.title);
    if (!/^Viagem Apost[óo]lica do Santo Padre/i.test(t)) continue;
    const p = periodo(t);
    if (!p) continue;
    if (viagens.has(p.ini)) continue; // o mesmo período publicado duas vezes (anúncio e cabeçalho)
    viagens.set(p.ini, {
      id: 'v-' + p.ini, tipo: 'apostolica', inicio: p.ini, fim: p.fim,
      titulo: tri(k, (e) => limpaTituloViagem(e.title)),
      link: tri(k, (e) => (e.contentUrl ? BASE + e.contentUrl : null)),
      compromissos: [],
    });
  }
  // Compromissos de cada viagem: "Viagem Apostólica à Espanha: Santa Missa" dentro do período.
  for (const [k, ev] of pt) {
    const t = strip(ev.title);
    const m = /^Viagem Apost[óo]lica (?:ao|à|aos|às|a|em) ([^:]+):\s*(.+)$/i.exec(t);
    if (!m) continue;
    const d = dataDaChave(k);
    const v = [...viagens.values()].find((x) => d >= x.inicio && d <= x.fim);
    if (!v) continue;
    const paisDe = (e) => {
      const antes = strip(e.title).split(':')[0];
      if (antes === strip(e.title)) return null;
      const p = antes.replace(/^(Viagem Apost[óo]lica|Viaje Apost[óo]lico|Apostolic Journey|Apostolic Visit)\s+/i, '')
        .replace(/^(ao|à|aos|às|a|em|al|a la|a los|a las|en|to|in)\s+/i, '').trim();
      return !p || /,| e | y | and /.test(p) ? null : p;
    };
    v.compromissos.push({ data: d, pais: tri(k, paisDe), titulo: tri(k, (e) => strip(e.title).replace(/^[^:]+:\s*/, '')), local: tri(k, localDe) });
  }
  // ---- Visitas pastorais (Itália): "Visita Pastoral a Pompeia e Nápoles: Santa Missa" agrupadas por lugar ----
  const pastorais = new Map();
  for (const [k, ev] of pt) {
    const t = strip(ev.title);
    const m = /^Visita Pastoral (?:do Santo Padre )?(?:a|à|ao|em) ([^:[]+?)(?::\s*(.+))?$/i.exec(t);
    if (!m || /^Programa/i.test(t) || /Par[óo]quia|Sapienza/i.test(t)) continue;
    const d = dataDaChave(k);
    const lugar = m[1].trim();
    const id = 'p-' + d + '-' + lugar.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const chaveGrupo = d;
    const v = pastorais.get(chaveGrupo) || { id, tipo: 'pastoral', inicio: d, fim: d, titulo: tri(k, (e) => strip(e.title).replace(/:.*$/, '')), link: tri(k, (e) => (e.contentUrl ? BASE + e.contentUrl : null)), compromissos: [] };
    if (d < v.inicio) v.inicio = d;
    if (d > v.fim) v.fim = d;
    if (/do Santo Padre/i.test(t) && !m[2]) v.titulo = tri(k, (e) => strip(e.title).replace(/:.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/ (do Santo Padre|del Santo Padre|of the Holy Father)/i, ''));
    if (m[2]) v.compromissos.push({ data: d, pais: null, titulo: tri(k, (e) => strip(e.title).replace(/^[^:]+:\s*/, '')), local: tri(k, localDe) });
    pastorais.set(chaveGrupo, v);
  }
  const todas = [...viagens.values(), ...pastorais.values()]
    .map((v) => ({ ...v, compromissos: v.compromissos.sort((a, b) => a.data.localeCompare(b.data)) }))
    .sort((a, b) => b.inicio.localeCompare(a.inicio));

  // ---- Documentos (pelo endereço oficial do documento) ----
  const TIPOS = [['/encyclicals/', 'enciclica'], ['/apost_exhortations/', 'exortacao'], ['/apost_constitutions/', 'constituicao'], ['/apost_letters/', 'carta']];
  const docs = new Map();
  for (const [k, ev] of pt) {
    for (const pg of ev.pages || []) {
      const tipo = (TIPOS.find(([s]) => pg.includes(s)) || [])[1];
      if (!tipo) continue;
      const dm = /documents\/(\d{4})(\d{2})(\d{2})-/.exec(pg);
      const id = pg.split('/').pop();
      if (docs.has(id)) continue;
      const motu = /motu proprio/i.test(strip(ev.title));
      docs.set(id, {
        id, tipo: tipo === 'carta' && motu ? 'motuproprio' : tipo,
        data: dm ? iso(dm[1], dm[2], dm[3]) : dataDaChave(k),
        titulo: tri(k, (e) => strip(e.title)),
        link: Object.fromEntries(LANGS.map((l) => [l, BASE + pg.replace('/pt/', `/${l}/`) + '.html'])),
      });
    }
  }
  const documentos = [...docs.values()].sort((a, b) => b.data.localeCompare(a.data));

  fs.mkdirSync(OUT, { recursive: true });
  const grava = (nome, chave, lista) => {
    const f = path.join(OUT, nome);
    let ant = null;
    try { ant = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* primeira vez */ }
    if (ant && ant[chave].length > 3 && lista.length < ant[chave].length * 0.5) throw new Error(`${nome}: ${lista.length} contra ${ant[chave].length} — não gravei`);
    if (ant && JSON.stringify(ant[chave]) === JSON.stringify(lista)) { console.log(`${nome}: sem mudança (${lista.length})`); return; }
    fs.writeFileSync(f, JSON.stringify({ versao: 1, geradoEm: new Date().toISOString(), fonte: 'vatican.va', [chave]: lista }, null, 1));
    console.log(`${nome}: ${lista.length} gravados`);
  };
  grava('viagens.json', 'viagens', todas);
  grava('documentos.json', 'documentos', documentos);
  console.log(`requisições: ${req}; viagens apostólicas ${viagens.size}, visitas pastorais ${pastorais.size}, documentos ${documentos.length}`);
}

main().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
