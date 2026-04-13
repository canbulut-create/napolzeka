// api/dia-sync.js
// DIA Web Servis API → Supabase sync + Rapor Parametreleri
const { createClient } = require('@supabase/supabase-js');

const DIA_BASE_URL = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const DIA_USERNAME = process.env.DIA_USERNAME;
const DIA_PASSWORD = process.env.DIA_PASSWORD;
const DIA_API_KEY = process.env.DIA_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://lsxvskcdbppslpxaixky.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// ---- DIA API Helper ----
async function diaCall(endpoint, body) {
  console.log('DIA istek:', endpoint, JSON.stringify(body).substring(0, 200));
  const res = await fetch(`${DIA_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  console.log('DIA ham yanit:', text.substring(0, 500));
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`DIA JSON parse hata: ${text.substring(0, 300)}`);
  }
  if (String(data.code) !== '200') {
    throw new Error(`DIA API hata [code=${data.code}]: ${data.msg || JSON.stringify(data).substring(0, 300)}`);
  }
  return data;
}

// ---- 1. LOGIN ----
async function diaLogin() {
  console.log('Login baslatiliyor...');
  console.log('Server:', process.env.DIA_SERVER, 'User:', DIA_USERNAME);
  console.log('API Key uzunluk:', DIA_API_KEY ? DIA_API_KEY.length : 'YOK');
  const data = await diaCall('sis/json', {
    login: {
      username: DIA_USERNAME,
      password: DIA_PASSWORD,
      disconnect_same_user: true,
      lang: 'tr',
      params: { apikey: DIA_API_KEY }
    }
  });
  console.log('Login basarili, session_id:', data.msg);
  return data.msg;
}

// ---- 2. LOGOUT ----
async function diaLogout(sessionId) {
  try {
    await diaCall('sis/json', { logout: { session_id: sessionId } });
  } catch (e) {
    console.warn('Logout hatasi (onemsiz):', e.message);
  }
}

// ---- 3. FIRMA/DONEM BUL ----
async function diaFirmaDonBul(sessionId) {
  const data = await diaCall('sis/json', {
    sis_yetkili_firma_donem_sube_depo: { session_id: sessionId }
  });
  const firma = data.result[0];
  const donem = firma.donemler.find(d => d.ontanimli === 't') || firma.donemler[0];
  return { firma_kodu: firma.firmakodu, donem_kodu: donem.donemkodu, firma_adi: firma.firmaadi };
}

// ---- 4. CARI LISTELE ----
async function diaCarileriCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_carikart_listele: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters: [], sorts: [{ field: 'carikartkodu', sorttype: 'ASC' }], params: {}, limit: 0, offset: 0
    }
  });
  return data.result || [];
}

// ---- 5. STOK LISTELE ----
async function diaStoklariCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_stokkart_listele: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters: [], sorts: [{ field: 'stokkartkodu', sorttype: 'ASC' }], params: {}, limit: 0, offset: 0
    }
  });
  return data.result || [];
}

// ---- 6. FATURA LISTELE ----
async function diaFaturalariCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_fatura_listele: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters: [], sorts: [{ field: '_cdate', sorttype: 'DESC' }], params: {}, limit: 0, offset: 0
    }
  });
  return data.result || [];
}

// ---- 7. RAPOR TASARIM LISTELE ----
async function diaRaporTasarimListele(sessionId, firmaKodu, donemKodu, raporKodu) {
  const data = await diaCall('rpr/json', {
    rpr_tasarimlar_listele: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      filters: [
        { field: 'raporkodu', operator: '=', value: raporKodu },
        { field: 'dil', operator: '=', value: 'tr' }
      ],
      sorts: ''
    }
  });
  return data.result || [];
}

// ---- 8. RAPOR PARAMETRELERI GETIR ----
async function diaRaporParametreleriGetir(sessionId, firmaKodu, donemKodu, raporKodu) {
  const data = await diaCall('rpr/json', {
    rpr_dinamik_raporparametreleri_getir: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      report_code: raporKodu
    }
  });
  return data.result || [];
}

// ---- 9. RAPOR SONUC GETIR ----
async function diaRaporSonucGetir(sessionId, firmaKodu, donemKodu, raporKodu, tasarimKey, param, formatType) {
  const data = await diaCall('rpr/json', {
    rpr_raporsonuc_getir: {
      session_id: sessionId, firma_kodu: firmaKodu, donem_kodu: donemKodu,
      report_code: raporKodu,
      tasarim_key: tasarimKey,
      param: param,
      format_type: formatType || 'json'
    }
  });
  return data.result;
}

// ---- SUPABASE UPSERT ----
async function supabaseUpsertCariler(cariler) {
  const rows = cariler.map(c => ({
    dia_key: c._key, cari_kart_kodu: c.carikartkodu || '', unvan: c.unvan || c.cariadi || '',
    cari_kart_tipi: c.carikarttipi || '', vergi_no: c.vergino || '', tc_kimlik_no: c.tckimlikno || '',
    vergi_dairesi: c.vergidairesi || '', telefon: c.telefon || '', eposta: c.eposta || '',
    adres: c.adres || '', sehir: c.sehir || '', ilce: c.ilce || '',
    bakiye: parseFloat(c.bakiye) || 0, borc: parseFloat(c.borc) || 0, alacak: parseFloat(c.alacak) || 0,
    raw_data: c, synced_at: new Date().toISOString()
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('dia_cariler').upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Cari upsert hata: ${error.message}`);
  }
  return rows.length;
}

async function supabaseUpsertStoklar(stoklar) {
  const rows = stoklar.map(s => ({
    dia_key: s._key, stok_kart_kodu: s.stokkartkodu || '', stok_adi: s.stokkartadi || s.stokadi || '',
    birim: s.birimadi || '', grup: s.grupadi || '', miktar: parseFloat(s.miktar) || 0,
    alis_fiyati: parseFloat(s.alisfiyati) || 0, satis_fiyati: parseFloat(s.satisfiyati) || 0,
    raw_data: s, synced_at: new Date().toISOString()
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('dia_stoklar').upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Stok upsert hata: ${error.message}`);
  }
  return rows.length;
}

async function supabaseUpsertFaturalar(faturalar) {
  const rows = faturalar.map(f => ({
    dia_key: f._key, fatura_no: f.faturano || f.belgeno || '', belge_no: f.belgeno2 || f.belgeno || '',
    fatura_tipi: f.faturatipi || '', tarih: f.tarih || null,
    cari_unvan: f.cariunvan || f.cariadi || '', cari_kodu: f.carikartkodu || '',
    toplam_tutar: parseFloat(f.toplamtutar) || 0, kdv_tutar: parseFloat(f.toplamkdv) || 0,
    genel_toplam: parseFloat(f.geneltoplam) || 0, doviz: f.dovizadi || 'TL',
    raw_data: f, synced_at: new Date().toISOString()
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('dia_faturalar').upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Fatura upsert hata: ${error.message}`);
  }
  return rows.length;
}

// ---- SYNC LOG ----
async function logSync(syncType, status, recordCount, errorMessage, startedAt) {
  await supabase.from('dia_sync_log').insert({
    sync_type: syncType, status, record_count: recordCount,
    error_message: errorMessage, started_at: startedAt, completed_at: new Date().toISOString()
  });
}

// ---- ANA HANDLER ----
module.exports = async (req, res) => {
  const authToken = req.query?.token || req.headers?.['x-sync-token'];
  const expectedToken = process.env.SYNC_SECRET || 'napolzeka2024';
  if (authToken !== expectedToken) {
    return res.status(401).json({ error: 'Yetkisiz erisim' });
  }

  const syncTypes = (req.query?.type || 'all').split(',');
  const syncAll = syncTypes.includes('all');
  const raporKodu = req.query?.rapor || '';

  const startedAt = new Date().toISOString();
  let sessionId = null;
  const results = {};

  try {
    // 1. Login
    console.log('DIA Login...');
    sessionId = await diaLogin();
    console.log('Session ID alindi:', sessionId);

    // 2. Firma/Donem bul
    console.log('Firma/Donem sorgulanıyor...');
    const { firma_kodu, donem_kodu, firma_adi } = await diaFirmaDonBul(sessionId);
    console.log(`Firma: ${firma_adi} (${firma_kodu}), Donem: ${donem_kodu}`);
    results.firma = { firma_kodu, donem_kodu, firma_adi };

    // ---- RAPOR PARAMETRELERI OGRENME ----
    if (syncTypes.includes('rapor-params') && raporKodu) {
      console.log(`Rapor parametreleri sorgulanıyor: ${raporKodu}`);

      // Tasarim listele
      const tasarimlar = await diaRaporTasarimListele(sessionId, firma_kodu, donem_kodu, raporKodu);
      results.tasarimlar = tasarimlar;
      console.log(`${tasarimlar.length} tasarim bulundu`);

      // Parametreler
      const parametreler = await diaRaporParametreleriGetir(sessionId, firma_kodu, donem_kodu, raporKodu);
      results.parametreler = parametreler;
      console.log('Parametreler alindi');
    }

    // ---- RAPOR CEKME ----
    if (syncTypes.includes('rapor-cek') && raporKodu) {
      const tasarimKey = req.query?.tasarim_key || '0';
      const formatType = req.query?.format || 'json';

      // param JSON olarak query string'den al
      let param = {};
      if (req.query?.param) {
        try { param = JSON.parse(decodeURIComponent(req.query.param)); } catch(e) { console.warn('Param parse hata:', e.message); }
      }

      console.log(`Rapor cekiliyor: ${raporKodu}, tasarim: ${tasarimKey}, format: ${formatType}`);
      const raporSonuc = await diaRaporSonucGetir(sessionId, firma_kodu, donem_kodu, raporKodu, tasarimKey, param, formatType);
      results.rapor = raporSonuc;
      console.log('Rapor alindi');
    }

    // ---- CARI SYNC ----
    if (syncAll || syncTypes.includes('cari')) {
      console.log('Cariler cekiliyor...');
      const cariler = await diaCarileriCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertCariler(cariler);
      results.cariler = count;
      await logSync('cari', 'success', count, null, startedAt);
      console.log(`${count} cari kaydedildi`);
    }

    // ---- STOK SYNC ----
    if (syncAll || syncTypes.includes('stok')) {
      console.log('Stoklar cekiliyor...');
      const stoklar = await diaStoklariCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertStoklar(stoklar);
      results.stoklar = count;
      await logSync('stok', 'success', count, null, startedAt);
      console.log(`${count} stok kaydedildi`);
    }

    // ---- FATURA SYNC ----
    if (syncAll || syncTypes.includes('fatura')) {
      console.log('Faturalar cekiliyor...');
      const faturalar = await diaFaturalariCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertFaturalar(faturalar);
      results.faturalar = count;
      await logSync('fatura', 'success', count, null, startedAt);
      console.log(`${count} fatura kaydedildi`);
    }

    // 6. Logout
    await diaLogout(sessionId);
    sessionId = null;

    return res.status(200).json({ success: true, message: 'DIA islem tamamlandi', results, timestamp: new Date().toISOString() });

  } catch (error) {
    console.error('DIA hatasi:', error.message);
    await logSync('error', 'failed', 0, error.message, startedAt);
    if (sessionId) { await diaLogout(sessionId); }
    return res.status(500).json({ success: false, error: error.message, results, timestamp: new Date().toISOString() });
  }
};
