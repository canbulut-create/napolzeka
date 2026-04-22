const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const DAILY_LIMIT = 50;
const MONTHLY_BUDGET_USD = 10;
const COST_PER_QUERY = 0.008;

// ==================== TELEGRAM ====================
async function send(chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    try {
      await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' }) });
    } catch (e) {
      await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk }) });
    }
  }
}

async function sendHtml(chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }) }).catch(() => {});
  }
}

async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, action: 'typing' }) }).catch(() => {});
}

// ==================== AUTH ====================
async function getOrCreateUser(tgUser) {
  try {
    const { data: existing } = await supabase.from('users').select('*').eq('telegram_id', tgUser.id).single();
    if (existing) return existing;
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim()));
    const isAdmin = adminIds.includes(tgUser.id);
    const { data: newUser } = await supabase.from('users').insert({
      telegram_id: tgUser.id, telegram_username: tgUser.username || null,
      full_name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(),
      role: isAdmin ? 'admin' : 'user',
      permissions: isAdmin ? ['stok','cari','fatura','cek','satis','rapor','admin'] : ['stok','cari']
    }).select().single();
    return newUser;
  } catch (e) { console.error('Auth error:', e); return null; }
}

// ==================== RATE LIMITING ====================
async function checkLimits(telegramId) {
  const today = new Date().toISOString().split('T')[0];
  const { count: dailyCount } = await supabase.from('query_logs').select('*', { count: 'exact', head: true })
    .eq('user_id', telegramId).gte('created_at', today + 'T00:00:00').lte('created_at', today + 'T23:59:59');
  if ((dailyCount || 0) >= DAILY_LIMIT) return { ok: false, msg: `⚠️ Günlük soru limitinize ulaştınız (${DAILY_LIMIT}). Yarın tekrar deneyebilirsiniz.` };
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01T00:00:00`;
  const { count: monthCount } = await supabase.from('query_logs').select('*', { count: 'exact', head: true })
    .gte('created_at', monthStart).not('query_type', 'in', '("start","help")');
  if ((monthCount || 0) * COST_PER_QUERY >= MONTHLY_BUDGET_USD) return { ok: false, msg: `⚠️ Aylık API bütçesi doldu ($${MONTHLY_BUDGET_USD}).` };
  return { ok: true, daily: dailyCount || 0, monthly: ((monthCount || 0) * COST_PER_QUERY).toFixed(2) };
}

async function logQuery(telegramId, queryType, queryText, responseText) {
  try {
    await supabase.from('query_logs').insert({ user_id: telegramId, query_type: queryType, query_text: queryText, response_text: responseText ? responseText.substring(0, 2000) : null });
  } catch(e) {}
}

// ==================== AGENT TOOLS ====================
const AGENT_TOOLS = [
  { name: "cari_sorgula", description: "Cari hesap/firma sorgulama. Bakiye NEGATİF = biz o firmaya borçluyuz, POZİTİF = firma bize borçlu.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" }, siralama: { type: "string" } }, required: ["arama"] } },
  { name: "stok_sorgula", description: "Depo stok sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "fatura_sorgula", description: "Fatura sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, tur: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "cek_sorgula", description: "Çek ve senet sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "satis_karlilik_sorgula", description: "Satış karlılık analizi.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "bilgi_sorgula", description: "Şirket bilgi tabanını sorgula.", input_schema: { type: "object", properties: { arama: { type: "string" } }, required: ["arama"] } },
  { name: "urun_karlilik_sorgula", description: "Ürün bazlı karlılık analizi.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "bilgi_ekle", description: "Bilgi tabanına yeni bilgi ekle.", input_schema: { type: "object", properties: { kategori: { type: "string" }, baslik: { type: "string" }, icerik: { type: "string" } }, required: ["kategori", "icerik"] } },
  { name: "vergi_hesapla", description: "Vergi hesaplama ve takvim sorgulama.", input_schema: { type: "object", properties: { islem: { type: "string" }, ay: { type: "number" }, yil: { type: "number" } }, required: ["islem"] } }
];

// ==================== TOOL EXECUTORS ====================
async function executeTool(toolName, input) {
  try {
    switch (toolName) {
      case 'cari_sorgula': return await execCari(input);
      case 'stok_sorgula': return await execStok(input);
      case 'fatura_sorgula': return await execFatura(input);
      case 'cek_sorgula': return await execCek(input);
      case 'satis_karlilik_sorgula': return await execSatis(input);
      case 'bilgi_sorgula': return await execBilgiSorgula(input);
      case 'bilgi_ekle': return await execBilgiEkle(input);
      case 'urun_karlilik_sorgula': return await execUrunKarlilik(input);
      case 'vergi_hesapla': return await execVergi(input);
      default: return JSON.stringify({ error: 'Bilinmeyen araç' });
    }
  } catch (e) { console.error(`Tool error ${toolName}:`, e); return JSON.stringify({ error: e.message }); }
}

async function execCari({ arama, limit = 10, siralama }) {
  let data;
  const a = arama.toLowerCase();
  if (a === 'en_borclu' || a.includes('en borçlu') || a.includes('borçlu olduğumuz')) {
    ({ data } = await supabase.from('accounts').select('*').lt('bakiye', 0).order('bakiye', { ascending: true }).limit(limit));
    if (data) data = data.map(r => ({ ...r, _aciklama: 'BİZ BU FİRMAYA BORÇLUYUZ (bakiye negatif = tedarikçi)' }));
  } else if (a === 'en_alacakli' || a.includes('bize borçlu') || a.includes('en alacak') || a.includes('alacaklı')) {
    ({ data } = await supabase.from('accounts').select('*').gt('bakiye', 0).order('bakiye', { ascending: false }).limit(limit));
    if (data) data = data.map(r => ({ ...r, _aciklama: 'BU FİRMA BİZE BORÇLU (bakiye pozitif = müşteri)' }));
  } else if (a === 'ozet' || a === 'genel' || a === 'toplam') {
    const { data: borclu } = await supabase.from('accounts').select('bakiye').lt('bakiye', 0);
    const { data: alacakli } = await supabase.from('accounts').select('bakiye').gt('bakiye', 0);
    const { count } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
    const toplamBorc = borclu ? borclu.reduce((s, r) => s + Number(r.bakiye), 0) : 0;
    const toplamAlacak = alacakli ? alacakli.reduce((s, r) => s + Number(r.bakiye), 0) : 0;
    return JSON.stringify({ toplam_cari: count, biz_borcluyuz_firma_sayisi: borclu?.length || 0, biz_borcluyuz_toplam_tl: toplamBorc, bize_borclu_firma_sayisi: alacakli?.length || 0, bize_borclu_toplam_tl: toplamAlacak, net_pozisyon_tl: toplamBorc + toplamAlacak });
  } else if (a === 'hepsi') {
    ({ data } = await supabase.from('accounts').select('*').neq('bakiye', 0).order('bakiye', { ascending: true }).limit(limit));
  } else {
    ({ data } = await supabase.from('accounts').select('*').or(`unvan.ilike.%${arama}%,cari_kodu.ilike.%${arama}%,aciklama.ilike.%${arama}%`).limit(limit));
    if (!data || data.length === 0) {
      const words = arama.split(/\s+/).filter(w => w.length > 2);
      for (const word of words) {
        ({ data } = await supabase.from('accounts').select('*').or(`unvan.ilike.%${word}%,aciklama.ilike.%${word}%`).limit(limit));
        if (data && data.length > 0) break;
      }
    }
    if (data) data = data.map(r => ({ ...r, _aciklama: Number(r.bakiye) < 0 ? 'BİZ BU FİRMAYA BORÇLUYUZ' : Number(r.bakiye) > 0 ? 'BU FİRMA BİZE BORÇLU' : 'BAKİYE DENK' }));
  }
  return JSON.stringify(data || []);
}

async function execStok({ arama, limit = 20 }) {
  let data;
  const a = arama.toLowerCase();
  if (a === 'hepsi' || a === 'listele') {
    ({ data } = await supabase.from('stock').select('*').order('fiili_stok', { ascending: false }).limit(limit));
  } else if (a === 'stokta_olan') {
    ({ data } = await supabase.from('stock').select('*').gt('fiili_stok', 0).order('fiili_stok', { ascending: false }).limit(limit));
  } else {
    ({ data } = await supabase.from('stock').select('*').or(`aciklama.ilike.%${arama}%,kart_kodu.ilike.%${arama}%,grup_kodu.ilike.%${arama}%`).limit(limit));
    if (!data || data.length === 0) {
      const words = arama.split(/\s+/).filter(w => w.length > 1);
      for (const word of words) {
        ({ data } = await supabase.from('stock').select('*').ilike('aciklama', `%${word}%`).limit(limit));
        if (data && data.length > 0) break;
      }
    }
  }
  return JSON.stringify(data || []);
}

async function execFatura({ arama, tur, limit = 15 }) {
  let data;
  const a = arama.toLowerCase();
  if (a === 'son_faturalar' || a === 'son') {
    let q = supabase.from('invoices').select('*').order('tarih', { ascending: false }).limit(limit);
    if (tur && tur !== 'hepsi') q = q.eq('fatura_turu', tur);
    ({ data } = await q);
  } else if (a === 'bu_ay') {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    ({ data } = await supabase.from('invoices').select('*').gte('tarih', monthStart).order('tarih', { ascending: false }).limit(limit));
  } else {
    ({ data } = await supabase.from('invoices').select('*').or(`cari_firma.ilike.%${arama}%,fatura_no.ilike.%${arama}%`).order('tarih', { ascending: false }).limit(limit));
  }
  return JSON.stringify(data || []);
}

async function execCek({ arama, limit = 15 }) {
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  let data;
  const a = arama.toLowerCase();
  if (a === 'vadesi_yaklasan' || a === 'bu_hafta') {
    ({ data } = await supabase.from('checks').select('*').gte('vade', today).lte('vade', nextWeek).order('vade', { ascending: true }));
    if (!data || data.length === 0) ({ data } = await supabase.from('checks').select('*').gte('vade', today).lte('vade', nextMonth).order('vade', { ascending: true }).limit(limit));
  } else if (a === 'bugun') {
    ({ data } = await supabase.from('checks').select('*').eq('vade', today));
  } else if (a === 'gecikmis') {
    ({ data } = await supabase.from('checks').select('*').lt('vade', today).eq('durum_aciklama', 'Portföyde').order('vade', { ascending: true }));
  } else if (a === 'portfoy_ozet' || a === 'ozet') {
    const { data: all } = await supabase.from('checks').select('*');
    if (all) {
      const portfoy = all.filter(r => r.durum_aciklama === 'Portföyde');
      const tahsil = all.filter(r => r.durum_aciklama && r.durum_aciklama.includes('Tahsil'));
      const teminat = all.filter(r => r.durum_aciklama && r.durum_aciklama.includes('Teminat'));
      return JSON.stringify({ toplam_cek: all.length, portfoyde: { adet: portfoy.length, toplam_tl: portfoy.reduce((s,r) => s + Number(r.tutar||0), 0) }, tahsilde: { adet: tahsil.length, toplam_tl: tahsil.reduce((s,r) => s + Number(r.tutar||0), 0) }, teminatta: { adet: teminat.length, toplam_tl: teminat.reduce((s,r) => s + Number(r.tutar||0), 0) }, vadesi_yakin_5: portfoy.filter(r => r.vade >= today).sort((a,b) => a.vade > b.vade ? 1 : -1).slice(0,5) });
    }
    return '[]';
  } else {
    ({ data } = await supabase.from('checks').select('*').or(`borclu.ilike.%${arama}%,cari_hesap.ilike.%${arama}%,seri_no.ilike.%${arama}%`).order('vade', { ascending: true }).limit(limit));
  }
  return JSON.stringify(data || []);
}

async function execSatis({ arama, limit = 10 }) {
  const { data: allSales } = await supabase.from('sales').select('*').eq('satir_tipi', 'fatura');
  if (!allSales) return '[]';
  const firmalar = {};
  for (const r of allSales) {
    const firma = r.cari_unvan || 'Bilinmeyen';
    if (!firmalar[firma]) firmalar[firma] = { firma, toplam: 0, maliyet: 0, kar: 0, fatura_sayisi: 0 };
    firmalar[firma].toplam += Number(r.toplam_tutar || 0);
    firmalar[firma].maliyet += Number(r.maliyet || 0);
    firmalar[firma].kar += Number(r.kar_toplam || 0);
    firmalar[firma].fatura_sayisi += 1;
  }
  const firmaList = Object.values(firmalar).map(f => ({ ...f, kar_orani_satis: f.toplam > 0 ? (f.kar / f.toplam * 100).toFixed(1) + '%' : '0%' }));
  const a = arama.toLowerCase();
  if (a === 'en_karli') return JSON.stringify(firmaList.sort((a,b) => b.kar - a.kar).slice(0, limit));
  if (a === 'en_dusuk_karli') return JSON.stringify(firmaList.filter(f => f.toplam > 0).sort((a,b) => (a.kar/a.toplam) - (b.kar/b.toplam)).slice(0, limit));
  if (a === 'ozet' || a === 'genel') {
    const toplamKar = firmaList.reduce((s,f) => s + f.kar, 0);
    const toplamSatis = firmaList.reduce((s,f) => s + f.toplam, 0);
    const toplamMaliyet = firmaList.reduce((s,f) => s + f.maliyet, 0);
    return JSON.stringify({ toplam_firma: firmaList.length, toplam_fatura: allSales.length, toplam_satis_tl: toplamSatis, toplam_maliyet_tl: toplamMaliyet, toplam_kar_tl: toplamKar, ortalama_kar_orani: toplamSatis > 0 ? (toplamKar/toplamSatis*100).toFixed(1)+'%' : '0%', en_karli_5: firmaList.sort((a,b) => b.kar - a.kar).slice(0,5).map(f => ({ firma: f.firma, kar: f.kar, oran: f.kar_orani_satis })) });
  }
  const matched = firmaList.filter(f => f.firma.toLowerCase().includes(a));
  if (matched.length > 0) {
    const { data: detay } = await supabase.from('sales').select('*').eq('satir_tipi', 'fatura').ilike('cari_unvan', `%${arama}%`).order('tarih', { ascending: false });
    return JSON.stringify({ firma_toplam: matched[0], fatura_detay: detay || [] });
  }
  return JSON.stringify(firmaList.sort((a,b) => b.kar - a.kar).slice(0, limit));
}

async function execVergi({ islem, ay, yil }) {
  const now = new Date();
  const currentYear = yil || now.getFullYear();
  if (islem === 'kdv_hesapla') {
    const targetMonth = ay || (now.getMonth() === 0 ? 12 : now.getMonth());
    const targetYear = ay ? currentYear : (now.getMonth() === 0 ? currentYear - 1 : currentYear);
    const monthStart = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
    const nextMonth = targetMonth === 12 ? `${targetYear + 1}-01-01` : `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-01`;
    const ayIsimleri = ['', 'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
    const { data } = await supabase.from('invoices').select('fatura_turu, toplam_tl, genel_toplam_tl').gte('tarih', monthStart).lt('tarih', nextMonth);
    if (!data || data.length === 0) return JSON.stringify({ ay: ayIsimleri[targetMonth], yil: targetYear, mesaj: 'Bu ay için fatura verisi bulunamadı.' });
    let satis_kdv = 0, alis_kdv = 0, satis_tutar = 0, alis_tutar = 0, satis_adet = 0, alis_adet = 0;
    for (const r of data) {
      const kdv = Number(r.genel_toplam_tl || 0) - Number(r.toplam_tl || 0);
      const tur = (r.fatura_turu || '').toLowerCase();
      if (tur.includes('satış') || tur.includes('fiyat farkı verilen')) { satis_kdv += kdv; satis_tutar += Number(r.genel_toplam_tl || 0); satis_adet++; }
      else { alis_kdv += kdv; alis_tutar += Number(r.genel_toplam_tl || 0); alis_adet++; }
    }
    const odenecek = satis_kdv - alis_kdv;
    const odeme_ay = targetMonth === 12 ? 1 : targetMonth + 1;
    const odeme_yil = targetMonth === 12 ? targetYear + 1 : targetYear;
    return JSON.stringify({ donem: `${ayIsimleri[targetMonth]} ${targetYear}`, satis: { adet: satis_adet, tutar_tl: satis_tutar.toFixed(2), kdv_tl: satis_kdv.toFixed(2) }, alis: { adet: alis_adet, tutar_tl: alis_tutar.toFixed(2), kdv_tl: alis_kdv.toFixed(2) }, odenecek_kdv_tl: odenecek.toFixed(2), odeme_tarihi: `${odeme_yil}-${String(odeme_ay).padStart(2, '0')}-28` });
  }
  if (islem === 'yaklasan_vergiler') {
    const today = now.toISOString().split('T')[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    const yaklasan = [];
    for (const v of [{ ad: 'Muhtasar ve SGK', gun: 26 }, { ad: 'Damga Vergisi', gun: 26 }, { ad: 'KDV', gun: 28 }]) {
      if (v.gun >= currentDay) { const tarih = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(v.gun).padStart(2, '0')}`; yaklasan.push({ vergi: v.ad, tarih, kalan_gun: Math.ceil((new Date(tarih) - now) / 86400000) }); }
    }
    const { data: ozelVergiler } = await supabase.from('tax_calendar').select('*').in('kategori', ['ucaylik', 'yillik', 'diger']).eq('aktif', true);
    if (ozelVergiler) for (const v of ozelVergiler) { if (v.donem && v.donem >= today && v.donem <= next30) yaklasan.push({ vergi: v.vergi_adi, tarih: v.donem, kalan_gun: Math.ceil((new Date(v.donem) - now) / 86400000) }); }
    return JSON.stringify({ bugun: today, yaklasan_vergiler: yaklasan.sort((a, b) => a.kalan_gun - b.kalan_gun) });
  }
  if (islem === 'takvim') { const { data } = await supabase.from('tax_calendar').select('*').eq('aktif', true).order('kategori'); return JSON.stringify(data || []); }
  return JSON.stringify({ hata: 'Geçersiz işlem.' });
}

async function execUrunKarlilik({ arama, limit = 10 }) {
  const a = arama.toLowerCase();
  let data;
  if (a === 'en_karli') { ({ data } = await supabase.from('product_profitability').select('*').order('kar_zarar', { ascending: false }).limit(limit)); }
  else if (a === 'en_cok_satan') { ({ data } = await supabase.from('product_profitability').select('*').order('miktar', { ascending: false }).limit(limit)); }
  else if (a === 'ozet' || a === 'genel') {
    const { data: all } = await supabase.from('product_profitability').select('*');
    if (all) { const topSatis = all.reduce((s, r) => s + Number(r.satis_tutari || 0), 0); const topKar = all.reduce((s, r) => s + Number(r.kar_zarar || 0), 0); return JSON.stringify({ toplam_urun: all.length, toplam_satis_tl: topSatis, toplam_kar_tl: topKar, ortalama_kar_orani: topSatis > 0 ? (topKar / topSatis * 100).toFixed(1) + '%' : '0%', en_karli_5: all.sort((a, b) => Number(b.kar_zarar) - Number(a.kar_zarar)).slice(0, 5).map(r => ({ urun: r.stok_adi, kar: r.kar_zarar })) }); }
    return '[]';
  } else if (a === 'hepsi') { ({ data } = await supabase.from('product_profitability').select('*').order('kar_zarar', { ascending: false }).limit(limit)); }
  else {
    ({ data } = await supabase.from('product_profitability').select('*').or(`stok_adi.ilike.%${arama}%,stok_kodu.ilike.%${arama}%`).limit(limit));
    if (!data || data.length === 0) { const words = arama.split(/\s+/).filter(w => w.length > 2); for (const word of words) { ({ data } = await supabase.from('product_profitability').select('*').ilike('stok_adi', `%${word}%`).limit(limit)); if (data && data.length > 0) break; } }
  }
  return JSON.stringify(data || []);
}

async function execBilgiSorgula({ arama }) {
  const { data } = await supabase.from('knowledge').select('*').or(`content.ilike.%${arama}%,title.ilike.%${arama}%,category.ilike.%${arama}%`).limit(10);
  if (!data || data.length === 0) { const words = arama.split(/\s+/).filter(w => w.length > 2); for (const word of words) { const { data: d } = await supabase.from('knowledge').select('*').ilike('content', `%${word}%`).limit(10); if (d && d.length > 0) return JSON.stringify(d); } return JSON.stringify({ sonuc: 'Bilgi bulunamadı.' }); }
  return JSON.stringify(data);
}

async function execBilgiEkle({ kategori, baslik, icerik }) {
  const { data, error } = await supabase.from('knowledge').insert({ category: kategori, title: baslik || null, content: icerik }).select().single();
  if (error) return JSON.stringify({ hata: error.message });
  return JSON.stringify({ basarili: true, id: data.id });
}

// ==================== KARLILIK RAPORU ====================
const DIA_URL_K = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const SATIS_TURLERI = ['Toptan Satış', 'Perakende Satış', 'Verilen Hizmet'];
const IADE_TURLERI  = ['Toptan Satış İade', 'Perakende Satış İade', 'Alınan Fiyat Farkı', 'Verilen Fiyat Farkı'];
const GIDER_TURLERI = ['Alınan Hizmet', 'Mal Alım'];
const AY_ADLARI = ['','Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];

async function diaCallK(endpoint, body) {
  const res = await fetch(`${DIA_URL_K}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (String(data.code) !== '200') throw new Error(`DIA hata: ${data.msg || data.code}`);
  return data;
}

async function diaLoginK() {
  const data = await diaCallK('sis/json', { login: { username: process.env.DIA_USERNAME, password: process.env.DIA_PASSWORD, disconnect_same_user: true, lang: 'tr', params: { apikey: process.env.DIA_API_KEY } } });
  return data.msg;
}

function formatPara(n) { return Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

async function karlilikRaporuCek(chatId, ayParam) {
  await sendHtml(chatId, '⏳ Karlılık raporu hazırlanıyor...');
  const sessionId = await diaLoginK();
  const simdi = new Date();
  const yil = simdi.getFullYear();
  const ayNo = ayParam ? ayParam.padStart(2, '0') : String(simdi.getMonth() + 1).padStart(2, '0');
  const basTar = `${yil}-${ayNo}-01`;
  const bitTar = new Date(yil, parseInt(ayNo), 0).toLocaleDateString('sv-SE');

  const res = await diaCallK('rpr/json', { rpr_raporsonuc_getir: {
    session_id: sessionId, firma_kodu: parseInt(process.env.DIA_FIRMA || '2'), donem_kodu: parseInt(process.env.DIA_DONEM || '3'),
    filters: '', sorts: '',
    params: { tasarim_key: parseInt(process.env.DIA_TASARIM || '807'), fistarihi1: basTar, fistarihi2: bitTar,
      maliyethesaplamayontemi: 'Sadece Maliyet', _key_sis_depo: parseInt(process.env.DIA_DEPO || '2987'),
      perakende_satis: true, toptan_satis: true, alinan_fiyat_farki: true, verilen_fiyat_farki: true,
      verilen_hizmet: true, perakende_iade: true, toptan_iade: true, mal_alim: true, alinan_hizmet: true },
    limit: 5000, offset: 0
  }});

  let rows = [];
  if (res.result) { const decoded = Buffer.from(res.result, 'base64').toString('utf-8'); const data = JSON.parse(decoded); rows = data.__rows || data.rows || []; }

  let toplamCiro = 0, toplamMaliyet = 0, toplamKar = 0;
  const sifirMaliyetUyari = [], cariMap = {};

  for (const row of rows) {
    const turu = row.turuaciklama || '';
    const fisNo = row.belgeno2 || row.fisno || '';
    const tutar = parseFloat(row.toplamFaturaTutari || 0);
    const maliyet = parseFloat(row.toplamFaturaMaliyeti || 0);
    const cariAdi = (row.carifirma || '').substring(0, 30);

    if (GIDER_TURLERI.includes(turu)) { toplamMaliyet += tutar; continue; }
    if (SATIS_TURLERI.includes(turu)) {
      if (maliyet === 0) sifirMaliyetUyari.push(`${fisNo} - ${cariAdi}`);
      toplamCiro += tutar; toplamMaliyet += maliyet; toplamKar += (tutar - maliyet);
      if (cariAdi) { if (!cariMap[cariAdi]) cariMap[cariAdi] = { ciro: 0, kar: 0 }; cariMap[cariAdi].ciro += tutar; cariMap[cariAdi].kar += (tutar - maliyet); }
    } else { toplamCiro -= tutar; toplamMaliyet -= maliyet; toplamKar -= (tutar - maliyet); }
  }

  const top5 = Object.entries(cariMap).sort((a, b) => b[1].kar - a[1].kar).slice(0, 5);
  const marj = toplamCiro > 0 ? ((toplamKar / toplamCiro) * 100).toFixed(1) : '0.0';

  let msg = `📈 <b>Karlılık Raporu — ${AY_ADLARI[parseInt(ayNo)]} ${yil}</b>\n<i>${basTar} → ${bitTar}</i>\n\n`;
  msg += `💰 <b>Ciro:</b> ${formatPara(toplamCiro)} ₺\n📦 <b>Maliyet:</b> ${formatPara(toplamMaliyet)} ₺\n✅ <b>Kar:</b> ${formatPara(toplamKar)} ₺ (%${marj})\n`;
  if (top5.length > 0) {
    msg += `\n🏆 <b>En Karlı 5 Cari:</b>\n`;
    for (const [ad, v] of top5) { const cMarj = v.ciro > 0 ? ((v.kar / v.ciro) * 100).toFixed(0) : 0; msg += `  • ${ad}: ${formatPara(v.kar)} ₺ (%${cMarj})\n`; }
  }
  if (sifirMaliyetUyari.length > 0) {
    msg += `\n⚠️ <b>Maliyetsiz Satış (${sifirMaliyetUyari.length} fatura):</b>\n`;
    for (const u of sifirMaliyetUyari.slice(0, 5)) msg += `  • ${u}\n`;
    if (sifirMaliyetUyari.length > 5) msg += `  ... ve ${sifirMaliyetUyari.length - 5} fatura daha\n`;
  }
  await sendHtml(chatId, msg);
}

// ==================== MORNING REPORT ====================
function fmtMoney(n) { return Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

async function generateMorningReport() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  let r = `🌅 *GÜNLÜK RAPOR — ${today}*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  const { data: bugun } = await supabase.from('checks').select('*').eq('vade', today).order('tutar',{ascending:false});
  if (bugun?.length > 0) { r += `🔴 *BUGÜN VADESİ DOLAN (${bugun.length} adet — ${fmtMoney(bugun.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`; bugun.forEach((c,i) => { r += `${i+1}. ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz} | ${c.durum_aciklama||''}\n`; }); r += '\n'; }
  else r += '✅ Bugün vadesi dolan çek yok.\n\n';
  const { data: yarin } = await supabase.from('checks').select('*').eq('vade', tomorrow).order('tutar',{ascending:false});
  if (yarin?.length > 0) { r += `⚠️ *YARIN (${yarin.length} adet — ${fmtMoney(yarin.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`; yarin.forEach((c,i) => { r += `${i+1}. ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz}\n`; }); r += '\n'; }
  const { data: hafta } = await supabase.from('checks').select('*').gte('vade', today).lte('vade', next7);
  if (hafta?.length > 0) r += `📊 *7 GÜNLÜK TOPLAM: ${fmtMoney(hafta.reduce((s,c)=>s+(c.tutar||0),0))} TL (${hafta.length} çek)*\n\n`;
  const { data: gecik } = await supabase.from('checks').select('*').lt('vade', today).eq('durum_aciklama', 'Portföyde').order('vade',{ascending:true});
  if (gecik?.length > 0) { r += `🚨 *GECİKMİŞ (${gecik.length} adet — ${fmtMoney(gecik.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`; gecik.slice(0,5).forEach((c,i) => { r += `${i+1}. ${c.vade} | ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz}\n`; }); if (gecik.length > 5) r += ` ... ve ${gecik.length-5} çek daha\n`; r += '\n'; }
  r += `━━━━━━━━━━━━━━━━━━━━━━\n_OpenClaw Agent — Napol Global_`;
  return r;
}

// ==================== AGENT CORE ====================
const SYSTEM_PROMPT = `Sen OpenClaw, Napol Global şirketinin AI agent asistanısın. Napol Global; silikonlu kağıt, silikonlu film ve medikal ambalaj kağıtları üretim/ticareti yapan bir şirket.
KRİTİK KURALLAR — BORÇ/ALACAL:
- Veritabanındaki bakiye sütunu: NEGATİF = BİZ O FİRMAYA BORÇLUYUZ (tedarikçilerimiz)
- Veritabanındaki bakiye sütunu: POZİTİF = O FİRMA BİZE BORÇLU (müşterilerimiz)
GENEL KURALLAR:
- Türkçe cevap ver. Kısa, net ve profesyonel ol.
- Sayıları Türk formatında göster: 1.234.567,89 TL
- Kar oranını her zaman Kar/Satış Tutarı olarak hesapla
- KDV hesabı yapılacaksa mutlaka hangi ay için olduğunu kullanıcıya sor
- Asla uydurma veri verme
- Emoji kullan: 🔴 borç, 💰 alacak, ✅ denk, 📦 stok, 📄 fatura, 📅 çek, 📊 karlılık
Bugünün tarihi: ${new Date().toISOString().split('T')[0]}`;

async function runAgent(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];
  let response = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: SYSTEM_PROMPT, tools: AGENT_TOOLS, messages });
  let maxLoops = 5;
  while (response.stop_reason === 'tool_use' && maxLoops > 0) {
    maxLoops--;
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') { console.log(`Agent tool: ${block.name}`); const result = await executeTool(block.name, block.input); toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result }); }
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
    response = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, system: SYSTEM_PROMPT, tools: AGENT_TOOLS, messages });
  }
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Cevap oluşturulamadı.';
}

// ==================== MAIN WEBHOOK ====================
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, msg: 'OpenClaw Agent running' });
  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (isGroup && !text.startsWith('/') && !text.toLowerCase().includes('@')) return res.status(200).json({ ok: true });
    const cleanText = text.replace(/@\w+/g, '').replace(/^\/\w+\s*/, '').trim();
    const command = text.split(' ')[0].split('@')[0].toLowerCase();
    const user = await getOrCreateUser(msg.from);
    if (!user || !user.is_active) { await send(chatId, '🚫 Erişim yetkiniz yok.'); return res.status(200).json({ ok: true }); }

    // ---- Limitsiz komutlar ----
    if (command === '/start') {
      await send(chatId, `🤖 Merhaba ${user.full_name}!\n\nBen *OpenClaw Agent*, Napol Global şirket asistanıyım.\n\n📋 /rapor — Günlük rapor\n📈 /karlilik — Bu ayın karlılık raporu\n📋 /limit — Limit durumu\n📝 /ogren — Bilgi ekle\n❓ /yardim — Yardım`);
      await logQuery(msg.from.id, 'start', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/yardim' || command === '/help') {
      await send(chatId, `📋 *OpenClaw Agent Rehberi*\n\nDoğal dilde soru sorun:\n🏢 Cari, 📦 Stok, 📄 Fatura, 📅 Çek, 📊 Karlılık\n\n📈 /karlilik — Bu ay karlılık\n📈 /karlilik 03 — Mart ayı karlılık\n📋 /rapor — Günlük rapor\n📝 /ogren [bilgi] — Bilgi ekle`);
      await logQuery(msg.from.id, 'help', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/limit') {
      const l = await checkLimits(msg.from.id);
      await send(chatId, `📋 *Limit Durumu*\n👤 Günlük: ${l.daily || 0}/${DAILY_LIMIT}\n💰 Aylık: ~$${l.monthly || 0} / $${MONTHLY_BUDGET_USD}`);
      return res.status(200).json({ ok: true });
    }

    // ---- Admin komutları ----
    if (command === '/rapor') {
      if (user.role !== 'admin') { await send(chatId, '🚫 Bu komut sadece yöneticiler içindir.'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const report = await generateMorningReport();
      await send(chatId, report);
      await logQuery(msg.from.id, 'rapor', text, 'Günlük rapor');
      return res.status(200).json({ ok: true });
    }

    // ---- YENİ: Karlılık raporu komutu ----
    if (command === '/karlilik') {
      if (user.role !== 'admin') { await send(chatId, '🚫 Bu komut sadece yöneticiler içindir.'); return res.status(200).json({ ok: true }); }
      const ayParam = text.split(' ')[1] || null; // /karlilik 04 → '04'
      try {
        await karlilikRaporuCek(chatId, ayParam);
      } catch (err) {
        console.error('Karlılık raporu hata:', err);
        await sendHtml(chatId, `❌ Karlılık raporu hatası: ${err.message}`);
      }
      await logQuery(msg.from.id, 'karlilik', text, 'Karlılık raporu');
      return res.status(200).json({ ok: true });
    }

    if (command === '/ogren') {
      if (!cleanText) { await send(chatId, '📝 Kullanım: /ogren [bilgi]'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const result = await runAgent(`Kullanıcı şu bilgiyi eklemek istiyor: "${cleanText}". Uygun kategori belirle ve bilgi_ekle aracını kullan.`);
      await send(chatId, result);
      await logQuery(msg.from.id, 'ogren', text, result);
      return res.status(200).json({ ok: true });
    }

    // ---- Limit kontrol ----
    const limitCheck = await checkLimits(msg.from.id);
    if (!limitCheck.ok) { await send(chatId, limitCheck.msg); return res.status(200).json({ ok: true }); }

    // ---- AGENT ----
    await typing(chatId);
    const agentResponse = await runAgent(cleanText || text);
    await send(chatId, agentResponse);
    await logQuery(msg.from.id, 'agent', text, agentResponse);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: true });
  }
};
