// /api/tcmb-sync.js
// TCMB günlük efektif satış kurlarını (USD, EUR) çekip tcmb_kurlar tablosuna yazar.
// Cron: Pzt-Cum 06:00 UTC (~ TR 09:00) — DIA fatura sync'inden önce çalışır.
// Spec referansı: NapolZeka Rapor v2, madde 3 (Kur Kaynağı) ve madde 9.3.

const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const CRON_SECRET  = process.env.NAPOL_CRON_SECRET;

// ----------------------------------------------------------------------------
// TCMB XML fetch
// ----------------------------------------------------------------------------
function fetchTcmbXml() {
  return new Promise((resolve, reject) => {
    https.get('https://www.tcmb.gov.tr/kurlar/today.xml', (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`TCMB HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve(raw));
    }).on('error', reject);
  });
}

// ----------------------------------------------------------------------------
// Çok küçük, niyetli bir XML parser. TCMB formatı sabit:
//   <Currency ... Kod="USD"> ... <BanknoteSelling>...</BanknoteSelling> ... </Currency>
// Tam XML parser kullanmaktan kaçınıyoruz ki Vercel'de extra dependency olmasın.
// ----------------------------------------------------------------------------
function parseTcmbXml(xml) {
  // Tarih_Date Tarih="DD.MM.YYYY"
  const tarihMatch = xml.match(/Tarih_Date[^>]*Tarih="(\d{2})\.(\d{2})\.(\d{4})"/);
  const tarih = tarihMatch
    ? `${tarihMatch[3]}-${tarihMatch[2]}-${tarihMatch[1]}`
    : new Date().toISOString().slice(0, 10);

  function pickCurrency(kod) {
    // <Currency ... Kod="USD" ... > ... </Currency>
    const re = new RegExp(
      `<Currency[^>]*Kod="${kod}"[^>]*>([\\s\\S]*?)</Currency>`,
      'i'
    );
    const m = xml.match(re);
    if (!m) return null;
    const block = m[1];
    const banknote = block.match(/<BanknoteSelling>([\d.]+)<\/BanknoteSelling>/i);
    const forex    = block.match(/<ForexSelling>([\d.]+)<\/ForexSelling>/i);
    // Spec "efektif satış" = BanknoteSelling. Eğer yoksa (hafta sonu gibi),
    // ForexSelling'e fallback ederiz.
    const val = banknote ? banknote[1] : (forex ? forex[1] : null);
    return val ? parseFloat(val) : null;
  }

  const usd = pickCurrency('USD');
  const eur = pickCurrency('EUR');

  if (usd == null || eur == null) {
    throw new Error('TCMB XML beklenen formatta değil (USD/EUR satış bulunamadı).');
  }
  return { tarih, usd_satis: usd, eur_satis: eur };
}

// ----------------------------------------------------------------------------
// Supabase upsert
// ----------------------------------------------------------------------------
function supFetch(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(`${SUPABASE_URL}/rest/v1${path}`);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------
module.exports = async (req, res) => {
  // Vercel cron Authorization header'ı: "Bearer <CRON_SECRET>"
  // Manuel tetiklemede ?token=... veya x-cron-secret header'ı da kabul ederiz.
  const auth = req.headers?.authorization || '';
  const tokenQ = req.query?.token;
  const tokenH = req.headers?.['x-cron-secret'];
  const ok =
    (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && (tokenQ === CRON_SECRET || tokenH === CRON_SECRET));

  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const xml = await fetchTcmbXml();
    const kur = parseTcmbXml(xml);

    await supFetch('/tcmb_kurlar?on_conflict=tarih', 'POST', [
      {
        tarih: kur.tarih,
        usd_satis: kur.usd_satis,
        eur_satis: kur.eur_satis,
        cekildi_at: new Date().toISOString(),
      },
    ]);

    return res.status(200).json({
      ok: true,
      tarih: kur.tarih,
      usd_satis: kur.usd_satis,
      eur_satis: kur.eur_satis,
    });
  } catch (err) {
    console.error('tcmb-sync hata:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
