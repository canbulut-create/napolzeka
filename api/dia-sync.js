// /api/dia-sync.js — NapolZeka Rapor v2 Faz 2
//
// DIA Web Servis API → Supabase sync.
// Modlar (?type=...):
//   stok-full        : scf_stokkart_detay_listele, key-based chunked, ekalan parse, upsert
//   stok-test        : İlk 5 stok kartını çekip raw_data ile döndür (debug)
//   kalem            : scf_fatura_listele_ayrintili, tarih veya from/to ile, upsert
//   kalem-test       : Belirtilen tarihin ilk 5 kalemini raw döndür (debug)
//   karlilik-sync    : rpr_raporsonuc_getir (SCF2240A), tarih aralığı ile, dia_karlilik_raporu upsert
//   rapor-params     : DIA rapor parametrelerini öğrenme (debug)
//   rapor-cek        : Genel rapor çekme (debug)
//
// Auth: ?token=<NAPOL_SYNC_SECRET> veya header x-sync-token

const { createClient } = require('@supabase/supabase-js');

const DIA_BASE_URL = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const DIA_USERNAME = process.env.DIA_USERNAME;
const DIA_PASSWORD = process.env.DIA_PASSWORD;
const DIA_API_KEY  = process.env.DIA_API_KEY;
// dia-sync üç auth yolu kabul eder:
//   1) ?token=<secret>
//   2) x-sync-token: <secret>
//   3) Authorization: Bearer <secret> (Vercel cron için)
// Env önceliği: NAPOL_CRON_SECRET > CRON_SECRET > NAPOL_SYNC_SECRET > SYNC_SECRET
const SYNC_SECRET  = process.env.NAPOL_CRON_SECRET
                  || process.env.CRON_SECRET
                  || process.env.NAPOL_SYNC_SECRET
                  || process.env.SYNC_SECRET
                  || 'napolzeka2024';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// ============================================================================
// DIA API çağrı yardımcıları
// ============================================================================
async function diaCall(endpoint, body) {
  const res = await fetch(`${DIA_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`DIA JSON parse hata: ${text.substring(0, 300)}`); }
  if (String(data.code) !== '200') {
    throw new Error(`DIA API [code=${data.code}]: ${data.msg || JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

async function diaLogin() {
  const data = await diaCall('sis/json', {
    login: {
      username: DIA_USERNAME, password: DIA_PASSWORD,
      disconnect_same_user: true, lang: 'tr',
      params: { apikey: DIA_API_KEY },
    },
  });
  return data.msg;
}

async function diaLogout(sessionId) {
  try { await diaCall('sis/json', { logout: { session_id: sessionId } }); }
  catch { /* önemsiz */ }
}

async function diaFirmaDonBul(sessionId, hedefYil) {
  const data = await diaCall('sis/json', {
    sis_yetkili_firma_donem_sube_depo: { session_id: sessionId },
  });
  const firma = data.result[0];
  let donem;
  if (hedefYil) {
    donem = firma.donemler.find(d => d.baslangictarihi && d.baslangictarihi.startsWith(String(hedefYil)));
  }
  if (!donem) {
    donem = firma.donemler.find(d => d.ontanimli === 't') || firma.donemler[0];
  }
  return { firma_kodu: firma.firmakodu, donem_kodu: donem.donemkodu, firma_adi: firma.firmaadi };
}

// ============================================================================
// Ekalan parse — "0,0940 USD" → { tutar: 0.094, doviz: 'USD' }
// ============================================================================
function parseEkalanMaliyet(s) {
  if (s == null) return { tutar: null, doviz: null, hata: null };
  const trimmed = String(s).trim();
  if (trimmed === '') return { tutar: null, doviz: null, hata: null };

  // "0,0940 USD" / "1.234,56 EUR" / "4,2857 TL" / "4,2857 TRY"
  const m = trimmed.match(/^([\d.,]+)\s+(USD|EUR|TL|TRY)$/i);
  if (!m) return { tutar: null, doviz: null, hata: `parse_fail:${trimmed.slice(0, 32)}` };

  // Türkçe locale: binlik nokta, ondalık virgül
  const numStr = m[1].replace(/\./g, '').replace(',', '.');
  const tutar = parseFloat(numStr);
  if (!Number.isFinite(tutar)) {
    return { tutar: null, doviz: null, hata: `nan:${trimmed.slice(0, 32)}` };
  }
  const dovizRaw = m[2].toUpperCase();
  const doviz = dovizRaw === 'TRY' ? 'TL' : dovizRaw;
  return { tutar, doviz, hata: null };
}

// ============================================================================
// Stok sync — scf_stokkart_detay_listele, _key chunked
// ============================================================================
async function diaStokDetayChunk(sessionId, firmaKodu, donemKodu, baslangicKey, limit) {
  const data = await diaCall('scf/json', {
    scf_stokkart_detay_listele: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters: [
        { field: '_key', operator: '>', value: baslangicKey },
        // durum filtresi: 'A' = aktif (ornek_script doc'tan)
        { field: 'durum', operator: '=', value: 'A' },
      ],
      sorts: [{ field: '_key', sorttype: 'ASC' }],
      params: {
        _key_sis_depo: 0, _key_sis_depo_filtre: 0,
        tarih: '2099-12-31',
        selectedcolumns: [
          '_key', '_date', 'stokkartkodu', 'aciklama', 'anabarkod',
          'ekalan1', 'ekalan2', 'ekalan3', 'ekalan6',
          'doviz1', 'doviz2',
          'fiyat1', 'fiyat2',
          'gercek_stok', 'fiili_stok',
        ],
      },
      limit,
    },
  });
  return data.result || [];
}

function stokKayitMap(s) {
  const e1 = parseEkalanMaliyet(s.ekalan1);
  const e2 = parseEkalanMaliyet(s.ekalan2);
  const parseHatasi = [e1.hata, e2.hata].filter(Boolean).join(' | ') || null;
  return {
    dia_key: s._key,
    stok_kart_kodu: s.stokkartkodu || '',
    stok_adi: s.aciklama || s.stokkartadi || s.stokadi || '',
    birim: s.birimadi || '',
    grup: s.grupadi || '',
    alis_fiyati: parseFloat(s.fiyat1) || 0,
    satis_fiyati: parseFloat(s.fiyat2) || 0,
    ekalan1_raw:   s.ekalan1 ?? null,
    ekalan2_raw:   s.ekalan2 ?? null,
    ekalan1_tutar: e1.tutar,
    ekalan1_doviz: e1.doviz,
    ekalan2_tutar: e2.tutar,
    ekalan2_doviz: e2.doviz,
    ekalan_parse_hata: parseHatasi,
    raw_data: s,
    synced_at: new Date().toISOString(),
  };
}

async function syncStokFull(sessionId, firmaKodu, donemKodu) {
  const limit = 100;
  let baslangicKey = 0;
  let toplam = 0;
  let parse_hatasi_sayisi = 0;
  let donguSayisi = 0;
  const maxDongu = 200; // 100 × 200 = 20K stok kartı tavanı

  while (donguSayisi < maxDongu) {
    donguSayisi++;
    const chunk = await diaStokDetayChunk(sessionId, firmaKodu, donemKodu, baslangicKey, limit);
    if (chunk.length === 0) break;

    const rows = chunk.map(stokKayitMap);
    parse_hatasi_sayisi += rows.filter(r => r.ekalan_parse_hata).length;

    const { error } = await supabase
      .from('dia_stoklar')
      .upsert(rows, { onConflict: 'dia_key' });
    if (error) throw new Error(`Stok upsert: ${error.message}`);

    toplam += rows.length;
    baslangicKey = chunk[chunk.length - 1]._key;

    if (chunk.length < limit) break;
  }
  return { toplam, parse_hatasi_sayisi, dongu: donguSayisi };
}

// ============================================================================
// Kalem sync — scf_fatura_listele_ayrintili, tarih bazlı
// ============================================================================
async function diaKalemChunk(sessionId, firmaKodu, donemKodu, from, to, baslangicKey, limit) {
  const filters = [{ field: '_key', operator: '>', value: baslangicKey }];
  if (from) filters.push({ field: 'tarih', operator: '>=', value: from });
  if (to)   filters.push({ field: 'tarih', operator: '<=', value: to });

  const data = await diaCall('scf/json', {
    scf_fatura_listele_ayrintili: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters,
      sorts: [{ field: '_key', sorttype: 'ASC' }],
      params: {
        // selectedcolumns boş bırakırsak tüm field'lar gelir — ilk sync'te güvenli
        // Sonraki sync'lerde gözlem sonrası daraltılabilir.
      },
      limit,
    },
  });
  return data.result || [];
}

function kalemKayitMap(k) {
  // Field adları: doc bot fetch boştu, canlı response'a göre uyarlanacak.
  // Güvenli fallback'lerle yazıyorum — ilk canlı çağrıdan sonra düzeltilebilir.
  return {
    dia_key:        k._key,
    fatura_no:      String(k.belgeno2 || k.faturano || k.belgeno || ''),
    fatura_tarihi:  k.tarih || k.faturatarihi || null,
    stok_kodu:      k.stokkartkodu || k.stokkodu || null,
    stok_adi:       k.aciklama || k.stokadi || null,
    miktar:         parseFloat(k.miktar) || 0,
    birim:          k.birimadi || k.birim || null,
    birim_fiyat_tl: parseFloat(k.birimfiyat) || 0,
    // KDV hariç satır tutarı: DIA tipik isimler: tutar, kdvharictutar, netfiyat × miktar
    satir_tutari_tl: parseFloat(k.tutar ?? k.kdvharictutar ?? k.toplam) || 0,
    fatura_kuru:    parseFloat(k.dovizkuru) || null,
    fatura_doviz:   k.doviz || k.dovizadi || null,
    raw_data:       k,
    synced_at:      new Date().toISOString(),
  };
}

async function syncKalemler(sessionId, firmaKodu, donemKodu, { from, to }) {
  const limit = 200;
  let baslangicKey = 0;
  let toplam = 0;
  let donguSayisi = 0;
  const maxDongu = 100; // 200 × 100 = 20K kalem tavanı

  while (donguSayisi < maxDongu) {
    donguSayisi++;
    const chunk = await diaKalemChunk(sessionId, firmaKodu, donemKodu, from, to, baslangicKey, limit);
    if (chunk.length === 0) break;

    const rows = chunk.map(kalemKayitMap).filter(r => r.fatura_no && r.dia_key);
    if (rows.length > 0) {
      const { error } = await supabase
        .from('dia_fatura_kalemleri')
        .upsert(rows, { onConflict: 'dia_key' });
      if (error) throw new Error(`Kalem upsert: ${error.message}`);
      toplam += rows.length;
    }

    baslangicKey = chunk[chunk.length - 1]._key;
    if (chunk.length < limit) break;
  }
  return { toplam, dongu: donguSayisi };
}

// ============================================================================
// Karlilik sync — SCF2240A raporu → dia_karlilik_raporu upsert
// ============================================================================
async function diaRaporSonucGetir(sessionId, firmaKodu, donemKodu, raporKodu, tasarimKey, param) {
  const data = await diaCall('rpr/json', {
    rpr_raporsonuc_getir: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      report_code: raporKodu,
      tasarim_key: parseInt(tasarimKey) || 0,
      param: param || {},
      format_type: 'json',
    },
  });
  return data.result;
}

function karlilikSatirMap(r, raporTarihi) {
  // SCF2240A rapor satırı field'ları (mevcut data'dan gözlemlenmiş):
  // tarih, fatura_no/belgeno, fis_turu, cari_kodu, cari_unvan, stok_kodu, stok_adi,
  // miktar, birim, birim_fiyat, toplam_tutar, maliyet, kar, kar_orani
  const fatura_no = r.fatura_no || r.belgeno || r.belgeno2 || null;
  const maliyet   = parseFloat(r.maliyet) || 0;
  const toplam    = parseFloat(r.toplam_tutar ?? r.tutar) || 0;
  const kar       = parseFloat(r.kar ?? (toplam - maliyet)) || 0;
  const kar_orani = parseFloat(r.kar_orani) || (toplam !== 0 ? (kar / Math.abs(toplam)) * 100 : 0);

  return {
    tarih:         r.tarih || raporTarihi,
    fatura_no,
    fis_turu:      r.fis_turu || r.turuaciklama || null,
    cari_kodu:     r.cari_kodu || r.carikodu || null,
    cari_unvan:    r.cari_unvan || r.carifirma || null,
    stok_kodu:     r.stok_kodu || r.stokkartkodu || null,
    stok_adi:      r.stok_adi || r.aciklama || null,
    miktar:        parseFloat(r.miktar) || null,
    birim:         r.birim || null,
    birim_fiyat:   parseFloat(r.birim_fiyat) || null,
    toplam_tutar:  toplam,
    maliyet,
    kar,
    kar_orani,
    maliyetsiz_mi: maliyet === 0 && toplam > 0,
    gider_kalemi_mi: (r.fis_turu || '').toLowerCase().includes('gider') || false,
    doviz:         r.doviz || 'TRY',
    yukleme_tarihi: new Date().toISOString(),
  };
}

async function syncKarlilik(sessionId, firmaKodu, donemKodu, { from, to, raporKodu = 'SCF2240A', tasarimKey = 808 }) {
  // DIA SCF2240A rapor parametreleri: param objesinde tarih aralığı verilir.
  // Tasarım key 808 mevcut dia-sync.js'in commit history'sinden (c2fbf23: "tasarim_key 807->808").
  const param = {
    // DIA rapor parametreleri rapor tasarımına göre değişebilir; aşağıdaki anahtarlar
    // SCF2240A için yaygın isimler. İlk canlı çağrıdan sonra param adı net olur.
    tarih_bas: from,
    tarih_son: to,
  };
  const raporSonuc = await diaRaporSonucGetir(sessionId, firmaKodu, donemKodu, raporKodu, tasarimKey, param);

  // raporSonuc tipik olarak satır dizisi (yeni format) veya { data: [...] } (eski format)
  const satirlar = Array.isArray(raporSonuc) ? raporSonuc :
                    Array.isArray(raporSonuc?.data) ? raporSonuc.data : [];

  if (satirlar.length === 0) {
    return { toplam: 0, not: 'Rapor sonucu boş veya beklenmeyen formatta', raw_sample: raporSonuc };
  }

  const rows = satirlar.map(s => karlilikSatirMap(s, to)).filter(r => r.tarih);

  // Batch upsert
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    // Karlilik tablosunda generated column fatura_tipi + unique constraint var (migration history'den)
    const { error } = await supabase
      .from('dia_karlilik_raporu')
      .upsert(batch, { onConflict: 'fatura_no,stok_kodu,tarih', ignoreDuplicates: false });
    if (error) {
      // onConflict yoksa düz insert dene (idempotent değil, ama boş tabloda çalışır)
      const { error: e2 } = await supabase.from('dia_karlilik_raporu').insert(batch);
      if (e2) throw new Error(`Karlilik upsert: ${error.message} | insert fallback: ${e2.message}`);
    }
  }
  return { toplam: rows.length };
}

// ============================================================================
// Sync log
// ============================================================================
async function logSync(tablo, islem, kayit_sayisi, hata) {
  try {
    await supabase.from('dia_sync_log').insert({
      tablo, islem, kayit_sayisi: kayit_sayisi ?? null, hata: hata ?? null,
    });
  } catch { /* log hatası önemsiz */ }
}

// ============================================================================
// Handler
// ============================================================================
module.exports = async (req, res) => {
  const auth = req.headers?.authorization || '';
  const authToken = req.query?.token
                 || req.headers?.['x-sync-token']
                 || (auth.startsWith('Bearer ') ? auth.slice(7) : null);
  if (!SYNC_SECRET || authToken !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }

  const tip = (req.query?.type || 'help').toLowerCase();
  const results = {};
  let sessionId = null;

  try {
    sessionId = await diaLogin();
    const { firma_kodu, donem_kodu, firma_adi } = await diaFirmaDonBul(sessionId, 2026);
    results.firma = { firma_kodu, donem_kodu, firma_adi };

    switch (tip) {
      case 'help':
        results.modlar = {
          'stok-full': 'Tüm stok kartlarını çek + ekalan parse + upsert',
          'stok-test': 'İlk 5 stok kartını ham olarak döndür (debug)',
          'kalem':     '?from=YYYY-MM-DD&to=YYYY-MM-DD fatura kalemlerini çek + upsert',
          'kalem-test': '?tarih=YYYY-MM-DD → o günün ilk 5 kalemini ham olarak döndür',
          'karlilik-sync': '?from=&to= SCF2240A raporu → dia_karlilik_raporu upsert',
          'rapor-params': '?rapor=SCF2240A — rapor parametre listesi (debug)',
          'rapor-cek': '?rapor=&tasarim_key=&param=... — rapor sonucu ham döndür (debug)',
        };
        break;

      case 'stok-full': {
        const out = await syncStokFull(sessionId, firma_kodu, donem_kodu);
        results.stok_full = out;
        await logSync('dia_stoklar', 'stok-full', out.toplam, null);
        break;
      }

      case 'stok-test': {
        const chunk = await diaStokDetayChunk(sessionId, firma_kodu, donem_kodu, 0, 5);
        results.stok_test = chunk.map(s => ({
          _key: s._key,
          stokkartkodu: s.stokkartkodu,
          aciklama: s.aciklama,
          ekalan1: s.ekalan1, ekalan2: s.ekalan2, ekalan3: s.ekalan3, ekalan6: s.ekalan6,
          doviz1: s.doviz1, doviz2: s.doviz2,
          fiyat1: s.fiyat1, fiyat2: s.fiyat2,
          parse_ekalan1: parseEkalanMaliyet(s.ekalan1),
          parse_ekalan2: parseEkalanMaliyet(s.ekalan2),
          all_keys: Object.keys(s),
        }));
        break;
      }

      case 'kalem': {
        // Vercel cron path'i statik olduğu için parametre yoksa bugün TR'yi kullan.
        const bugunTR = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
        const from = req.query?.from || req.query?.tarih || bugunTR;
        const to   = req.query?.to   || req.query?.tarih || bugunTR;
        const out = await syncKalemler(sessionId, firma_kodu, donem_kodu, { from, to });
        results.kalem = { from, to, ...out };
        await logSync('dia_fatura_kalemleri', 'kalem', out.toplam, null);
        break;
      }

      case 'kalem-test': {
        const tarih = req.query?.tarih;
        if (!tarih) throw new Error('?tarih=YYYY-MM-DD gerekli');
        const chunk = await diaKalemChunk(sessionId, firma_kodu, donem_kodu, tarih, tarih, 0, 5);
        results.kalem_test = chunk.map(k => ({
          _key: k._key, fatura_no: k.belgeno2 || k.faturano, tarih: k.tarih,
          stok: k.stokkartkodu, miktar: k.miktar, birimfiyat: k.birimfiyat,
          tutar: k.tutar, doviz: k.doviz, dovizkuru: k.dovizkuru,
          all_keys: Object.keys(k),
        }));
        break;
      }

      case 'karlilik-sync': {
        const bugunTR = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
        const from = req.query?.from || bugunTR;
        const to   = req.query?.to   || bugunTR;
        const out = await syncKarlilik(sessionId, firma_kodu, donem_kodu, { from, to });
        results.karlilik = { from, to, ...out };
        await logSync('dia_karlilik_raporu', 'karlilik-sync', out.toplam, null);
        break;
      }

      case 'rapor-params': {
        const raporKodu = req.query?.rapor || 'SCF2240A';
        const data = await diaCall('rpr/json', {
          rpr_dinamik_raporparametreleri_getir: {
            session_id: sessionId, firma_kodu, donem_kodu, report_code: raporKodu,
          },
        });
        results.rapor_params = data.result || data;
        break;
      }

      case 'rapor-cek': {
        const raporKodu = req.query?.rapor || 'SCF2240A';
        const tasarimKey = req.query?.tasarim_key || 808;
        let param = {};
        if (req.query?.param) {
          try { param = JSON.parse(decodeURIComponent(req.query.param)); } catch { /* */ }
        }
        const out = await diaRaporSonucGetir(sessionId, firma_kodu, donem_kodu, raporKodu, tasarimKey, param);
        results.rapor = out;
        break;
      }

      default:
        results.uyari = `Bilinmeyen tip: ${tip}. ?type=help ile mod listesini gör.`;
    }

    await diaLogout(sessionId);
    sessionId = null;
    return res.status(200).json({ success: true, results, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('dia-sync hata:', err.message);
    await logSync('hata', tip, 0, err.message);
    if (sessionId) await diaLogout(sessionId);
    return res.status(500).json({ success: false, error: err.message, results });
  }
};
