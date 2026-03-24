// parasut-sync.js — Vercel Serverless Function
// Parasüt API v4 → Supabase sync + retry mekanizması
// Tablolar: parasut_cariler, parasut_giden_fatura, parasut_gelen_fatura, parasut_stok
// Token: parasut_tokens tablosunda saklanır
// Deploy: api/parasut-sync.js

const { createClient } = require('@supabase/supabase-js');

// ─── Config ───
const PARASUT_API = 'https://api.parasut.com/v4';
const PARASUT_AUTH = 'https://api.parasut.com/oauth/token';
const MAX_RETRIES = 3;

function env(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Eksik env: ${key}`);
  return v;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Supabase Client ───
function getSupabase() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_KEY'));
}

// ─── Token Yönetimi ───
async function getToken(supabase) {
  const { data: existing } = await supabase
    .from('parasut_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (existing && existing.access_token && new Date(existing.expires_at) > new Date()) {
    console.log('🔑 Mevcut token geçerli.');
    return existing.access_token;
  }

  console.log('🔑 Yeni token alınıyor...');
  const body = {
    grant_type: 'password',
    client_id: env('PARASUT_CLIENT_ID'),
    client_secret: env('PARASUT_CLIENT_SECRET'),
    username: env('PARASUT_USERNAME'),
    password: env('PARASUT_PASSWORD'),
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  };

  if (existing && existing.refresh_token) {
    body.grant_type = 'refresh_token';
    body.refresh_token = existing.refresh_token;
    delete body.username;
    delete body.password;
  }

  const res = await fetch(PARASUT_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    if (body.grant_type === 'refresh_token') {
      console.log('⚠️ Refresh başarısız, password ile deneniyor...');
      return getTokenWithPassword(supabase);
    }
    const err = await res.text();
    throw new Error(`Auth hatası: ${res.status} - ${err}`);
  }

  const token = await res.json();
  await saveToken(supabase, token);
  return token.access_token;
}

async function getTokenWithPassword(supabase) {
  const res = await fetch(PARASUT_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: env('PARASUT_CLIENT_ID'),
      client_secret: env('PARASUT_CLIENT_SECRET'),
      username: env('PARASUT_USERNAME'),
      password: env('PARASUT_PASSWORD'),
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Password auth hatası: ${res.status} - ${err}`);
  }

  const token = await res.json();
  await saveToken(supabase, token);
  return token.access_token;
}

async function saveToken(supabase, token) {
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  await supabase.from('parasut_tokens').upsert({
    id: 1,
    access_token: token.access_token,
    refresh_token: token.refresh_token || null,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
  console.log('✅ Token kaydedildi.');
}

// ─── Parasüt API Helper (retry ile) ───
async function apiGet(token, endpoint, params = {}) {
  const companyId = env('PARASUT_COMPANY_ID');
  const url = new URL(`${PARASUT_API}/${companyId}/${endpoint}`);

  if (!params['page[size]']) params['page[size]'] = 25;
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.api+json',
      },
    });

    if (res.status === 429) {
      const waitSec = attempt * 3;
      console.log(`⏳ Rate limit, ${waitSec}s bekleniyor... (deneme ${attempt}/${MAX_RETRIES})`);
      await sleep(waitSec * 1000);
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API hatası [${endpoint}]: ${res.status} - ${err}`);
    }

    return res.json();
  }

  throw new Error(`API rate limit aşıldı [${endpoint}]: ${MAX_RETRIES} deneme başarısız`);
}

async function apiGetAll(token, endpoint, params = {}) {
  let all = [];
  let page = 1;

  while (true) {
    const result = await apiGet(token, endpoint, {
      ...params,
      'page[number]': page,
      'page[size]': 25,
    });

    if (!result.data || result.data.length === 0) break;
    all = all.concat(result.data);

    const totalPages = result.meta?.total_pages || 1;
    if (page >= totalPages) break;
    page++;

    await sleep(500);
  }

  return all;
}

// ─── Sync: Cariler ───
async function syncCariler(token, supabase) {
  console.log('📇 Cariler sync ediliyor...');
  const contacts = await apiGetAll(token, 'contacts');

  const rows = contacts.map((c) => ({
    parasut_id: c.id,
    ad: c.attributes.name || '',
    email: c.attributes.email || '',
    telefon: c.attributes.phone || '',
    adres: c.attributes.address || '',
    vergi_no: c.attributes.tax_number || '',
    vergi_dairesi: c.attributes.tax_office || '',
    tip: c.attributes.account_type || '',
    alacak: parseFloat(c.attributes.balance) || 0,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return { cariler: 0 };

  const { error } = await supabase
    .from('parasut_cariler')
    .upsert(rows, { onConflict: 'parasut_id' });

  if (error) throw new Error(`Cariler hatası: ${error.message}`);
  console.log(`  ✅ ${rows.length} cari sync edildi.`);
  return { cariler: rows.length };
}

// ─── Sync: Giden Fatura ───
async function syncGidenFatura(token, supabase) {
  console.log('🧾 Giden faturalar sync ediliyor...');
  const invoices = await apiGetAll(token, 'sales_invoices', { include: 'contact' });

  const rows = invoices.map((inv) => ({
    parasut_id: inv.id,
    fatura_no: inv.attributes.invoice_id?.toString() || '',
    seri: inv.attributes.invoice_series || '',
    sira: inv.attributes.invoice_id?.toString() || '',
    tarih: inv.attributes.issue_date || null,
    vade_tarihi: inv.attributes.due_date || null,
    cari_id: inv.relationships?.contact?.data?.id || null,
    cari_adi: '',
    net_tutar: parseFloat(inv.attributes.net_total) || 0,
    vergi_tutari: parseFloat(inv.attributes.total_vat) || 0,
    genel_toplam: parseFloat(inv.attributes.gross_total) || 0,
    doviz: inv.attributes.currency || 'TRL',
    durum: inv.attributes.payment_status || '',
    aciklama: inv.attributes.description || '',
    tip: 'giden',
    raw_data: inv.attributes,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return { giden_fatura: 0 };

  const { error } = await supabase
    .from('parasut_giden_fatura')
    .upsert(rows, { onConflict: 'parasut_id' });

  if (error) throw new Error(`Giden fatura hatası: ${error.message}`);
  console.log(`  ✅ ${rows.length} giden fatura sync edildi.`);
  return { giden_fatura: rows.length };
}

// ─── Sync: Gelen Fatura ───
async function syncGelenFatura(token, supabase) {
  console.log('🧾 Gelen faturalar sync ediliyor...');
  const bills = await apiGetAll(token, 'purchase_bills', { include: 'contact' });

  const rows = bills.map((inv) => ({
    parasut_id: inv.id,
    fatura_no: inv.attributes.invoice_no || '',
    tarih: inv.attributes.issue_date || null,
    vade_tarihi: inv.attributes.due_date || null,
    cari_id: inv.relationships?.contact?.data?.id || null,
    cari_adi: '',
    net_tutar: parseFloat(inv.attributes.net_total) || 0,
    vergi_tutari: parseFloat(inv.attributes.total_vat) || 0,
    genel_toplam: parseFloat(inv.attributes.gross_total) || 0,
    doviz: inv.attributes.currency || 'TRL',
    durum: inv.attributes.payment_status || '',
    aciklama: inv.attributes.description || '',
    tip: 'gelen',
    raw_data: inv.attributes,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return { gelen_fatura: 0 };

  const { error } = await supabase
    .from('parasut_gelen_fatura')
    .upsert(rows, { onConflict: 'parasut_id' });

  if (error) throw new Error(`Gelen fatura hatası: ${error.message}`);
  console.log(`  ✅ ${rows.length} gelen fatura sync edildi.`);
  return { gelen_fatura: rows.length };
}

// ─── Sync: Stok ───
async function syncStok(token, supabase) {
  console.log('📦 Stok sync ediliyor...');
  const products = await apiGetAll(token, 'products');

  const rows = products.map((p) => ({
    parasut_id: p.id,
    kod: p.attributes.code || '',
    ad: p.attributes.name || '',
    birim: p.attributes.unit || '',
    alis_fiyati: parseFloat(p.attributes.buying_price) || 0,
    satis_fiyati: parseFloat(p.attributes.list_price) || 0,
    stok_adedi: parseFloat(p.attributes.initial_stock_count) || 0,
    kdv_orani: parseFloat(p.attributes.vat_rate) || 0,
    aciklama: '',
    aktif: true,
    updated_at: new Date().toISOString(),
  }));

  if (rows.length === 0) return { stok: 0 };

  const { error } = await supabase
    .from('parasut_stok')
    .upsert(rows, { onConflict: 'parasut_id' });

  if (error) throw new Error(`Stok hatası: ${error.message}`);
  console.log(`  ✅ ${rows.length} ürün sync edildi.`);
  return { stok: rows.length };
}

// ─── Ana Handler ───
module.exports = async function handler(req, res) {
  const key = req.query.key || req.headers['x-sync-key'];
  const expected = process.env.SYNC_SECRET_KEY;
  if (expected && key !== expected) {
    return res.status(401).json({ error: 'Yetkisiz erişim' });
  }

  try {
    console.log('🔄 Parasüt sync başladı...');
    const start = Date.now();
    const supabase = getSupabase();
    const token = await getToken(supabase);

    const type = req.query.type || 'all';
    let results = {};

    if (type === 'all' || type === 'cariler') {
      results = { ...results, ...(await syncCariler(token, supabase)) };
    }
    if (type === 'all' || type === 'giden') {
      await sleep(1000);
      results = { ...results, ...(await syncGidenFatura(token, supabase)) };
    }
    if (type === 'all' || type === 'gelen') {
      await sleep(1000);
      results = { ...results, ...(await syncGelenFatura(token, supabase)) };
    }
    if (type === 'all' || type === 'stok') {
      await sleep(1000);
      results = { ...results, ...(await syncStok(token, supabase)) };
    }

    const sure = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Sync tamamlandı: ${sure}s`);

    return res.status(200).json({
      success: true,
      sure: `${sure}s`,
      sonuclar: results,
    });
  } catch (err) {
    console.error('❌ Sync hatası:', err.message);
    return res.status(500).json({
      success: false,
      hata: err.message,
    });
  }
};
