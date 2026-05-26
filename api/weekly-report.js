// /api/weekly-report.js
// NapolZeka Rapor v2 — Haftalık rapor (Cumartesi 10:00 TR)
// Cron: Cmt 07:00 UTC = 10:00 TR
// İçerik: geçen Pzt-Cum aralığının özeti + gün gün dağılım.
//
// Faz 1 sınırı:
//   * Kâr 2 (defter): hesaplanır.
//   * Kâr 1 (güncel kur) ve Kur farkı: Faz 2'de gelecek; şu an "—".

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;
const ADMIN_IDS    = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CRON_SECRET  = process.env.CRON_SECRET;

const AYLAR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];
const GUN_ADLARI = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

// ----------------------------------------------------------------------------
// Tarih yardımcıları (TR saati / Europe/Istanbul)
// ----------------------------------------------------------------------------
function trTarihIstanbul(d) {
  // d: Date → 'YYYY-MM-DD' (TR günü)
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
}

function bugunIstanbul() {
  return trTarihIstanbul(new Date());
}

function isoToDate(iso) {
  // 'YYYY-MM-DD' → Date (UTC anchored — gün hesabı için yeterli)
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function tarihGeri(iso, gun) {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() - gun);
  return d.toISOString().slice(0, 10);
}

function gunAdi(iso) {
  // ISO tarihinden Türkçe gün adı
  const d = isoToDate(iso);
  // getUTCDay: 0=Pazar..6=Cumartesi (UTC anchored Date'imiz için tutarlı)
  return GUN_ADLARI[d.getUTCDay()];
}

function trBaslikAraligi(pzt, cum) {
  // "20-24 Mayıs 2026"  (aynı ay/yıl)
  // "29 Mayıs - 2 Haziran 2026" (farklı ay)
  const [py, pm, pd] = pzt.split('-').map(Number);
  const [cy, cm, cd] = cum.split('-').map(Number);
  if (py === cy && pm === cm) {
    return `${pd}-${cd} ${AYLAR[pm - 1]} ${py}`;
  }
  if (py === cy) {
    return `${pd} ${AYLAR[pm - 1]} - ${cd} ${AYLAR[cm - 1]} ${py}`;
  }
  return `${pd} ${AYLAR[pm - 1]} ${py} - ${cd} ${AYLAR[cm - 1]} ${cy}`;
}

function trGunBasligi(iso) {
  // 'Pazartesi 20.05'
  const [y, m, d] = iso.split('-').map(Number);
  return `${gunAdi(iso)} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

// ----------------------------------------------------------------------------
// Para format (günlük rapor ile aynı kural)
// ----------------------------------------------------------------------------
function fmtTL(n, opts = {}) {
  const { isaret = false } = opts;
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const sign = n < 0 ? '-' : (isaret && n > 0 ? '+' : '');
  return `${sign}${s} TL`;
}

function fmtYuzde(n, ondalik = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  const s = n.toLocaleString('tr-TR', { minimumFractionDigits: ondalik, maximumFractionDigits: ondalik });
  return `%${s}`;
}

// ----------------------------------------------------------------------------
// Supabase REST
// ----------------------------------------------------------------------------
function supGet(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${SUPABASE_URL}/rest/v1${path}`);
    https
      .get(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept: 'application/json',
          },
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${raw}`));
            try { resolve(raw ? JSON.parse(raw) : []); } catch { resolve([]); }
          });
        }
      )
      .on('error', reject);
  });
}

// ----------------------------------------------------------------------------
// Telegram
// ----------------------------------------------------------------------------
function tgSend(chatId, text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

async function tgSendAll(text) {
  const targets = new Set();
  if (TG_CHAT) targets.add(String(TG_CHAT));
  for (const id of ADMIN_IDS) targets.add(String(id));
  for (const id of targets) await tgSend(id, text);
}

// ----------------------------------------------------------------------------
// Hafta aralığı hesabı
// ----------------------------------------------------------------------------
function haftaAraligi() {
  // Bu fonksiyon Cumartesi sabahı çağrılacağı varsayımıyla yazılmış:
  //   Pzt = bugün - 5, Cum = bugün - 1
  // Manuel test için herhangi bir gün — en yakın geçmiş Pzt-Cum çerçevelenir.
  const bugun = bugunIstanbul();
  const d = isoToDate(bugun);
  const dow = d.getUTCDay(); // 0=Pazar..6=Cumartesi
  // Hafta sonu (Cmt/Pazar): bu haftanın Pzt-Cum'unu raporla
  // Hafta içi: bu haftanın Pzt'sinden bugüne kadar (kullanıcı manuel tetikledi)
  let pztOffset;
  if (dow === 0)        pztOffset = 6;   // Pazar: 6 gün geriden Pzt
  else if (dow === 6)   pztOffset = 5;   // Cmt:   5 gün geriden Pzt
  else                  pztOffset = dow - 1; // Pzt=0, Salı=1 ... Cuma=4
  const pzt = tarihGeri(bugun, pztOffset);
  // Cum = pzt + 4 (Pzt-Cum kapsayan)
  const cum = tarihGeri(pzt, -4);
  return { pzt, cum };
}

// ----------------------------------------------------------------------------
// Veri sorguları
// ----------------------------------------------------------------------------
async function getSatisHaftalik(pzt, cum) {
  // vw_haftalik_satis_karlilik
  return supGet(
    `/vw_haftalik_satis_karlilik?tarih=gte.${pzt}&tarih=lte.${cum}` +
      `&select=tarih,fatura_sayisi,toplam_kdv_haric_satis,toplam_defter_kar,defter_marj,maliyetsiz_satir` +
      `&order=tarih.asc`
  );
}

async function getAlisHaftalik(pzt, cum) {
  return supGet(
    `/vw_haftalik_alis_ozet?tarih=gte.${pzt}&tarih=lte.${cum}` +
      `&select=tarih,fatura_sayisi,toplam_kdv_haric` +
      `&order=tarih.asc`
  );
}

// ----------------------------------------------------------------------------
// Rapor metni
// ----------------------------------------------------------------------------
function olusturRapor(pzt, cum, satisSatirlar, alisSatirlar) {
  let msg = '';
  msg += `📊 NAPOL HAFTALIK RAPOR\n`;
  msg += `${trBaslikAraligi(pzt, cum)}\n\n`;

  const toplamCiro       = satisSatirlar.reduce((a, r) => a + Number(r.toplam_kdv_haric_satis || 0), 0);
  const toplamAlis       = alisSatirlar .reduce((a, r) => a + Number(r.toplam_kdv_haric || 0), 0);
  const toplamDefterKar  = satisSatirlar.reduce((a, r) => a + Number(r.toplam_defter_kar || 0), 0);
  const defterMarj       = toplamCiro > 0 ? (toplamDefterKar / toplamCiro) * 100 : 0;

  msg += `💰 TOPLAM CİRO (Satış)\n`;
  msg += `${fmtTL(toplamCiro)} (KDV'siz)\n\n`;
  msg += `🛒 TOPLAM ALIŞ\n`;
  msg += `${fmtTL(toplamAlis)} (KDV'siz)\n\n`;

  msg += `📈 TOPLAM KÂR\n`;
  msg += `Kâr (güncel kur): — (kalem sync bekleniyor — Faz 2)\n`;
  msg += `Kâr (defter):    ${fmtTL(toplamDefterKar)} — Marj: ${fmtYuzde(defterMarj)}\n`;
  msg += `Kur farkı etkisi: — (Faz 2)\n\n`;

  msg += `────────────────\n`;
  msg += `GÜN GÜN DAĞILIM\n\n`;

  // Pzt-Cum boyunca veri olmayan günleri de göster ("Veri yok")
  const dataByDate = {};
  for (const r of satisSatirlar) dataByDate[r.tarih] = r;
  let kursoIso = pzt;
  for (let i = 0; i < 5; i++) {
    const r = dataByDate[kursoIso];
    msg += `${trGunBasligi(kursoIso)}\n`;
    if (r) {
      const satis = Number(r.toplam_kdv_haric_satis || 0);
      const kar   = Number(r.toplam_defter_kar || 0);
      msg += `  Satış: ${fmtTL(satis)}\n`;
      msg += `  Kâr (güncel kur): — | Kâr (defter): ${fmtTL(kar)}\n`;
    } else {
      msg += `  Satış: 0 TL — kayıt yok\n`;
    }
    msg += `\n`;
    kursoIso = tarihGeri(kursoIso, -1);
  }

  // Hiç veri yoksa not
  if (satisSatirlar.length === 0 && alisSatirlar.length === 0) {
    msg += `ℹ️ Bu hafta karlılık tablosunda kayıt yok.\n`;
    msg += `   (dia_karlilik_raporu tablosu SCF2240A çağrısı ile güncellenmeli — Faz 2'de otomatize edilecek.)\n`;
  }

  return msg;
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
module.exports = async (req, res) => {
  const auth   = req.headers?.authorization || '';
  const tokenQ = req.query?.token;
  const tokenH = req.headers?.['x-cron-secret'];
  const ok =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && (tokenQ === CRON_SECRET || tokenH === CRON_SECRET));

  if (!ok) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Manuel test: ?pzt=YYYY-MM-DD&cum=YYYY-MM-DD
    let pzt, cum;
    if (req.query?.pzt && req.query?.cum &&
        /^\d{4}-\d{2}-\d{2}$/.test(req.query.pzt) &&
        /^\d{4}-\d{2}-\d{2}$/.test(req.query.cum)) {
      pzt = req.query.pzt; cum = req.query.cum;
    } else {
      ({ pzt, cum } = haftaAraligi());
    }

    const [satislar, alislar] = await Promise.all([
      getSatisHaftalik(pzt, cum),
      getAlisHaftalik(pzt, cum),
    ]);

    const rapor = olusturRapor(pzt, cum, satislar, alislar);

    if (req.query?.dry === '1') {
      return res.status(200).json({ ok: true, pzt, cum, rapor });
    }

    await tgSendAll(rapor);

    return res.status(200).json({
      ok: true, pzt, cum,
      gun_sayisi: satislar.length,
      alis_gun_sayisi: alislar.length,
    });
  } catch (err) {
    console.error('weekly-report hata:', err);
    await tgSendAll(`❌ Haftalık rapor hatası: ${err.message}`).catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
