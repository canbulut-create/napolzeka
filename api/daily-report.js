// /api/daily-report.js
// NapolZeka Rapor v2 — Günlük rapor (Pzt-Cum 18:00 TR)
// Cron: Pzt-Cum 15:00 UTC = 18:00 TR
// Kaynak: Supabase dia_karlilik_raporu (NPE prefix = satış, fatura_tipi generated column)
// Çıktı : Telegram, spec NapolZeka Rapor v2 madde 4 formatında.
//
// Faz 1 sınırı:
//   * Kâr 2 (defter)  : dia_karlilik_raporu.kar kullanılır — hesaplanır.
//   * Kâr 1 (güncel kur): kalem sync (dia_fatura_kalemleri) ve stok ek_alan_1 lazım.
//                         Faz 2'de eklenecek. Şu an "—" olarak gösterilir
//                         ve toplamda not olarak belirtilir.

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;
const ADMIN_IDS    = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CRON_SECRET  = process.env.CRON_SECRET;

// ----------------------------------------------------------------------------
// Format yardımcıları (Türkçe konvansiyon: binlik nokta, ondalık virgül)
// ----------------------------------------------------------------------------
const AYLAR = [
  'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

function trDate(iso) {
  // iso: 'YYYY-MM-DD' → '26 Mayıs 2026'
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${AYLAR[m - 1]} ${y}`;
}

function trTarihBugunIstanbul() {
  // TR saatine göre bugün (YYYY-MM-DD)
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
}

function fmtTL(n, opts = {}) {
  // Spec madde 7: "Tüm rakamlar açık yazılır: 245.000 TL (kısaltma yok)"
  const { kurus = false, isaret = false } = opts;
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const s = abs.toLocaleString('tr-TR', {
    minimumFractionDigits: kurus ? 2 : 0,
    maximumFractionDigits: kurus ? 2 : 0,
  });
  const sign = n < 0 ? '-' : (isaret && n > 0 ? '+' : '');
  return `${sign}${s} TL`;
}

function fmtYuzde(n, ondalik = 1) {
  // Spec: %18 (sembol önde, Türkçe konvansiyonu); marjda %14,6 gibi tek ondalık.
  if (n == null || Number.isNaN(n)) return '—';
  const s = n.toLocaleString('tr-TR', {
    minimumFractionDigits: ondalik,
    maximumFractionDigits: ondalik,
  });
  return `%${s}`;
}

// ----------------------------------------------------------------------------
// Supabase REST fetch
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
            if (res.statusCode >= 400) {
              return reject(new Error(`Supabase ${res.statusCode}: ${raw}`));
            }
            try {
              resolve(raw ? JSON.parse(raw) : []);
            } catch {
              resolve([]);
            }
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
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

async function tgSendAll(text) {
  // Spec madde 8: rapor Can'a gider. TELEGRAM_CHAT_ID birincil; ADMIN_TELEGRAM_IDS ek fallback.
  const targets = new Set();
  if (TG_CHAT) targets.add(String(TG_CHAT));
  for (const id of ADMIN_IDS) targets.add(String(id));
  for (const id of targets) await tgSend(id, text);
}

// ----------------------------------------------------------------------------
// Veri çekme
// ----------------------------------------------------------------------------
async function getSatislar(tarih) {
  // vw_gunluk_satis_karlilik: fatura_tipi='satis' AND gider_kalemi_mi=false
  const path =
    `/vw_gunluk_satis_karlilik?tarih=eq.${tarih}` +
    `&select=tarih,fatura_no,cari_unvan,kdv_haric_satis,defter_maliyet,defter_kar,defter_marj,maliyetsiz_mi,stok_kodu` +
    `&order=fatura_no.asc`;
  return supGet(path);
}

async function getAlislar(tarih) {
  const path =
    `/vw_gunluk_alis?tarih=eq.${tarih}` +
    `&select=fatura_no,cari_unvan,kdv_haric_tutar` +
    `&order=fatura_no.asc`;
  return supGet(path);
}

async function getMaliyetsizDetay(tarih) {
  // Maliyetsiz satırların stok_kodu + fatura_no eşlemesini al (spec uyarı bölümü için).
  const path =
    `/dia_karlilik_raporu?tarih=eq.${tarih}` +
    `&fatura_tipi=eq.satis&maliyetsiz_mi=is.true` +
    `&select=fatura_no,stok_kodu,stok_adi`;
  return supGet(path);
}

// ----------------------------------------------------------------------------
// Rapor metnini oluştur
// ----------------------------------------------------------------------------
function olusturRapor(tarih, satislar, alislar, maliyetsizDetay) {
  const baslik = `📊 NAPOL GÜNLÜK RAPOR — ${trDate(tarih)}`;

  // ---- Satış / Alış özet ----
  const satisFaturaSayisi = satislar.length;
  const satisToplam = satislar.reduce((a, r) => a + Number(r.kdv_haric_satis || 0), 0);
  const alisFaturaSayisi = alislar.length;
  const alisToplam = alislar.reduce((a, r) => a + Number(r.kdv_haric_tutar || 0), 0);

  let msg = '';
  msg += `${baslik}\n\n`;
  msg += `💰 SATIŞ\n`;
  msg += `Fatura sayısı: ${satisFaturaSayisi}\n`;
  msg += `Toplam tutar: ${fmtTL(satisToplam)} (KDV'siz)\n\n`;
  msg += `🛒 ALIŞ\n`;
  msg += `Fatura sayısı: ${alisFaturaSayisi}\n`;
  msg += `Toplam tutar: ${fmtTL(alisToplam)} (KDV'siz)\n`;

  // ---- Fatura bazında kârlılık ----
  if (satisFaturaSayisi > 0) {
    msg += `\n📈 FATURA BAZINDA KÂRLILIK\n\n`;

    for (const s of satislar) {
      const defterKar  = Number(s.defter_kar || 0);
      const defterMarj = Number(s.defter_marj || 0);
      // Faz 1: Kâr 1 ve fark hesaplanamıyor → "—"
      const cari = (s.cari_unvan || '').trim();
      msg += `${s.fatura_no} — ${cari}\n`;
      msg += `  Kâr (güncel kur): — (kalem sync bekleniyor)\n`;
      msg += `  Kâr (defter):    ${fmtTL(defterKar)} (${fmtYuzde(defterMarj)})\n`;
      msg += `  Fark:            —\n\n`;
    }
  }

  // ---- Maliyet eksik uyarısı ----
  if (maliyetsizDetay && maliyetsizDetay.length > 0) {
    // Spec madde 4 → "MALİYET EKSİK" başlığı altında fatura bazında stok kodları
    const gruplar = {};
    for (const r of maliyetsizDetay) {
      const fno = r.fatura_no || '(faturasız)';
      if (!gruplar[fno]) gruplar[fno] = [];
      if (r.stok_kodu) gruplar[fno].push(r.stok_kodu);
    }
    msg += `⚠️ MALİYET EKSİK\n`;
    for (const [fno, stoklar] of Object.entries(gruplar)) {
      const adet = stoklar.length || 1;
      msg += `${fno} — ${adet} satırda maliyet=0\n`;
      if (stoklar.length > 0) {
        msg += `  Stok kodları: ${stoklar.join(', ')}\n`;
      }
    }
    msg += `\n`;
  }

  // ---- TOPLAM ----
  const toplamDefterKar = satislar.reduce((a, r) => a + Number(r.defter_kar || 0), 0);
  const defterMarj = satisToplam > 0 ? (toplamDefterKar / satisToplam) * 100 : 0;

  msg += `────────────────\n`;
  msg += `TOPLAM\n`;
  msg += `Kâr (güncel kur): — (kalem sync bekleniyor — Faz 2)\n`;
  msg += `Kâr (defter):    ${fmtTL(toplamDefterKar)} — Marj: ${fmtYuzde(defterMarj)}\n`;
  msg += `Kur farkı etkisi: — (Faz 2)\n`;

  // ---- Veri yok durumu ----
  if (satisFaturaSayisi === 0 && alisFaturaSayisi === 0) {
    msg += `\nℹ️ Bugün karlılık tablosunda hiç satış veya alış faturası yok.\n`;
    msg += `   (dia_karlilik_raporu tablosu SCF2240A çağrısı ile güncellenmeli — Faz 2'de otomatize edilecek.)\n`;
  }

  return msg;
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Vercel cron: Authorization: "Bearer <CRON_SECRET>"
  // Manuel: ?token=... veya x-cron-secret header'ı
  const auth   = req.headers?.authorization || '';
  const tokenQ = req.query?.token;
  const tokenH = req.headers?.['x-cron-secret'];
  const ok =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && (tokenQ === CRON_SECRET || tokenH === CRON_SECRET));

  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // ?tarih=YYYY-MM-DD ile manuel tarih (test için); yoksa bugün TR.
    const tarih = (req.query?.tarih || '').match(/^\d{4}-\d{2}-\d{2}$/)
      ? req.query.tarih
      : trTarihBugunIstanbul();

    const [satislar, alislar, maliyetsiz] = await Promise.all([
      getSatislar(tarih),
      getAlislar(tarih),
      getMaliyetsizDetay(tarih),
    ]);

    const rapor = olusturRapor(tarih, satislar, alislar, maliyetsiz);

    // Önizleme modu (dry-run): ?dry=1 → Telegram'a yollamadan response döner.
    if (req.query?.dry === '1') {
      return res.status(200).json({ ok: true, tarih, rapor });
    }

    await tgSendAll(rapor);

    return res.status(200).json({
      ok: true,
      tarih,
      satis_sayisi: satislar.length,
      alis_sayisi: alislar.length,
      maliyetsiz_satir: (maliyetsiz || []).length,
    });
  } catch (err) {
    console.error('daily-report hata:', err);
    await tgSendAll(`❌ Günlük rapor hatası: ${err.message}`).catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
