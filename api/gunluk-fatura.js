// /api/gunluk-fatura.js
// Günlük fatura raporu — her gün Pzt-Cuma 18:00 TR (cron: 0 15 * * 1-5 UTC)
// Kaynak: Supabase dia_faturalar (fatura-sync ile günlük güncelleniyor)
// Kural:
//   * GİDEN  (satış) = fatura_no LIKE 'NPE%'  (bizim kestiğimiz faturalar)
//   * GELEN  (alış)  = diğer tüm fatura_no    (TIA/IRM/DLO/SNF/AHM ... vs.)
// Çıktı: Telegram'a iki bölüm halinde gönderim. Kâr/maliyet/marj YOK.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET  = process.env.NAPOL_CRON_SECRET || process.env.CRON_SECRET;

// ----- Yardımcılar -----
const AYLAR = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

function trTarihBugun() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
}

function trDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${AYLAR[m-1]} ${y}`;
}

function fmtTL(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₺';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ----- Supabase REST -----
async function supaSelect(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ----- Telegram -----
async function sendTelegram(chatId, html) {
  // Telegram 4096 char limit; uzun mesajları parçala.
  const parts = html.match(/[\s\S]{1,3900}/g) || [html];
  for (const p of parts) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: p, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) {
      // HTML parse hata olursa plain text fallback
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: p }),
      });
    }
  }
}

// ----- Rapor oluşturucu -----
function raporOlustur(tarih, faturalar) {
  const giden = faturalar.filter(f => (f.fatura_no || '').startsWith('NPE'));
  const gelen = faturalar.filter(f => !(f.fatura_no || '').startsWith('NPE'));

  const sumTutar = arr => arr.reduce((s, f) => s + Number(f.tutar || 0), 0);
  const sumNet   = arr => arr.reduce((s, f) => s + Number(f.net   || 0), 0);

  let msg = `🧾 <b>GÜNLÜK FATURA ÖZETİ</b>\n`;
  msg += `📅 ${trDate(tarih)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  // GİDEN (satış)
  msg += `📤 <b>GİDEN FATURALAR (Satış — NPE)</b>\n`;
  msg += `Adet: <b>${giden.length}</b> | KDV Hariç: <b>${fmtTL(sumTutar(giden))}</b> | KDV Dahil: <b>${fmtTL(sumNet(giden))}</b>\n\n`;
  if (giden.length === 0) {
    msg += `<i>Bugün giden fatura yok.</i>\n\n`;
  } else {
    giden.forEach((f, i) => {
      msg += `${i+1}. <b>${escapeHtml(f.fatura_no)}</b>\n`;
      msg += `   ${escapeHtml((f.cari_adi || '-').substring(0, 60))}\n`;
      msg += `   ${fmtTL(f.tutar)} (KDV dahil: ${fmtTL(f.net)})\n`;
    });
    msg += `\n`;
  }

  // GELEN (alış)
  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `📥 <b>GELEN FATURALAR (Alış — diğer)</b>\n`;
  msg += `Adet: <b>${gelen.length}</b> | KDV Hariç: <b>${fmtTL(sumTutar(gelen))}</b> | KDV Dahil: <b>${fmtTL(sumNet(gelen))}</b>\n\n`;
  if (gelen.length === 0) {
    msg += `<i>Bugün gelen fatura yok.</i>\n`;
  } else {
    gelen.forEach((f, i) => {
      msg += `${i+1}. <b>${escapeHtml(f.fatura_no)}</b>\n`;
      msg += `   ${escapeHtml((f.cari_adi || '-').substring(0, 60))}\n`;
      msg += `   ${fmtTL(f.tutar)} (KDV dahil: ${fmtTL(f.net)})\n`;
    });
  }

  msg += `\n<i>Kaynak: dia_faturalar — fatura-sync (14:00 TR)</i>`;
  return msg;
}

// ----- Handler -----
module.exports = async (req, res) => {
  // Auth: Vercel cron Bearer header, manuel çağrı için ?token= veya x-sync-token
  const auth = req.headers?.authorization || '';
  const token = req.query?.token
             || req.headers?.['x-sync-token']
             || (auth.startsWith('Bearer ') ? auth.slice(7) : null);
  if (CRON_SECRET && token !== CRON_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }

  try {
    if (!TG_TOKEN || !TG_CHAT) {
      return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID eksik' });
    }

    // İsteğe bağlı ?tarih=YYYY-MM-DD parametresi (test için), yoksa TR bugünü.
    const tarih = req.query?.tarih || trTarihBugun();

    const faturalar = await supaSelect(
      'dia_faturalar',
      `tarih=eq.${tarih}&select=fatura_no,tarih,cari_adi,tutar,kdv,net&order=fatura_no.asc`
    );

    const msg = raporOlustur(tarih, faturalar);
    await sendTelegram(TG_CHAT, msg);

    return res.status(200).json({
      success: true,
      tarih,
      toplam: faturalar.length,
      giden: faturalar.filter(f => (f.fatura_no || '').startsWith('NPE')).length,
      gelen: faturalar.filter(f => !(f.fatura_no || '').startsWith('NPE')).length,
    });
  } catch (err) {
    console.error('gunluk-fatura hata:', err.message);
    // Hata durumunda Telegram'a uyarı at (sessiz kalmasın)
    try {
      await sendTelegram(TG_CHAT, `❌ <b>Günlük fatura raporu hata</b>\n${escapeHtml(err.message)}`);
    } catch {}
    return res.status(500).json({ success: false, error: err.message });
  }
};
