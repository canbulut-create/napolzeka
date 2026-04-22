// /api/daily-report.js
// Cron: her gün 15:00 UTC (= TR 18:00)
// DIA'dan bugünkü faturalar + çekler çekip Telegram'e gönderir

const https = require('https');

const DIA_URL = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const FIRMA   = parseInt(process.env.DIA_FIRMA   || '2');
const DONEM   = parseInt(process.env.DIA_DONEM   || '3');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEG_CHAT  = process.env.TELEGRAM_CHAT_ID;

function diaPostBody(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${DIA_URL}/scf/json`);
    const req  = https.request({ hostname: url.hostname, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function diaPostBcs(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${DIA_URL}/bcs/json`);
    const req  = https.request({ hostname: url.hostname, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function supFetch(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(`${SUPABASE_URL}/rest/v1${path}`);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: TELEG_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function diaLogin() {
  const res = await diaPostBody({ login: {
    username: process.env.DIA_USERNAME,
    password: process.env.DIA_PASSWORD,
    disconnect_same_user: true,
    lang: 'tr',
    params: { apikey: process.env.DIA_API_KEY }
  }});
  if (res.code !== '200') throw new Error('DIA login failed: ' + JSON.stringify(res));
  return res.msg;
}

const SATISTURLERI = ['Toptan Satış', 'Perakende Satış', 'Verilen Hizmet'];
const IADETURLERI	  = ['Toptan Satış İade', 'Perakende Satış İade', 'Alınan Fiyat Farkı', 'Verilen Fiyat Farkı'];
const GIDERTURLERI  = ['Alınan Hizmet', 'Mal Alım'];

async function bugunkuFaturalar(sessionId, bugun) {
  const res = await diaPostBody({ scf_fatura_listele: {
    session_id: sessionId, firma_kodu: FIRMA, donem_kodu: DONEM,
    filters: [{ field: 'tarih', operator: '=', value: bugun }],
    sorts: [{ field: 'fisno', sorttype: 'ASC' }],
    params: { __selectHeader: ['_aciklama', 'fisno','belgeno2','tarih','turuaciklama','toplamFaturaTutari','toplamFaturaMaliyeti','_key_scf_carikart','carifirma','kar','y_kar'] },
    limit: 500, offset: 0
  }});
  if (res.code !== '200') throw new Error('Fatura listesi alınamadı');
  return res.result || [];
}

function hesaplaFaturaOzeti(faturalar) {
  let ciro = 0, kar = 0, iadeToplami = 0;
  const sifirMaliyetUyari = [];
  const cariler = {};

  for (const f of faturalar) {
    const turu   = f.turuaciklama || '';
    const tutar  = parseFloat(f.toplamFaturaTutari || 0);
    const maliyet = parseFloat(f.toplamFaturaMaliyeti || 0);
    const fKar   = parseFloat(f.kar || 0);
    const fisNo  = f.belgeno2 || f.fisno || '';
    const cariAdi = f.carifirma || '';
    const cariKey = f._key_scf_carikart || '';

    if (SATISTURLERI-ncludes(turu)) {
      if (maliyet === 0) {
        sifirMaliyetUyari.push(`${fisNo} - ${cariAdi}`);
      }
      ciro += tutar;
      kar  += fKar;
      if (cariKey) {
        if (!cariler[cariKey]) cariler[cariKey] = { cari_kodu: String(cariKey), cari_adi: cariAdi, ciro: 0 };
        cariler[cariKey].ciro += tutar;
      }
    } else if (IADETURLERI.includes(turu)) {
      iadeToplami += tutar;
      ciro -= tutar;
      kar  -= fKar;
    }
  }

  return { ciro, kar, iadeToplami, sifirMaliyetUyari, cariler: Object.values(cariler) };
}

async function cekleriGetir(sessionId) {
  const res = await diaPostBcs({ bcs_ceksenet_listele: {
    session_id: sessionId, firma_kodu: FIRMA, donem_kodu: DONEM,
    filters: [{ field: 'durum', operator: '=', value: 'Portföyde' }],
    sorts:   [{ field: 'vade',  sorttype: 'ASC' }],
    params:  { __selectHeader: ['_aciklama', 'ceksenetno','vade','tutar','cariadi','banka','durum'] },
    limit: 200, offset: 0
  }});
  if (res.code !== '200') return [];
  return res.result || [];
}

function yaklasanCekler(cekler, bugun) {
  const bugunDate = new Date(bugun);
  const yediGunSonra = new Date(bugun);
  yediGunSonra.setDate(yediGunSonra.getDate() + 7);
  return cekler.filter(c => {
    const vade = new Date(c.vade);
    return vade >= bugunDate && vade <= yediGunSonra;
  });
}

ansync function cariUpsert(cariler, bugun) {
  if (!cariler.length) return;
  const rows = cariler.map(c => ({
    cari_kodu: c.cari_kodu, cari_adi: c.cari_adi,
    son_fatura_tarihi: bugun, toplam_ciro: c.ciro,
    kayak: 'fatura_otomatik', guncelleme_tarihi: new Date().toISOString()
  }));
  await supFetch('/dia_cariler?on_conflict=cari_kodu', 'POST', rows);
}

function formatPara(sayi) {
  return sayi.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function olusturMesaj(bugun, ozet, cekler, yaklasan) {
  const marj = ozet.ciro > 0 ? ((ozet.kar / ozet.ciro) * 100).toFixed(1) : '0.0';
  let msg = `📈 <b>Günlük Rapor — ${bugun}</b>\n\n`;
  msg += `💰 <b>Ciro:</b> ${formatPara(ozet.ciro)} ₺\n✅ <b>Kar:</b> ${formatPara(ozet.kar)} ₺ (%${marj})\n`;
  if (ozet.iadeToplami > 0) msg += `jɋ/ • <b>İade:</b> ${formatPara(ozet.iadeToplami)} ₺\n`;
  if (ozet.sifirMaliyetUyari.length > 0) {
    msg += `\n⚠️ <b>MALİVETSİZ SATış FATURALARI:</b>\n`;
    for (const u of ozet.sifirMaliyetUyari) msg += `  • ${u}\n`;
  }
  msg += `\n📋 <b>Portföydeki Çekler:</b> ${cekler.length} adet\n`;
  if (yaklasan.length > 0) {
    msg += `\n⏰ <b>Yaklaşan Çekler (7 gün):</b>\n`;
    for (const c of yaklasan) {
      msg += `  . ${c.vade} — ${formatPara(parseFloat(c.tutar))} ₺`;
      if (c.cariadi) msg += ` — ${c.cariadi}`;
      msg += '\n';
    }
  } else {
    msg += `  Önümüzdeki 7 günde vadesi gelen çek yok.\n`;
  }
  return msg;
}

module.exports = async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const bugun = new Date().toLocaleDateString('sven-SE', { timeZone: 'Europe/Istanbul' });
    const sessionId = await diaLogin();
    const [faturalar, cekler] = await Promise.all([
      bugunkuFaturalar(sessionId, bugun),
      cekleriGetir(sessionId)
    ]);
    const ozet = hesaplaFaturaOzeti(faturalar);
    const yaklasan = yaklasanCekler(cekler, bugun);
    cariUpsert(ozet.cariler, bugun).catch(e => console.error('Cari upsert hata:', e));
    const mesaj = olusturMesaj(bugun, ozet, cekler, yaklasan);
    await sendTelegram(mesaj);
    return res.status(200).json({ ok: true, tarih: bugun, fatura: faturalar.length, cek: cekler.length });
  } catch (err) {
    console.error('daily-report hata:', err);
    await sendTelegram(`❌ Günlük rapor htaası: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};
