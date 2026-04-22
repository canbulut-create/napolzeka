// /api/karlilik-raporu.js
// Telegram'dan /karlilik veya /karlilik 04 komutuyla tetiklenir
// SCF2240A raporunu çeker, maliyet kurallarını uygular, Telegram'a gönderir

const https = require('https');
const zlib  = require('zlib');

const DIA_URL = `https://${process.env.DIA_SUNUCU}.ws.dia.com.tr/api/v3`;
const FIRMA   = parseInt(process.env.DIA_FIRMA   || '2');
const DONEM   = parseInt(process.env.DIA_DONEM   || '3');
const TASARIM = parseInt(process.env.DIA_TASARIM || '807'); // SCF2240A tasarım key
const DEPO    = parseInt(process.env.DIA_DEPO    || '2987');
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;

const SATIS_TURLERI  = ['Toptan Satış', 'Perakende Satış', 'Verilen Hizmet'];
const GIDER_TURLERI  = ['Alınan Hizmet', 'Mal Alım'];

// ─── HTTP yardımcıları ────────────────────────────────────────────────────────

function diaPostRpr(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(`${DIA_URL}/rpr/json`);
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

function diaPost(body) {
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

function sendTelegram(chatId, text) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── DIA Login ───────────────────────────────────────────────────────────────

async function diaLogin() {
  const res = await diaPost({ login: {
    username: process.env.DIA_USER,
    password: process.env.DIA_PASS,
    disconnect_same_user: true,
    lang: 'tr',
    params: { apikey: process.env.DIA_APIKEY }
  }});
  if (res.code !== '200') throw new Error('DIA login failed');
  return res.msg;
}

// ─── SCF2240A raporu ──────────────────────────────────────────────────────────

async function karlilikaRaporuCek(sessionId, ay) {
  // ay = '01'..'12' veya null (bu ay)
  const simdi = new Date();
  const yil   = simdi.getFullYear();
  const ayNo  = ay ? ay.padStart(2, '0') : String(simdi.getMonth() + 1).padStart(2, '0');
  const basTar = `${yil}-${ayNo}-01`;
  const bitTar = new Date(yil, parseInt(ayNo), 0).toLocaleDateString('sv-SE'); // ayın son günü

  const res = await diaPostRpr({ rpr_raporsonuc_getir: {
    session_id: sessionId,
    firma_kodu: FIRMA,
    donem_kodu: DONEM,
    filters: '',
    sorts:   '',
    params: {
      tasarim_key: TASARIM,
      fistarihi1:  basTar,
      fistarihi2:  bitTar,
      maliyethesaplamayontemi: 'Sadece Maliyet',
      _key_sis_depo: DEPO,
      // Tüm satış fiş türleri
      perakende_satis: true,
      toptan_satis: true,
      alinan_fiyat_farki: true,
      verilen_fiyat_farki: true,
      verilen_hizmet: true,
      perakende_iade: true,
      toptan_iade: true,
      mal_alim: true,
      alinan_hizmet: true,
    },
    limit: 5000, offset: 0
  }});

  if (res.code !== '200') throw new Error('SCF2240A raporu alınamadı: ' + (res.msg || ''));

  // Rapor base64 decode
  let rows = [];
  if (res.result) {
    const decoded = Buffer.from(res.result, 'base64').toString('utf-8');
    const data = JSON.parse(decoded);
    rows = data.__rows || data.rows || [];
  }

  return { rows, basTar, bitTar, ayNo, yil };
}

// ─── Maliyet kuralları + özet hesaplama ──────────────────────────────────────

function hesaplaKarlilik(rows) {
  let toplamCiro = 0, toplamMaliyet = 0, toplamKar = 0;
  const sifirMaliyetUyari = [];
  const cariMap = {};

  for (const row of rows) {
    const turu    = row.turuaciklama || row.TURUACIKLAMA || '';
    const fisNo   = row.belgeno2 || row.BELGENO2 || row.fisno || '';
    const tutar   = parseFloat(row.toplamFaturaTutari || row.TOPLAMFATURATUTARI || 0);
    let   maliyet = parseFloat(row.toplamFaturaMaliyeti || row.TOPLAMFATURAMАЛIYETI || 0);
    const cariAdi = (row.carifirma || row.CARIFIRMA || '').substring(0, 30);

    if (GIDER_TURLERI.includes(turu)) {
      // KURAL 1: Gider kaleminde maliyet sıfır olmalı — maliyeti yok say, tutarı gider olarak ekle
      toplamMaliyet += tutar;
      continue;
    }

    if (SATIS_TURLERI.includes(turu)) {
      // KURAL 2: Satışta maliyetsiz olamaz
      if (maliyet === 0) {
        sifirMaliyetUyari.push(`${fisNo} - ${cariAdi}`);
      }
      toplamCiro    += tutar;
      toplamMaliyet += maliyet;
      toplamKar     += (tutar - maliyet);

      // Cari bazında
      if (cariAdi) {
        if (!cariMap[cariAdi]) cariMap[cariAdi] = { ciro: 0, kar: 0 };
        cariMap[cariAdi].ciro += tutar;
        cariMap[cariAdi].kar  += (tutar - maliyet);
      }
    } else {
      // İade vb. — cirodan düş
      toplamCiro    -= tutar;
      toplamMaliyet -= maliyet;
      toplamKar     -= (tutar - maliyet);
    }
  }

  // En iyi 5 cari
  const top5 = Object.entries(cariMap)
    .sort((a, b) => b[1].kar - a[1].kar)
    .slice(0, 5);

  return { toplamCiro, toplamMaliyet, toplamKar, sifirMaliyetUyari, top5 };
}

// ─── Mesaj formatla ──────────────────────────────────────────────────────────

function formatPara(n) {
  return n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

const AY_ADLARI = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran',
                   'Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function olusturMesaj(ozet, basTar, bitTar, ayNo, yil) {
  const marj = ozet.toplamCiro > 0
    ? ((ozet.toplamKar / ozet.toplamCiro) * 100).toFixed(1) : '0.0';

  let msg = `📈 <b>Karlılık Raporu — ${AY_ADLARI[parseInt(ayNo)]} ${yil}</b>\n`;
  msg += `<i>${basTar} → ${bitTar}</i>\n\n`;
  msg += `💰 <b>Ciro:</b> ${formatPara(ozet.toplamCiro)} ₺\n`;
  msg += `📦 <b>Maliyet:</b> ${formatPara(ozet.toplamMaliyet)} ₺\n`;
  msg += `✅ <b>Kar:</b> ${formatPara(ozet.toplamKar)} ₺ (%${marj})\n`;

  if (ozet.top5.length > 0) {
    msg += `\n🏆 <b>En Karlı 5 Cari:</b>\n`;
    for (const [ad, v] of ozet.top5) {
      const cMarj = v.ciro > 0 ? ((v.kar / v.ciro) * 100).toFixed(0) : 0;
      msg += `  • ${ad}: ${formatPara(v.kar)} ₺ (%${cMarj})\n`;
    }
  }

  if (ozet.sifirMaliyetUyari.length > 0) {
    msg += `\n⚠️ <b>Maliyetsiz Satış (${ozet.sifirMaliyetUyari.length} fatura):</b>\n`;
    for (const u of ozet.sifirMaliyetUyari.slice(0, 5)) msg += `  • ${u}\n`;
    if (ozet.sifirMaliyetUyari.length > 5)
      msg += `  ... ve ${ozet.sifirMaliyetUyari.length - 5} fatura daha\n`;
  }

  return msg;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // Hem Telegram webhook hem doğrudan çağrı desteklenir
  let chatId = TELEGRAM_CHAT;
  let ayParam = null;

  if (req.method === 'POST' && req.body) {
    // Telegram webhook'tan geldi
    const msg = req.body.message;
    if (!msg) return res.status(200).json({ ok: true });

    chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    // /karlilik 04  →  ay = '04'
    const parts = text.split(' ');
    if (parts[1]) ayParam = parts[1].padStart(2, '0');
  } else if (req.method === 'GET') {
    ayParam = req.query.ay || null;
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await sendTelegram(chatId, '⏳ Karlılık raporu hazırlanıyor...');

    const sessionId = await diaLogin();
    const { rows, basTar, bitTar, ayNo, yil } = await karlilikaRaporuCek(sessionId, ayParam);
    const ozet = hesaplaKarlilik(rows);
    const mesaj = olusturMesaj(ozet, basTar, bitTar, ayNo, yil);

    await sendTelegram(chatId, mesaj);
    return res.status(200).json({ ok: true, satirSayisi: rows.length });
  } catch (err) {
    console.error('karlilik-raporu hata:', err);
    await sendTelegram(chatId, `❌ Karlılık raporu hatası: ${err.message}`).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
};
