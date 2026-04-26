const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const DAILY_LIMIT = 50;
const MONTHLY_BUDGET_USD = 10;
const COST_PER_QUERY = 0.008;

// ==================== TELEGRAM ====================
async function send(chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    try {
      await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }) });
    } catch (e) {
      await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk }) });
    }
  }
}

async function sendHtml(chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }) }).catch(() => {});
  }
}

async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action: 'typing' }) }).catch(() => {});
}

// ==================== AUTH ====================
async function getOrCreateUser(tgUser) {
  try {
    const { data: existing } = await supabase.from('users').select('*').eq('telegram_id', tgUser.id).single();
    if (existing) return existing;
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim()));
    const isAdmin = adminIds.includes(tgUser.id);
    const { data: newUser } = await supabase.from('users').insert({
      telegram_id: tgUser.id, telegram_username: tgUser.username || null,
      full_name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(),
      role: isAdmin ? 'admin' : 'user',
      permissions: isAdmin ? ['stok','cari','fatura','cek','satis','rapor','admin'] : ['stok','cari']
    }).select().single();
    return newUser;
  } catch (e) { return null; }
}

async function checkLimits(telegramId) {
  const today = new Date().toISOString().split('T')[0];
  const { count: dailyCount } = await supabase.from('query_logs').select('*', { count: 'exact', head: true })
    .eq('user_id', telegramId).gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59');
  if ((dailyCount || 0) >= DAILY_LIMIT) return { ok: false, msg: `\u26A0\uFE0F G\u00FCnl\u00FCk soru limitinize ula\u015Ft\u0131n\u0131z (${DAILY_LIMIT}). Yar\u0131n tekrar deneyebilirsiniz.` };
  return { ok: true, daily: dailyCount || 0 };
}

async function logQuery(tid, qt, qx, rx) {
  try { await supabase.from('query_logs').insert({ user_id: tid, query_type: qt, query_text: qx, response_text: rx ? rx.substring(0, 2000) : null }); } catch(e) {}
}

// ==================== AGENT TOOLS ====================
const AGENT_TOOLS = [
  { name: "cari_sorgula", description: "DIA ERP cari hesap/firma sorgulama. Bakiye POZ\u0130T\u0130F = firma bize bor\u00E7lu (m\u00FC\u015Fteri), NEGAT\u0130F = biz bor\u00E7luyuz (tedarik\u00E7i). arama: firma ad\u0131, 'en_borclu', 'en_alacakli', 'ozet'", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "stok_sorgula", description: "DIA ERP stok sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "fatura_sorgula", description: "DIA ERP fatura sorgulama. arama: firma ad\u0131, 'son', 'bu_ay', 'bugun'", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "cek_sorgula", description: "DIA ERP \u00E7ek sorgulama. arama: 'bu_hafta', 'ozet', 'gecikmis', firma ad\u0131", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "bilgi_sorgula", description: "\u015Eirket bilgi taban\u0131 sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" } }, required: ["arama"] } },
  { name: "bilgi_ekle", description: "Bilgi taban\u0131na yeni bilgi ekle.", input_schema: { type: "object", properties: { kategori: { type: "string" }, baslik: { type: "string" }, icerik: { type: "string" } }, required: ["kategori", "icerik"] } },
  { name: "vergi_hesapla", description: "Vergi takvimi.", input_schema: { type: "object", properties: { islem: { type: "string" }, ay: { type: "number" }, yil: { type: "number" } }, required: ["islem"] } }
];

async function executeTool(name, input) {
  try {
    if (name === 'cari_sorgula') return await execCari(input);
    if (name === 'stok_sorgula') return await execStok(input);
    if (name === 'fatura_sorgula') return await execFatura(input);
    if (name === 'cek_sorgula') return await execCek(input);
    if (name === 'bilgi_sorgula') return await execBilgi(input);
    if (name === 'bilgi_ekle') return await execBilgiEkle(input);
    if (name === 'vergi_hesapla') return await execVergi(input);
    return JSON.stringify({ error: 'Bilinmeyen ara\u00E7' });
  } catch (e) { return JSON.stringify({ error: e.message }); }
}

// ==================== TOOL EXECUTORS (Supabase) ====================
async function execCari({ arama, limit = 10 }) {
  const a = arama.toLowerCase().trim();
  if (a === 'ozet' || a === 'genel') {
    const { data } = await supabase.from('dia_cariler').select('bakiye');
    const rows = data || [];
    const borclu = rows.filter(r => Number(r.bakiye) < 0);
    const alacakli = rows.filter(r => Number(r.bakiye) > 0);
    return JSON.stringify({
      toplam: rows.length,
      biz_borclu_sayi: borclu.length,
      biz_borclu_toplam: borclu.reduce((s, r) => s + Number(r.bakiye), 0),
      bize_borclu_sayi: alacakli.length,
      bize_borclu_toplam: alacakli.reduce((s, r) => s + Number(r.bakiye), 0)
    });
  }
  if (a === 'en_alacakli' || a.includes('bize bor') || a.includes('en alacak') || a.includes('alacakl')) {
    const { data } = await supabase.from('dia_cariler').select('*').gt('bakiye', 0).order('bakiye', { ascending: false }).limit(limit);
    return JSON.stringify((data || []).map(r => ({ ...r, _durum: 'F\u0130RMA B\u0130ZE BOR\u00C7LU' })));
  }
  if (a === 'en_borclu' || a.includes('en bor') || a.includes('biz bor')) {
    const { data } = await supabase.from('dia_cariler').select('*').lt('bakiye', 0).order('bakiye', { ascending: true }).limit(limit);
    return JSON.stringify((data || []).map(r => ({ ...r, _durum: 'B\u0130Z BOR\u00C7LUYUZ' })));
  }
  const { data: d1 } = await supabase.from('dia_cariler').select('*').ilike('unvan', `%${arama}%`).limit(limit);
  if (d1 && d1.length > 0) return JSON.stringify(d1.map(r => ({ ...r, _durum: Number(r.bakiye) > 0 ? 'F\u0130RMA B\u0130ZE BOR\u00C7LU' : Number(r.bakiye) < 0 ? 'B\u0130Z BOR\u00C7LUYUZ' : 'DENK' })));
  const words = arama.split(/\s+/).filter(w => w.length > 2);
  for (const w of words) {
    const { data: dw } = await supabase.from('dia_cariler').select('*').ilike('unvan', `%${w}%`).limit(limit);
    if (dw && dw.length > 0) return JSON.stringify(dw.map(r => ({ ...r, _durum: Number(r.bakiye) > 0 ? 'F\u0130RMA B\u0130ZE BOR\u00C7LU' : Number(r.bakiye) < 0 ? 'B\u0130Z BOR\u00C7LUYUZ' : 'DENK' })));
  }
  return JSON.stringify([]);
}

async function execStok({ arama, limit = 20 }) {
  const a = arama.toLowerCase();
  if (a === 'hepsi' || a === 'listele') {
    const { data } = await supabase.from('dia_stoklar').select('*').order('fiili_stok', { ascending: false }).limit(limit);
    return JSON.stringify(data || []);
  }
  const { data: d1 } = await supabase.from('dia_stoklar').select('*').ilike("raw_data->>'aciklama'", `%${arama}%`).limit(limit);
  if (d1 && d1.length > 0) return JSON.stringify(d1);
  const words = arama.split(/\s+/).filter(w => w.length > 1);
  for (const w of words) {
    const { data: dw } = await supabase.from('dia_stoklar').select('*').ilike("raw_data->>'aciklama'", `%${w}%`).limit(limit);
    if (dw && dw.length > 0) return JSON.stringify(dw);
  }
  return JSON.stringify([]);
}

async function execFatura({ arama, limit = 15 }) {
  const a = arama.toLowerCase().trim();
  const now = new Date();
  let query = supabase.from('dia_faturalar').select('*');
  if (a === 'bugun' || a === 'bug\u00FCn') {
    query = query.eq('tarih', now.toISOString().split('T')[0]);
  } else if (a === 'bu_ay' || a === 'bu ay') {
    query = query.gte('tarih', `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`);
  } else if (a !== 'son' && a !== 'son_faturalar') {
    query = query.ilike('cari_adi', `%${arama}%`);
  }
  const { data } = await query.order('tarih', { ascending: false }).limit(limit);
  return JSON.stringify(data || []);
}

async function execCek({ arama, limit = 20 }) {
  const a = arama.toLowerCase().trim();
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
  if (a === 'ozet' || a === 'portfoy_ozet') {
    const { data } = await supabase.from('dia_cekler').select('tutar, durum, vade');
    const all = data || [];
    const p = all.filter(r => r.durum && r.durum.includes('Portf'));
    return JSON.stringify({ toplam: all.length, portfoyde: { adet: p.length, toplam: p.reduce((s,r) => s+Number(r.tutar||0), 0) }, yaklasan: p.filter(r => r.vade >= today && r.vade <= nextMonth).slice(0,10) });
  }
  let query = supabase.from('dia_cekler').select('*');
  if (a === 'bu_hafta' || a === 'vadesi_yaklasan') query = query.gte('vade', today).lte('vade', nextWeek);
  else if (a === 'bu_ay') query = query.gte('vade', today).lte('vade', nextMonth);
  else if (a === 'gecikmis') query = query.lt('vade', today);
  else if (a !== 'hepsi') query = query.ilike('cari_adi', `%${arama}%`);
  const { data } = await query.order('vade', { ascending: true }).limit(limit);
  return JSON.stringify(data || []);
}

async function execBilgi({ arama }) {
  const { data } = await supabase.from('knowledge').select('*').or(`content.ilike.%${arama}%,title.ilike.%${arama}%`).limit(10);
  if (!data || data.length === 0) return JSON.stringify({ sonuc: 'Bilgi bulunamad\u0131.' });
  return JSON.stringify(data);
}

async function execBilgiEkle({ kategori, baslik, icerik }) {
  const { data, error } = await supabase.from('knowledge').insert({ category: kategori, title: baslik || null, content: icerik }).select().single();
  if (error) return JSON.stringify({ hata: error.message });
  return JSON.stringify({ basarili: true, id: data.id });
}

async function execVergi({ islem, ay, yil }) {
  const now = new Date(); const cy = yil || now.getFullYear();
  if (islem === 'yaklasan_vergiler') {
    const today = now.toISOString().split('T')[0]; const n30 = new Date(Date.now()+30*86400000).toISOString().split('T')[0];
    const cm = now.getMonth()+1; const cd = now.getDate(); const ya = [];
    for (const v of [{ad:'Muhtasar ve SGK',gun:26},{ad:'Damga Vergisi',gun:26},{ad:'KDV',gun:28}]) {
      if (v.gun >= cd) { const t = `${cy}-${String(cm).padStart(2,'0')}-${String(v.gun).padStart(2,'0')}`; ya.push({vergi:v.ad,tarih:t,kalan:Math.ceil((new Date(t)-now)/86400000)}); }
    }
    return JSON.stringify({ yaklasan: ya.sort((a,b)=>a.kalan-b.kalan) });
  }
  return JSON.stringify({ hata: 'Ge\u00E7ersiz i\u015Flem' });
}

// ==================== KARLILIK ====================
const DIA_URL_K = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const DIA_FIRMA_K = parseInt(process.env.DIA_FIRMA || '2');
const DIA_DONEM_K = parseInt(process.env.DIA_DONEM || '3');
const DIA_DEPO_K = parseInt(process.env.DIA_DEPO || '2987');
const SATIS_TURLERI = ['Toptan Sat\u0131\u015F', 'Perakende Sat\u0131\u015F', 'Verilen Hizmet'];
const IADE_TURLERI = ['Toptan Sat\u0131\u015F \u0130ade', 'Perakende Sat\u0131\u015F \u0130ade', 'Al\u0131nan Fiyat Fark\u0131', 'Verilen Fiyat Fark\u0131'];
const GIDER_TURLERI = ['Al\u0131nan Hizmet', 'Mal Al\u0131m'];

async function diaLoginK() {
  const res = await fetch(`${DIA_URL_K}/sis/json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: { username: process.env.DIA_USERNAME, password: process.env.DIA_PASSWORD, disconnect_same_user: true, lang: 'tr', params: { apikey: process.env.DIA_API_KEY } } })
  });
  const d = await res.json();
  if (String(d.code) !== '200') throw new Error(`DIA login: ${d.msg}`);
  return d.msg;
}

async function diaCallK(endpoint, body) {
  const res = await fetch(`${DIA_URL_K}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (String(d.code) !== '200') throw new Error(`DIA: ${d.msg || d.code}`);
  return d;
}

function fmtP(n) { return Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

async function karlilikRaporuCek(chatId, basTarih, bitTarih) {
  await sendHtml(chatId, '\u23F3 Karl\u0131l\u0131k raporu haz\u0131rlan\u0131yor...');
  const simdi = new Date();
  const basTar = basTarih || `${simdi.getFullYear()}-${String(simdi.getMonth()+1).padStart(2,'0')}-01`;
  const bitTar = bitTarih || new Date(simdi.getFullYear(), simdi.getMonth()+1, 0).toISOString().split('T')[0];
  const sessionId = await diaLoginK();
  const res = await diaCallK('rpr/json', { rpr_raporsonuc_getir: {
    session_id: sessionId, firma_kodu: DIA_FIRMA_K, donem_kodu: DIA_DONEM_K,
    filters: '', sorts: '',
    format_type: 'json',
    params: { tasarim_key: 808, fistarihi1: basTar, fistarihi2: bitTar,
      maliyethesaplamaYontemi: 'Sadece Maliyet', _key_sis_depo: DIA_DEPO_K,
      perakende_satis: true, toptan_satis: true, alinan_fiyat_farki: true, verilen_fiyat_farki: true,
      verilen_hizmet: true, perakende_iade: true, toptan_iade: true, mal_alim: true, alinan_hizmet: true },
    limit: 5000, offset: 0
  }});
  let rows = [];
  if (res.result) { const dec = Buffer.from(res.result, 'base64').toString('utf-8'); const data = JSON.parse(dec); rows = data.__rows || data.rows || []; }
  let ciro = 0, maliyet = 0, kar = 0;
  const uyari = [], cariMap = {};
  for (const r of rows) {
    const tur = r.turuaciklama || '';
    const tutar = parseFloat(r.toplamFaturaTutari||0);
    const mal = parseFloat(r.toplamFaturaMaliyeti||0);
    const cari = (r.carifirma||'').substring(0,30);
    const fisNo = r.belgeno2 || r.fisno || '';
    if (GIDER_TURLERI.includes(tur)) { maliyet += tutar; continue; }
    if (IADE_TURLERI.includes(tur)) { ciro -= tutar; maliyet -= mal; kar -= (tutar-mal); continue; }
    if (SATIS_TURLERI.includes(tur)) {
      if (mal === 0) uyari.push(`${fisNo} - ${cari}`);
      ciro += tutar; maliyet += mal; kar += (tutar-mal);
      if (cari) { if (!cariMap[cari]) cariMap[cari] = {c:0,k:0}; cariMap[cari].c+=tutar; cariMap[cari].k+=(tutar-mal); }
    }
  }
  const top5 = Object.entries(cariMap).sort((a,b)=>b[1].k-a[1].k).slice(0,5);
  const marj = ciro > 0 ? ((kar/ciro)*100).toFixed(1) : '0.0';
  let msg = `\uD83D\uDCCA <b>Karl\u0131l\u0131k Raporu</b>\n<i>${basTar} \u2192 ${bitTar}</i>\n\n`;
  msg += `\uD83D\uDCB0 <b>Ciro:</b> ${fmtP(ciro)} \u20BA\n\uD83D\uDCE6 <b>Maliyet:</b> ${fmtP(maliyet)} \u20BA\n\u2705 <b>Kar:</b> ${fmtP(kar)} \u20BA (%${marj})\n`;
  if (top5.length > 0) {
    msg += `\n\uD83C\uDFC6 <b>En Karl\u0131 5 Cari:</b>\n`;
    for (const [ad,v] of top5) { const cm = v.c>0?((v.k/v.c)*100).toFixed(0):0; msg += `  \u2022 ${ad}: ${fmtP(v.k)} \u20BA (%${cm})\n`; }
  }
  if (uyari.length > 0) {
    msg += `\n\u26A0\uFE0F <b>Maliyetsiz Sat\u0131\u015F (${uyari.length} fatura):</b>\n`;
    for (const u of uyari.slice(0,5)) msg += `  \u2022 ${u}\n`;
    if (uyari.length > 5) msg += `  ...ve ${uyari.length-5} fatura daha\n`;
  }
  await sendHtml(chatId, msg);
}

// ==================== MORNING REPORT ====================
async function generateMorningReport() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const next7 = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
  let cepler = [];
  try {
    const sessionId = await diaLoginK();
    const res = await diaCallK('bcs/json', {
      bcs_ceksenet_listele: {
        session_id: sessionId, firma_kodu: DIA_FIRMA_K, donem_kodu: DIA_DONEM_K,
        filters: [{ field: 'durum', operator: '=', value: 'Portf\u00F6yde' }],
        sorts: [{ field: 'vade', sorttype: 'ASC' }],
        params: { __selectHeader: ['ceksenetno','vade','tutar','cariadi','banka','durum'] },
        limit: 200, offset: 0
      }
    });
    cepler = res.result || [];
  } catch(e) { console.error('Rapor hata:', e.message); }
  const bug = cepler.filter(x => x.vade === today);
  const yar = cepler.filter(x => x.vade === tomorrow);
  const haf = cepler.filter(x => x.vade >= today && x.vade <= next7);
  const gec = cepler.filter(x => x.vade < today);
  const fm = n => Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  let r = `\uD83C\uDF05 <b>G\u00DCNL\u00DCK RAPOR \u2014 ${today}</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n`;
  if (bug.length > 0) {
    r += `\uD83D\uDD34 <b>Bug\u00FCn (${bug.length} adet \u2014 ${fm(bug.reduce((s,x)=>s+(x.tutar||0),0))} \u20BA)</b>\n`;
    bug.forEach((x,i) => { r += `${i+1}. ${x.cariadi||'-'} \u2014 ${fm(x.tutar)} \u20BA | ${x.banka||''}\n`; });
    r += '\n';
  } else { r += '\u2705 Bug\u00FCn vadesi dolan \u00E7ek yok.\n\n'; }
  if (yar.length > 0) {
    r += `\u26A0\uFE0F <b>Yar\u0131n (${yar.length} adet \u2014 ${fm(yar.reduce((s,x)=>s+(x.tutar||0),0))} \u20BA)</b>\n`;
    yar.forEach((x,i) => { r += `${i+1}. ${x.cariadi||'-'} \u2014 ${fm(x.tutar)} \u20BA\n`; });
    r += '\n';
  }
  if (haf.length > 0) r += `\uD83D\uDCC5 <b>7 G\u00FCN: ${fm(haf.reduce((s,x)=>s+(x.tutar||0),0))} \u20BA (${haf.length} \u00E7ek)</b>\n\n`;
  if (gec.length > 0) {
    r += `\uD83D\uDEA8 <b>Ge\u00E7ikmi\u015F (${gec.length} adet \u2014 ${fm(gec.reduce((s,x)=>s+(x.tutar||0),0))} \u20BA)</b>\n`;
    gec.slice(0,5).forEach((x,i) => { r += `${i+1}. ${x.vade} | ${x.cariadi||'-'} \u2014 ${fm(x.tutar)} \u20BA\n`; });
    if (gec.length > 5) r += ` ...ve ${gec.length-5} \u00E7ek daha\n`;
  }
  r += '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<i>OpenClaw Agent \u2014 Napol Global</i>';
  return r;
}

// ==================== AGENT ====================
const SYSTEM_PROMPT = `Sen OpenClaw, Napol Global \u015Firketinin AI asistan\u0131s\u0131n. Napol Global; silikonlu ka\u011F\u0131t ve ambalaj malzemeleri \u00FCretir/satar.
\u00D6NEML\u0130: POZ\u0130T\u0130F bakiye = firma BIZE BORCLU (m\u00FC\u015Fteri). NEGAT\u0130F bakiye = BIZ borcluyz (tedarik\u00E7i).
T\u00FCrk\u00E7e, k\u0131sa ve net cevap ver. Say\u0131lar\u0131 T\u00FCrk format\u0131nda yaz. Bug\u00FCn: ${new Date().toISOString().split('T')[0]}`;

async function runAgent(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];
  let response = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: SYSTEM_PROMPT, tools: AGENT_TOOLS, messages });
  let loops = 5;
  while (response.stop_reason === 'tool_use' && loops > 0) {
    loops--;
    const tr = [];
    for (const b of response.content) {
      if (b.type === 'tool_use') {
        console.log('Agent tool:', b.name, b.input);
        const result = await executeTool(b.name, b.input);
        tr.push({ type: 'tool_result', tool_use_id: b.id, content: result });
      }
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: tr });
    response = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: SYSTEM_PROMPT, tools: AGENT_TOOLS, messages });
  }
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Cevap olu\u015Fturulamad\u0131.';
}

// ==================== WEBHOOK ====================
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, msg: 'OpenClaw running' });
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const cleanText = text.replace(/@\w+/g, '').replace(/^\/\w+\s*/, '').trim();
    const command = text.split(' ')[0].split('@')[0].toLowerCase();
    const user = await getOrCreateUser(msg.from);
    if (!user || !user.is_active) { await send(chatId, '\uD83D\uDEAB Eri\u015Fim yetkiniz yok.'); return res.status(200).json({ ok: true }); }

    // /start
    if (command === '/start') {
      await send(chatId, `\uD83D\uDC4B Merhaba ${user.full_name}!\n\nBen OpenClaw Agent, Napol Global \u015Firket asistan\u0131y\u0131m.\n\n\uD83D\uDCCA /karlilik 2026-01-01 2026-03-31 \u2014 Karl\u0131l\u0131k\n\uD83D\uDCC4 /rapor \u2014 G\u00FCnl\u00FCk \u00E7ek raporu\n\uD83D\uDCCF /limit \u2014 Limit durumu\n\u2753 /yardim \u2014 Yard\u0131m`);
      await logQuery(msg.from.id, 'start', text, ''); return res.status(200).json({ ok: true });
    }

    // /yardim
    if (command === '/yardim' || command === '/help') {
      await send(chatId, `\uD83D\uDCDA <b>OpenClaw Rehber</b>\n\nDo\u011Fal dilde soru sor:\n\u2022 "OSEKA bakiyesi"\n\u2022 "Bize en bor\u00E7lu 5 firma"\n\u2022 "Bu hafta vadesi gelen \u00E7ekler"\n\u2022 "Son faturalar"\n\n\uD83D\uDCCA /karlilik 2026-01-01 2026-03-31\n\uD83D\uDCC4 /rapor\n\uD83D\uDCCF /limit`);
      return res.status(200).json({ ok: true });
    }

    // /limit
    if (command === '/limit') {
      const l = await checkLimits(msg.from.id);
      await send(chatId, `\uD83D\uDCCF G\u00FCnl\u00FCk: ${l.daily||0}/${DAILY_LIMIT}`);
      return res.status(200).json({ ok: true });
    }

    // /rapor
    if (command === '/rapor') {
      if (user.role !== 'admin') { await send(chatId, '\uD83D\uDEAB Sadece y\u00F6netici.'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const report = await generateMorningReport();
      await sendHtml(chatId, report);
      await logQuery(msg.from.id, 'rapor', text, 'rapor');
      return res.status(200).json({ ok: true });
    }

    // /karlilik
    if (command === '/karlilik') {
      if (user.role !== 'admin') { await send(chatId, '\uD83D\uDEAB Sadece y\u00F6netici.'); return res.status(200).json({ ok: true }); }
      const p1 = text.split(' ')[1] || null;
      const p2 = text.split(' ')[2] || null;
      if (!p1) {
        await sendHtml(chatId, '\uD83D\uDCCA <b>Karl\u0131l\u0131k Raporu</b>\n\nHangi tarih aral\u0131\u011F\u0131?\n\n\u00D6rnekler:\n\u2022 <code>/karlilik 2026-01-01 2026-03-31</code>\n\u2022 <code>/karlilik 2026-03-01 2026-03-31</code>');
        return res.status(200).json({ ok: true });
      }
      try { await karlilikRaporuCek(chatId, p1, p2); } catch(err) { await sendHtml(chatId, `\u274C ${err.message}`); }
      await logQuery(msg.from.id, 'karlilik', text, 'karl\u0131l\u0131k');
      return res.status(200).json({ ok: true });
    }

    // /ogren
    if (command === '/ogren') {
      if (!cleanText) { await send(chatId, 'Kullan\u0131m: /ogren [bilgi]'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const r = await runAgent(`Kullan\u0131c\u0131 \u015Fu bilgiyi eklemek istiyor: "${cleanText}". bilgi_ekle arac\u0131n\u0131 kullan.`);
      await send(chatId, r); await logQuery(msg.from.id, 'ogren', text, r);
      return res.status(200).json({ ok: true });
    }

    // Limit kontrol
    const lc = await checkLimits(msg.from.id);
    if (!lc.ok) { await send(chatId, lc.msg); return res.status(200).json({ ok: true }); }

    // Agent
    await typing(chatId);
    const ar = await runAgent(cleanText || text);
    await send(chatId, ar);
    await logQuery(msg.from.id, 'agent', text, ar);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: true });
  }
};
