const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getAccessToken() {
  const { data: stored } = await supabase
    .from('parasut_tokens').select('*').eq('id', 1).single();

  if (stored && new Date(stored.expires_at) > new Date(Date.now() + 60000)) {
    return stored.access_token;
  }

  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: process.env.PARASUT_CLIENT_ID,
    client_secret: process.env.PARASUT_CLIENT_SECRET,
    username: process.env.PARASUT_EMAIL,
    password: process.env.PARASUT_PASSWORD,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
  });

  const res = await fetch('https://api.parasut.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Token hatasi: ' + err);
  }

  const tokens = await res.json();

  await supabase.from('parasut_tokens').upsert({
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });

  return tokens.access_token;
}

async function parasutGet(path, token) {
  const companyId = process.env.PARASUT_COMPANY_ID;
  const url = process.env.PARASUT_BASE_URL + '/' + companyId + path;
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Parasut API hatasi (' + path + '): ' + err);
  }
  return res.json();
}

async function parasutGetAll(path, token) {
  let allData = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await parasutGet(path + sep + 'page[size]=' + perPage + '&page[number]=' + page, token);
    if (!data.data || data.data.length === 0) break;
    allData = allData.concat(data.data);
    if (!data.meta || page >= Math.ceil(data.meta.total_count / perPage)) break;
    page++;
    if (page > 10) break;
  }
  return allData;
}

function mapGidenFatura(item) {
  const a = item.attributes || {};
  return {
    parasut_id: item.id,
    fatura_no: a.invoice_id || null,
    seri: a.invoice_series || null,
    tarih: a.issue_date || null,
    vade_tarihi: a.due_date || null,
    cari_id: (item.relationships && item.relationships.contact && item.relationships.contact.data) ? item.relationships.contact.data.id : null,
    net_tutar: parseFloat(a.net_total || 0),
    vergi_tutari: parseFloat(a.total_vat || 0),
    genel_toplam: parseFloat(a.gross_total || 0),
    doviz: a.currency || 'TRL',
    durum: a.payment_status || null,
    aciklama: a.description || null,
    tip: 'giden',
    raw_data: JSON.stringify(item),
    updated_at: new Date().toISOString(),
  };
}

function mapGelenFatura(item) {
  const a = item.attributes || {};
  return {
    parasut_id: item.id,
    fatura_no: a.invoice_no || null,
    tarih: a.issue_date || null,
    vade_tarihi: a.due_date || null,
    cari_id: (item.relationships && item.relationships.supplier && item.relationships.supplier.data) ? item.relationships.supplier.data.id : null,
    net_tutar: parseFloat(a.net_total || 0),
    vergi_tutari: parseFloat(a.total_vat || 0),
    genel_toplam: parseFloat(a.gross_total || 0),
    doviz: a.currency || 'TRL',
    durum: a.payment_status || null,
    aciklama: a.description || null,
    tip: 'gelen',
    raw_data: JSON.stringify(item),
    updated_at: new Date().toISOString(),
  };
}

function mapCari(item) {
  const a = item.attributes || {};
  return {
    parasut_id: item.id,
    ad: a.name || null,
    email: a.email || null,
    telefon: a.phone || null,
    adres: a.address || null,
    vergi_no: a.tax_number || null,
    vergi_dairesi: a.tax_office || null,
    tip: a.contact_type || null,
    alacak: parseFloat(a.balance || 0),
    updated_at: new Date().toISOString(),
  };
}

function mapStok(item) {
  const a = item.attributes || {};
  return {
    parasut_id: item.id,
    kod: a.code || null,
    ad: a.name || null,
    birim: a.unit || null,
    alis_fiyati: parseFloat(a.buying_price || 0),
    satis_fiyati: parseFloat(a.selling_price || 0),
    stok_adedi: parseFloat(a.initial_stock_count || 0),
    kdv_orani: parseFloat(a.vat_rate || 0),
    aciklama: a.description || null,
    aktif: !a.archived,
    updated_at: new Date().toISOString(),
  };
}

async function syncGidenFaturalar(token) {
  const data = await parasutGetAll('/sales_invoices', token);
  if (!data.length) return { adet: 0 };
  const mapped = data.map(mapGidenFatura);
  const { error } = await supabase.from('parasut_giden_fatura').upsert(mapped, { onConflict: 'parasut_id' });
  if (error) throw new Error('Giden fatura hatasi: ' + error.message);
  return { adet: mapped.length };
}

async function syncGelenFaturalar(token) {
  const data = await parasutGetAll('/purchase_invoices', token);
  if (!data.length) return { adet: 0 };
  const mapped = data.map(mapGelenFatura);
  const { error } = await supabase.from('parasut_gelen_fatura').upsert(mapped, { onConflict: 'parasut_id' });
  if (error) throw new Error('Gelen fatura hatasi: ' + error.message);
  return { adet: mapped.length };
}

async function syncCariler(token) {
  const data = await parasutGetAll('/contacts', token);
  if (!data.length) return { adet: 0 };
  const mapped = data.map(mapCari);
  const { error } = await supabase.from('parasut_cariler').upsert(mapped, { onConflict: 'parasut_id' });
  if (error) throw new Error('Cari hatasi: ' + error.message);
  return { adet: mapped.length };
}

async function syncStok(token) {
  const data = await parasutGetAll('/products', token);
  if (!data.length) return { adet: 0 };
  const mapped = data.map(mapStok);
  const { error } = await supabase.from('parasut_stok').upsert(mapped, { onConflict: 'parasut_id' });
  if (error) throw new Error('Stok hatasi: ' + error.message);
  return { adet: mapped.length };
}

module.exports = async function handler(req, res) {
  // GET: durum + test modu
  if (req.method === 'GET') {
    const test = req.query && req.query.test;

    // Test modu: ?test=cariler veya ?test=stok vs.
    if (test) {
      try {
        const token = await getAccessToken();
        let sonuc;
        if (test === 'cariler') sonuc = await syncCariler(token);
        else if (test === 'stok') sonuc = await syncStok(token);
        else if (test === 'giden') sonuc = await syncGidenFaturalar(token);
        else if (test === 'gelen') sonuc = await syncGelenFaturalar(token);
        else if (test === 'hepsi') {
          const t = await getAccessToken();
          sonuc = {
            cariler: await syncCariler(t),
            stok: await syncStok(t),
            giden_fatura: await syncGidenFaturalar(t),
            gelen_fatura: await syncGelenFaturalar(t),
          };
        }
        return res.status(200).json({ ok: true, test, sonuc });
      } catch (err) {
        return res.status(500).json({ ok: false, hata: err.message });
      }
    }

    // Normal durum kontrolu
    const tables = ['parasut_tokens','parasut_giden_fatura','parasut_gelen_fatura','parasut_cariler','parasut_stok'];
    const tablolar = {};
    for (const t of tables) {
      const { error } = await supabase.from(t).select('*').limit(1);
      tablolar[t] = error ? 'HATA: ' + error.message : 'OK';
    }
    return res.status(200).json({ ok: true, msg: 'Parasut Sync calisiyor', tablolar });
  }

  // POST: tam sync
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-cron-secret'] || (req.body && req.body.secret);
  if (secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Yetkisiz' });

  const sadece = req.body && req.body.sadece;
  const baslangic = Date.now();
  const sonuc = {};

  try {
    const token = await getAccessToken();
    const syncAll = !sadece;
    if (syncAll || sadece === 'giden_fatura') sonuc.giden_fatura = await syncGidenFaturalar(token);
    if (syncAll || sadece === 'gelen_fatura') sonuc.gelen_fatura = await syncGelenFaturalar(token);
    if (syncAll || sadece === 'cariler') sonuc.cariler = await syncCariler(token);
    if (syncAll || sadece === 'stok') sonuc.stok = await syncStok(token);
    const sure = ((Date.now() - baslangic) / 1000).toFixed(1);
    return res.status(200).json({ ok: true, sure_saniye: sure, sonuclar: sonuc });
  } catch (err) {
    return res.status(500).json({ ok: false, hata: err.message, sonuclar: sonuc });
  }
};
