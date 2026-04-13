// api/dia-sync.js
// DIA Web Servis API → Supabase sync
// Toplam DIA çağrısı: login(0) + firma_donem(1) + cari(1) + stok(1) + fatura(1) + logout(0) = 4 kontör

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
  const res = await fetch(`${DIA_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.code !== '200') {
    throw new Error(`DIA API hata: ${data.msg || JSON.stringify(data)}`);
  }
  return data;
}

// ---- 1. LOGIN ----
async function diaLogin() {
  const data = await diaCall('sis/json', {
    login: {
      username: DIA_USERNAME,
      password: DIA_PASSWORD,
      disconnect_same_user: true,
      lang: 'tr',
      params: { apikey: DIA_API_KEY }
    }
  });
  return data.msg; // session_id
}

// ---- 2. LOGOUT ----
async function diaLogout(sessionId) {
  try {
    await diaCall('sis/json', {
      logout: { session_id: sessionId }
    });
  } catch (e) {
    console.warn('Logout hatası (önemsiz):', e.message);
  }
}

// ---- 3. FİRMA/DÖNEM BUL ----
async function diaFirmaDonBul(sessionId) {
  const data = await diaCall('sis/json', {
    sis_yetkili_firma_donem_sube_depo: {
      session_id: sessionId
    }
  });
  const firma = data.result[0]; // ilk yetkili firma
  const donem = firma.donemler.find(d => d.ontanimli === 't') || firma.donemler[0];
  return {
    firma_kodu: firma.firmakodu,
    donem_kodu: donem.donemkodu,
    firma_adi: firma.firmaadi
  };
}

// ---- 4. CARİ LİSTELE ----
async function diaCarileriCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_carikart_listele: {
      session_id: sessionId,
      firma_kodu: firmaKodu,
      donem_kodu: donemKodu,
      filters: [],
      sorts: [{ field: 'carikartkodu', sorttype: 'ASC' }],
      params: {},
      limit: 0,
      offset: 0
    }
  });
  return data.result || [];
}

// ---- 5. STOK LİSTELE ----
async function diaStoklariCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_stokkart_listele: {
      session_id: sessionId,
      firma_kodu: firmaKodu,
      donem_kodu: donemKodu,
      filters: [],
      sorts: [{ field: 'stokkartkodu', sorttype: 'ASC' }],
      params: {},
      limit: 0,
      offset: 0
    }
  });
  return data.result || [];
}

// ---- 6. FATURA LİSTELE ----
async function diaFaturalariCek(sessionId, firmaKodu, donemKodu) {
  const data = await diaCall('scf/json', {
    scf_fatura_listele: {
      session_id: sessionId,
      firma_kodu: firmaKodu,
      donem_kodu: donemKodu,
      filters: [],
      sorts: [{ field: '_cdate', sorttype: 'DESC' }],
      params: {},
      limit: 0,
      offset: 0
    }
  });
  return data.result || [];
}

// ---- SUPABASE UPSERT ----
async function supabaseUpsertCariler(cariler) {
  const rows = cariler.map(c => ({
    dia_key: c._key,
    cari_kart_kodu: c.carikartkodu || '',
    unvan: c.unvan || c.cariadi || '',
    cari_kart_tipi: c.carikarttipi || '',
    vergi_no: c.vergino || '',
    tc_kimlik_no: c.tckimlikno || '',
    vergi_dairesi: c.vergidairesi || '',
    telefon: c.telefon || '',
    eposta: c.eposta || '',
    adres: c.adres || '',
    sehir: c.sehir || '',
    ilce: c.ilce || '',
    bakiye: parseFloat(c.bakiye) || 0,
    borc: parseFloat(c.borc) || 0,
    alacak: parseFloat(c.alacak) || 0,
    raw_data: c,
    synced_at: new Date().toISOString()
  }));

  // Batch upsert (500'lük gruplar)
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase
      .from('dia_cariler')
      .upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Cari upsert hata: ${error.message}`);
  }
  return rows.length;
}

async function supabaseUpsertStoklar(stoklar) {
  const rows = stoklar.map(s => ({
    dia_key: s._key,
    stok_kart_kodu: s.stokkartkodu || '',
    stok_adi: s.stokkartadi || s.stokadi || '',
    birim: s.birimadi || '',
    grup: s.grupadi || '',
    miktar: parseFloat(s.miktar) || 0,
    alis_fiyati: parseFloat(s.alisfiyati) || 0,
    satis_fiyati: parseFloat(s.satisfiyati) || 0,
    raw_data: s,
    synced_at: new Date().toISOString()
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase
      .from('dia_stoklar')
      .upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Stok upsert hata: ${error.message}`);
  }
  return rows.length;
}

async function supabaseUpsertFaturalar(faturalar) {
  const rows = faturalar.map(f => ({
    dia_key: f._key,
    fatura_no: f.faturano || f.belgeno || '',
    belge_no: f.belgeno2 || f.belgeno || '',
    fatura_tipi: f.faturatipi || '',
    tarih: f.tarih || null,
    cari_unvan: f.cariunvan || f.cariadi || '',
    cari_kodu: f.carikartkodu || '',
    toplam_tutar: parseFloat(f.toplamtutar) || 0,
    kdv_tutar: parseFloat(f.toplamkdv) || 0,
    genel_toplam: parseFloat(f.geneltoplam) || 0,
    doviz: f.dovizadi || 'TL',
    raw_data: f,
    synced_at: new Date().toISOString()
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase
      .from('dia_faturalar')
      .upsert(batch, { onConflict: 'dia_key' });
    if (error) throw new Error(`Fatura upsert hata: ${error.message}`);
  }
  return rows.length;
}

// ---- SYNC LOG ----
async function logSync(syncType, status, recordCount, errorMessage, startedAt) {
  await supabase.from('dia_sync_log').insert({
    sync_type: syncType,
    status,
    record_count: recordCount,
    error_message: errorMessage,
    started_at: startedAt,
    completed_at: new Date().toISOString()
  });
}

// ---- ANA HANDLER ----
module.exports = async (req, res) => {
  // Basit güvenlik: query param ile tetikleme
  const authToken = req.query?.token || req.headers?.['x-sync-token'];
  const expectedToken = process.env.SYNC_SECRET || 'napolzeka2024';

  if (authToken !== expectedToken) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }

  // Hangi veri tipleri sync edilecek
  const syncTypes = (req.query?.type || 'all').split(',');
  const syncAll = syncTypes.includes('all');

  const startedAt = new Date().toISOString();
  let sessionId = null;
  const results = {};

  try {
    // 1. Login
    console.log('DIA Login...');
    sessionId = await diaLogin();
    console.log('Session ID alındı');

    // 2. Firma/Dönem bul
    console.log('Firma/Dönem sorgulanıyor...');
    const { firma_kodu, donem_kodu, firma_adi } = await diaFirmaDonBul(sessionId);
    console.log(`Firma: ${firma_adi} (${firma_kodu}), Dönem: ${donem_kodu}`);
    results.firma = { firma_kodu, donem_kodu, firma_adi };

    // 3. Cari sync
    if (syncAll || syncTypes.includes('cari')) {
      console.log('Cariler çekiliyor...');
      const cariler = await diaCarileriCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertCariler(cariler);
      results.cariler = count;
      await logSync('cari', 'success', count, null, startedAt);
      console.log(`${count} cari kaydedildi`);
    }

    // 4. Stok sync
    if (syncAll || syncTypes.includes('stok')) {
      console.log('Stoklar çekiliyor...');
      const stoklar = await diaStoklariCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertStoklar(stoklar);
      results.stoklar = count;
      await logSync('stok', 'success', count, null, startedAt);
      console.log(`${count} stok kaydedildi`);
    }

    // 5. Fatura sync
    if (syncAll || syncTypes.includes('fatura')) {
      console.log('Faturalar çekiliyor...');
      const faturalar = await diaFaturalariCek(sessionId, firma_kodu, donem_kodu);
      const count = await supabaseUpsertFaturalar(faturalar);
      results.faturalar = count;
      await logSync('fatura', 'success', count, null, startedAt);
      console.log(`${count} fatura kaydedildi`);
    }

    // 6. Logout
    await diaLogout(sessionId);
    sessionId = null;

    return res.status(200).json({
      success: true,
      message: 'DIA sync tamamlandı',
      results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('DIA Sync hatası:', error.message);
    await logSync('error', 'failed', 0, error.message, startedAt);

    // Hata durumunda da logout dene
    if (sessionId) {
      await diaLogout(sessionId);
    }

    return res.status(500).json({
      success: false,
      error: error.message,
      results,
      timestamp: new Date().toISOString()
    });
  }
};
