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
      await fetch(`${TG}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
      });
    } catch (e) {
      await fetch(`${TG}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
    }
  }
}
async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }) }).catch(() => {});
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
  try { await supabase.from('query_logs').insert({ user_id: telegramId, query_type: queryType,
    query_text: queryText, response_text: responseText ? responseText.substring(0, 2000) : null }); } catch(e) {}
}

// ==================== AGENT TOOLS ====================
const AGENT_TOOLS = [
  {
    name: "cari_sorgula",
    description: "Cari hesap/firma sorgulama. Firma adı, cari kodu ile arama yapar. Bakiye, borç/alacak durumu, iletişim bilgisi döner. Genel sorgular için filter boş bırakılabilir (en borçlu, toplam bakiye vs.)",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Firma adı, cari kodu veya 'hepsi' / 'en_borclu' / 'en_alacakli' / 'ozet' gibi genel komutlar" },
        limit: { type: "number", description: "Kaç sonuç dönsün (varsayılan 10)" },
        siralama: { type: "string", description: "bakiye_artan, bakiye_azalan, unvan" }
      },
      required: ["arama"]
    }
  },
  {
    name: "stok_sorgula",
    description: "Depo stok sorgulama. Ürün adı, ürün kodu, grup kodu ile arama yapar. Fiili stok, gerçek stok, birim maliyet döner.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Ürün adı, kart kodu veya 'hepsi' / 'stokta_olan'" },
        limit: { type: "number", description: "Kaç sonuç" }
      },
      required: ["arama"]
    }
  },
  {
    name: "fatura_sorgula",
    description: "Fatura sorgulama. Firma adı, fatura no, tarih aralığı ile arama. Satış ve alış faturaları.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Firma adı, fatura no veya 'son_faturalar' / 'bu_ay'" },
        tur: { type: "string", description: "Toptan Satış, Alınan Hizmet, hepsi" },
        limit: { type: "number", description: "Kaç sonuç" }
      },
      required: ["arama"]
    }
  },
  {
    name: "cek_sorgula",
    description: "Çek ve senet sorgulama. Borçlu adı, vade tarihi, durum ile arama. Portföy özeti, vadesi yaklaşanlar, gecikmiş çekler.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Borçlu adı, seri no veya 'vadesi_yaklasan' / 'bugun' / 'bu_hafta' / 'gecikmis' / 'portfoy_ozet'" },
        limit: { type: "number", description: "Kaç sonuç" }
      },
      required: ["arama"]
    }
  },
  {
    name: "satis_karlilik_sorgula",
    description: "Satış karlılık analizi. Firma bazlı toplam satış, maliyet, kar, kar oranı. En karlı firmalar, firma detayı.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Firma adı veya 'en_karli' / 'en_dusuk_karli' / 'ozet' / 'hepsi'" },
        limit: { type: "number", description: "Kaç sonuç" }
      },
      required: ["arama"]
    }
  },
  {
    name: "bilgi_sorgula",
    description: "Şirket bilgi tabanını sorgula. Ürün bilgileri, firma notları, sektör bilgisi, şirket kuralları gibi öğretilmiş bilgiler.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Aranacak konu veya kelime" }
      },
      required: ["arama"]
    }
  },
  {
    name: "urun_karlilik_sorgula",
    description: "Ürün bazlı karlılık analizi. Stok kodu veya ürün adıyla arama. Birim fiyat, birim maliyet, toplam satış, toplam maliyet, kar ve kar oranı. En karlı ürünler, ürün detayı.",
    input_schema: {
      type: "object",
      properties: {
        arama: { type: "string", description: "Ürün adı, stok kodu veya 'en_karli' / 'en_cok_satan' / 'ozet' / 'hepsi'" },
        limit: { type: "number", description: "Kaç sonuç" }
      },
      required: ["arama"]
    }
  },
  {
    name: "bilgi_ekle",
    description: "Bilgi tabanına yeni bilgi ekle. Ürün bilgisi, firma notu, sektör bilgisi vs.",
    input_schema: {
      type: "object",
      properties: {
        kategori: { type: "string", description: "urun, firma, sektor, kural, genel" },
        baslik: { type: "string", description: "Kısa başlık" },
        icerik: { type: "string", description: "Eklenecek bilgi" }
      },
      required: ["kategori", "icerik"]
    }
  }
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
      default: return JSON.stringify({ error: 'Bilinmeyen araç' });
    }
  } catch (e) {
    console.error(`Tool error ${toolName}:`, e);
    return JSON.stringify({ error: e.message });
  }
}

async function execCari({ arama, limit = 10, siralama }) {
  let data;
  const a = arama.toLowerCase();
  
  if (a === 'en_borclu' || a.includes('en borçlu')) {
    ({ data } = await supabase.from('accounts').select('*').lt('bakiye', 0).order('bakiye', { ascending: true }).limit(limit));
  } else if (a === 'en_alacakli' || a.includes('bize borçlu') || a.includes('en alacak')) {
    ({ data } = await supabase.from('accounts').select('*').gt('bakiye', 0).order('bakiye', { ascending: false }).limit(limit));
  } else if (a === 'ozet' || a === 'genel' || a === 'toplam') {
    const { data: borclu } = await supabase.from('accounts').select('bakiye').lt('bakiye', 0);
    const { data: alacakli } = await supabase.from('accounts').select('bakiye').gt('bakiye', 0);
    const { count } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
    const toplamBorc = borclu ? borclu.reduce((s, r) => s + Number(r.bakiye), 0) : 0;
    const toplamAlacak = alacakli ? alacakli.reduce((s, r) => s + Number(r.bakiye), 0) : 0;
    return JSON.stringify({ toplam_cari: count, borclu_firma: borclu?.length || 0, toplam_borc_tl: toplamBorc, alacakli_firma: alacakli?.length || 0, toplam_alacak_tl: toplamAlacak, net_pozisyon_tl: toplamBorc + toplamAlacak });
  } else if (a === 'hepsi') {
    ({ data } = await supabase.from('accounts').select('*').neq('bakiye', 0).order('bakiye', { ascending: true }).limit(limit));
  } else {
    ({ data } = await supabase.from('accounts').select('*')
      .or(`unvan.ilike.%${arama}%,cari_kodu.ilike.%${arama}%,aciklama.ilike.%${arama}%`).limit(limit));
    if (!data || data.length === 0) {
      const words = arama.split(/\s+/).filter(w => w.length > 2);
      for (const word of words) {
        ({ data } = await supabase.from('accounts').select('*').or(`unvan.ilike.%${word}%,aciklama.ilike.%${word}%`).limit(limit));
        if (data && data.length > 0) break;
      }
    }
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
    ({ data } = await supabase.from('stock').select('*')
      .or(`aciklama.ilike.%${arama}%,kart_kodu.ilike.%${arama}%,grup_kodu.ilike.%${arama}%`).limit(limit));
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
    ({ data } = await supabase.from('invoices').select('*')
      .or(`cari_firma.ilike.%${arama}%,fatura_no.ilike.%${arama}%`).order('tarih', { ascending: false }).limit(limit));
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
    if (!data || data.length === 0) {
      ({ data } = await supabase.from('checks').select('*').gte('vade', today).lte('vade', nextMonth).order('vade', { ascending: true }).limit(limit));
    }
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
      return JSON.stringify({
        toplam_cek: all.length,
        portfoyde: { adet: portfoy.length, toplam_tl: portfoy.reduce((s,r) => s + Number(r.tutar||0), 0) },
        tahsilde: { adet: tahsil.length, toplam_tl: tahsil.reduce((s,r) => s + Number(r.tutar||0), 0) },
        teminatta: { adet: teminat.length, toplam_tl: teminat.reduce((s,r) => s + Number(r.tutar||0), 0) },
        vadesi_yakin_5: portfoy.filter(r => r.vade >= today).sort((a,b) => a.vade > b.vade ? 1 : -1).slice(0,5)
      });
    }
    return '[]';
  } else {
    ({ data } = await supabase.from('checks').select('*')
      .or(`borclu.ilike.%${arama}%,cari_hesap.ilike.%${arama}%,seri_no.ilike.%${arama}%`).order('vade', { ascending: true }).limit(limit));
  }
  return JSON.stringify(data || []);
}

async function execSatis({ arama, limit = 10 }) {
  const { data: allSales } = await supabase.from('sales').select('*').eq('satir_tipi', 'fatura');
  if (!allSales) return '[]';

  // Firma bazlı topla
  const firmalar = {};
  for (const r of allSales) {
    const firma = r.cari_unvan || 'Bilinmeyen';
    if (!firmalar[firma]) firmalar[firma] = { firma, toplam: 0, maliyet: 0, kar: 0, fatura_sayisi: 0 };
    firmalar[firma].toplam += Number(r.toplam_tutar || 0);
    firmalar[firma].maliyet += Number(r.maliyet || 0);
    firmalar[firma].kar += Number(r.kar_toplam || 0);
    firmalar[firma].fatura_sayisi += 1;
  }
  const firmaList = Object.values(firmalar).map(f => ({
    ...f, kar_orani_satis: f.toplam > 0 ? (f.kar / f.toplam * 100).toFixed(1) + '%' : '0%'
  }));

  const a = arama.toLowerCase();
  if (a === 'en_karli') {
    return JSON.stringify(firmaList.sort((a,b) => b.kar - a.kar).slice(0, limit));
  } else if (a === 'en_dusuk_karli') {
    return JSON.stringify(firmaList.filter(f => f.toplam > 0).sort((a,b) => (a.kar/a.toplam) - (b.kar/b.toplam)).slice(0, limit));
  } else if (a === 'ozet' || a === 'genel') {
    const toplamKar = firmaList.reduce((s,f) => s + f.kar, 0);
    const toplamSatis = firmaList.reduce((s,f) => s + f.toplam, 0);
    const toplamMaliyet = firmaList.reduce((s,f) => s + f.maliyet, 0);
    return JSON.stringify({ toplam_firma: firmaList.length, toplam_fatura: allSales.length, toplam_satis_tl: toplamSatis, toplam_maliyet_tl: toplamMaliyet, toplam_kar_tl: toplamKar, ortalama_kar_orani: toplamSatis > 0 ? (toplamKar/toplamSatis*100).toFixed(1)+'%' : '0%', en_karli_5: firmaList.sort((a,b) => b.kar - a.kar).slice(0,5).map(f => ({ firma: f.firma, kar: f.kar, oran: f.kar_orani_satis })) });
  } else {
    const matched = firmaList.filter(f => f.firma.toLowerCase().includes(a));
    if (matched.length > 0) {
      const { data: detay } = await supabase.from('sales').select('*').eq('satir_tipi', 'fatura').ilike('cari_unvan', `%${arama}%`).order('tarih', { ascending: false });
      return JSON.stringify({ firma_toplam: matched[0], fatura_detay: detay || [] });
    }
    return JSON.stringify(firmaList.sort((a,b) => b.kar - a.kar).slice(0, limit));
  }
}

async function execUrunKarlilik({ arama, limit = 10 }) {
  const a = arama.toLowerCase();
  let data;

  if (a === 'en_karli') {
    ({ data } = await supabase.from('product_profitability').select('*').order('kar_zarar', { ascending: false }).limit(limit));
  } else if (a === 'en_cok_satan') {
    ({ data } = await supabase.from('product_profitability').select('*').order('miktar', { ascending: false }).limit(limit));
  } else if (a === 'ozet' || a === 'genel') {
    const { data: all } = await supabase.from('product_profitability').select('*');
    if (all) {
      const topSatis = all.reduce((s, r) => s + Number(r.satis_tutari || 0), 0);
      const topMaliyet = all.reduce((s, r) => s + Number(r.toplam_maliyet || 0), 0);
      const topKar = all.reduce((s, r) => s + Number(r.kar_zarar || 0), 0);
      return JSON.stringify({
        toplam_urun: all.length,
        toplam_satis_tl: topSatis,
        toplam_maliyet_tl: topMaliyet,
        toplam_kar_tl: topKar,
        ortalama_kar_orani: topSatis > 0 ? (topKar / topSatis * 100).toFixed(1) + '%' : '0%',
        en_karli_5: all.sort((a, b) => Number(b.kar_zarar) - Number(a.kar_zarar)).slice(0, 5).map(r => ({
          urun: r.stok_adi, kar: r.kar_zarar, oran: r.satis_tutari > 0 ? (r.kar_zarar / r.satis_tutari * 100).toFixed(1) + '%' : '0%'
        })),
        en_cok_satan_5: all.sort((a, b) => Number(b.miktar) - Number(a.miktar)).slice(0, 5).map(r => ({
          urun: r.stok_adi, miktar: r.miktar, birim: r.birim
        }))
      });
    }
    return '[]';
  } else if (a === 'hepsi') {
    ({ data } = await supabase.from('product_profitability').select('*').order('kar_zarar', { ascending: false }).limit(limit));
  } else {
    ({ data } = await supabase.from('product_profitability').select('*')
      .or(`stok_adi.ilike.%${arama}%,stok_kodu.ilike.%${arama}%`).limit(limit));
    if (!data || data.length === 0) {
      const words = arama.split(/\s+/).filter(w => w.length > 2);
      for (const word of words) {
        ({ data } = await supabase.from('product_profitability').select('*').ilike('stok_adi', `%${word}%`).limit(limit));
        if (data && data.length > 0) break;
      }
    }
  }
  return JSON.stringify(data || []);
}

async function execBilgiSorgula({ arama }) {
  const { data } = await supabase.from('knowledge').select('*')
    .or(`content.ilike.%${arama}%,title.ilike.%${arama}%,category.ilike.%${arama}%`).limit(10);
  if (!data || data.length === 0) {
    const words = arama.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const { data: d } = await supabase.from('knowledge').select('*').ilike('content', `%${word}%`).limit(10);
      if (d && d.length > 0) return JSON.stringify(d);
    }
    return JSON.stringify({ sonuc: 'Bilgi tabanında bu konuda bilgi bulunamadı.' });
  }
  return JSON.stringify(data);
}

async function execBilgiEkle({ kategori, baslik, icerik }) {
  const { data, error } = await supabase.from('knowledge').insert({
    category: kategori, title: baslik || null, content: icerik
  }).select().single();
  if (error) return JSON.stringify({ hata: error.message });
  return JSON.stringify({ basarili: true, id: data.id, mesaj: `"${baslik || kategori}" bilgisi kaydedildi.` });
}

// ==================== MORNING REPORT ====================
function fmtMoney(n) { return Number(n||0).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }

async function generateMorningReport() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  let r = `🌅 *GÜNLÜK RAPOR — ${today}*\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  const { data: bugun } = await supabase.from('checks').select('*').eq('vade', today).order('tutar',{ascending:false});
  if (bugun?.length > 0) {
    r += `🔴 *BUGÜN VADESİ DOLAN (${bugun.length} adet — ${fmtMoney(bugun.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`;
    bugun.forEach((c,i) => { r += `${i+1}. ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz} | ${c.durum_aciklama||''}\n`; });
    r += '\n';
  } else r += '✅ Bugün vadesi dolan çek yok.\n\n';

  const { data: yarin } = await supabase.from('checks').select('*').eq('vade', tomorrow).order('tutar',{ascending:false});
  if (yarin?.length > 0) {
    r += `⚠️ *YARIN (${yarin.length} adet — ${fmtMoney(yarin.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`;
    yarin.forEach((c,i) => { r += `${i+1}. ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz}\n`; });
    r += '\n';
  }

  const { data: hafta } = await supabase.from('checks').select('*').gte('vade', today).lte('vade', next7);
  if (hafta?.length > 0) r += `📊 *7 GÜNLÜK TOPLAM: ${fmtMoney(hafta.reduce((s,c)=>s+(c.tutar||0),0))} TL (${hafta.length} çek)*\n\n`;

  const { data: gecik } = await supabase.from('checks').select('*').lt('vade', today).eq('durum_aciklama', 'Portföyde').order('vade',{ascending:true});
  if (gecik?.length > 0) {
    r += `🚨 *GECİKMİŞ (${gecik.length} adet — ${fmtMoney(gecik.reduce((s,c)=>s+(c.tutar||0),0))} TL)*\n`;
    gecik.slice(0,5).forEach((c,i) => { r += `${i+1}. ${c.vade} | ${c.borclu||'-'} — ${fmtMoney(c.tutar)} ${c.doviz}\n`; });
    if (gecik.length > 5) r += `   ... ve ${gecik.length-5} çek daha\n`;
    r += '\n';
  }

  // Son faturalar
  const { data: sonFaturalar } = await supabase.from('invoices').select('*').order('tarih', { ascending: false }).limit(5);
  if (sonFaturalar?.length > 0) {
    r += `📄 *SON KESİLEN FATURALAR*\n`;
    sonFaturalar.forEach((f,i) => { r += `${i+1}. ${f.tarih} | ${(f.cari_firma||'').substring(0,25)} | ${fmtMoney(f.genel_toplam_tl)} TL\n`; });
    r += '\n';
  }

  // Ay içi karlılık
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const { data: aySatis } = await supabase.from('sales').select('*').eq('satir_tipi', 'fatura').gte('tarih', monthStart);
  if (aySatis?.length > 0) {
    const topSatis = aySatis.reduce((s,r) => s + Number(r.toplam_tutar||0), 0);
    const topKar = aySatis.reduce((s,r) => s + Number(r.kar_toplam||0), 0);
    r += `📊 *AY İÇİ KARLILIK*\nSatış: ${fmtMoney(topSatis)} TL | Kar: ${fmtMoney(topKar)} TL | Oran: %${topSatis>0?(topKar/topSatis*100).toFixed(1):'0'}\n\n`;
  }

  r += `━━━━━━━━━━━━━━━━━━━━━━\n_OpenClaw Agent — Napol Global_`;
  return r;
}

// ==================== AGENT CORE ====================
const SYSTEM_PROMPT = `Sen OpenClaw, Napol Global şirketinin AI agent asistanısın.
Kağıt, ambalaj ve medikal ambalaj sektöründe üretim/ticaret yapan bir şirketin akıllı asistanısın.

KURALLAR:
- Türkçe cevap ver. Kısa, net ve profesyonel ol.
- Sayıları Türk formatında göster: 1.234.567,89 TL
- Bakiye negatifse = firmaya borcumuz var, pozitifse = firma bize borçlu
- Kar oranını her zaman Kar/Satış olarak hesapla (maliyet üzerinden değil)
- Birden fazla araç kullanabilirsin — karmaşık sorularda birden fazla tablo sorgula
- Ürün bazlı karlılık için urun_karlilik_sorgula aracını kullan, firma bazlı karlılık için satis_karlilik_sorgula aracını kullan
- Bilgi tabanında yoksa kendi sektör bilgini kullan
- Asla uydurma veri verme, veritabanında yoksa söyle
- Kullanıcıya listeyi düzgün numaralı göster
- Önemli bilgileri vurgula

Bugünün tarihi: ${new Date().toISOString().split('T')[0]}`;

async function runAgent(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];
  
  // İlk çağrı — Claude araçları seçsin
  let response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: AGENT_TOOLS,
    messages
  });

  // Tool use döngüsü — Claude istediği kadar araç çağırabilir
  let maxLoops = 5;
  while (response.stop_reason === 'tool_use' && maxLoops > 0) {
    maxLoops--;
    
    // Claude'un çağırdığı tüm araçları çalıştır
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        console.log(`Agent tool: ${block.name}`, JSON.stringify(block.input));
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result
        });
      }
    }

    // Sonuçlarla tekrar Claude'a gönder
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools: AGENT_TOOLS,
      messages
    });
  }

  // Final cevabı çıkar
  const textBlocks = response.content.filter(b => b.type === 'text');
  return textBlocks.map(b => b.text).join('\n') || 'Bir cevap oluşturulamadı.';
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

    // Limitsiz komutlar
    if (command === '/start') {
      await send(chatId, `🤖 Merhaba ${user.full_name}!\n\nBen *OpenClaw Agent*, Napol Global şirket asistanıyım.\n\nBana doğal dilde her şeyi sorabilirsiniz:\n\n💬 "Ağaoğlu'nun bakiyesi ne, son faturaları ve çekleri göster"\n💬 "En karlı 5 firma kimdir"\n💬 "Bu hafta ödenmemiz gereken çekler"\n💬 "Depoda glasin var mı"\n\n📋 /rapor — Günlük rapor\n📋 /limit — Limit durumu\n📝 /ogren — Bilgi ekle\n❓ /yardim — Yardım\n\n_Tek soruda birden fazla konuyu sorabilirsiniz!_`);
      await logQuery(msg.from.id, 'start', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/yardim' || command === '/help') {
      await send(chatId, `📋 *OpenClaw Agent Rehberi*\n\nDoğal dilde soru sorun:\n\n🏢 "Bebiller bakiyesi ne"\n🏢 "En borçlu 5 firma"\n🏢 "Toplam borcumuz"\n📦 "Stokta POF var mı"\n📄 "Gelişim'e kestiğimiz faturalar"\n📅 "Vadesi yaklaşan çekler"\n📅 "Çek portföy özeti"\n📊 "En karlı satışlar"\n📊 "Ağaoğlu karlılığı nasıl"\n\n🧠 Karmaşık sorular:\n"Ağaoğlu bakiyesi + faturaları + çekleri"\n"Stokta ne var ve en çok satan ürün hangisi"\n\n📝 /ogren [bilgi] — Bilgi tabanına ekle\n📋 /rapor — Günlük rapor\n📋 /limit — Limit durumu`);
      await logQuery(msg.from.id, 'help', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/limit') {
      const l = await checkLimits(msg.from.id);
      await send(chatId, `📋 *Limit Durumu*\n\n👤 Günlük: ${l.daily || 0}/${DAILY_LIMIT} kullanıldı\n💰 Aylık: ~$${l.monthly || 0} / $${MONTHLY_BUDGET_USD}`);
      return res.status(200).json({ ok: true });
    }
    if (command === '/rapor') {
      if (user.role !== 'admin') { await send(chatId, '🚫 Bu komut sadece yöneticiler içindir.'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const report = await generateMorningReport();
      await send(chatId, report);
      await logQuery(msg.from.id, 'rapor', text, 'Günlük rapor'); return res.status(200).json({ ok: true });
    }
    if (command === '/ogren') {
      if (!cleanText) { await send(chatId, '📝 Kullanım: /ogren [bilgi]\n\nÖrnek:\n/ogren glasin kağıt medikal ambalajda kullanılır, 40-120gsm arası üretilir\n/ogren Bebiller firması Kahramanmaraş\'ta, medikal sektörü'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const result = await runAgent(`Kullanıcı şu bilgiyi eklemek istiyor: "${cleanText}". Uygun kategori belirle ve bilgi_ekle aracını kullan.`);
      await send(chatId, result);
      await logQuery(msg.from.id, 'ogren', text, result); return res.status(200).json({ ok: true });
    }

    // Limit kontrol
    const limitCheck = await checkLimits(msg.from.id);
    if (!limitCheck.ok) { await send(chatId, limitCheck.msg); return res.status(200).json({ ok: true }); }

    // AGENT — doğal dilde soru
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
