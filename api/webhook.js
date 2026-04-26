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
      await fetch(`${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'HTML' }) });
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
  if ((dailyCount || 0) >= DAILY_LIMIT) return { ok: false, msg: `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ GÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼nlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼k soru limitinize ulaÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂtÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±z (${DAILY_LIMIT}). YarÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±n tekrar deneyebilirsiniz.` };
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01T00:00:00`;
  const { count: monthCount } = await supabase.from('query_logs').select('*', { count: 'exact', head: true })
    .gte('created_at', monthStart).not('query_type', 'in', '("start","help")');
  if ((monthCount || 0) * COST_PER_QUERY >= MONTHLY_BUDGET_USD) return { ok: false, msg: `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ AylÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k API bÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼tÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§esi doldu ($${MONTHLY_BUDGET_USD}).` };
  return { ok: true, daily: dailyCount || 0, monthly: ((monthCount || 0) * COST_PER_QUERY).toFixed(2) };
}

async function logQuery(telegramId, queryType, queryText, responseText) {
  try {
    await supabase.from('query_logs').insert({ user_id: telegramId, query_type: queryType, query_text: queryText, response_text: responseText ? responseText.substring(0, 2000) : null });
  } catch(e) {}
}

// ==================== AGENT TOOLS ====================
const AGENT_TOOLS = [
  { name: "cari_sorgula", description: "Cari hesap/firma sorgulama. Bakiye NEGATÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°F = biz o firmaya borÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§luyuz, POZÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°TÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°F = firma bize borÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§lu.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" }, siralama: { type: "string" } }, required: ["arama"] } },
  { name: "stok_sorgula", description: "Depo stok sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "fatura_sorgula", description: "Fatura sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, tur: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "cek_sorgula", description: "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂek ve senet sorgulama.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "satis_karlilik_sorgula", description: "SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ karlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k analizi.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "bilgi_sorgula", description: "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂirket bilgi tabanÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± sorgula.", input_schema: { type: "object", properties: { arama: { type: "string" } }, required: ["arama"] } },
  { name: "urun_karlilik_sorgula", description: "ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂrÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼n bazlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± karlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k analizi.", input_schema: { type: "object", properties: { arama: { type: "string" }, limit: { type: "number" } }, required: ["arama"] } },
  { name: "bilgi_ekle", description: "Bilgi tabanÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±na yeni bilgi ekle.", input_schema: { type: "object", properties: { kategori: { type: "string" }, baslik: { type: "string" }, icerik: { type: "string" } }, required: ["kategori", "icerik"] } },
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
      default: return JSON.stringify({ error: 'Bilinmeyen araÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§' });
    }
  } catch (e) { console.error(`Tool error ${toolName}:`, e); return JSON.stringify({ error: e.message }); }
}

async function execCari({arama, limit=10}) {
  const a = arama.toLowerCase().trim();

  // ÃÂÃÂzet
  if (a === 'ozet' || a === 'genel') {
    const { data } = await supabase.from('dia_cariler').select('bakiye');
    const rows = data || [];
    const borclu = rows.filter(r => Number(r.bakiye) < 0);
    const alacakli = rows.filter(r => Number(r.bakiye) > 0);
    return JSON.stringify({
      toplam: rows.length,
      biz_borclu_sayi: borclu.length,
      biz_borclu_toplam: borclu.reduce((s,r) => s + Number(r.bakiye), 0),
      bize_borclu_sayi: alacakli.length,
      bize_borclu_toplam: alacakli.reduce((s,r) => s + Number(r.bakiye), 0)
    });
  }

  // En alacaklÃÂÃÂ± (bize borÃÂÃÂ§lu = pozitif)
  if (a === 'en_alacakli' || a.includes('bize bor') || a.includes('en alacak') || a.includes('alacakl')) {
    const { data } = await supabase.from('dia_cariler').select('*').gt('bakiye', 0).order('bakiye', {ascending: false}).limit(limit);
    return JSON.stringify((data||[]).map(r => ({...r, _durum: 'FÃÂÃÂ°RMA BÃÂÃÂ°ZE BORÃÂÃÂLU'})));
  }

  // En borÃÂÃÂ§lu (biz borÃÂÃÂ§luyuz = negatif)
  if (a === 'en_borclu' || a.includes('en borÃÂÃÂ§') || a.includes('biz borÃÂÃÂ§')) {
    const { data } = await supabase.from('dia_cariler').select('*').lt('bakiye', 0).order('bakiye', {ascending: true}).limit(limit);
    return JSON.stringify((data||[]).map(r => ({...r, _durum: 'BÃÂÃÂ°Z BORÃÂÃÂLUYUZ'})));
  }

  // ÃÂÃÂ°sme gÃÂÃÂ¶re arama - full text
  const { data: d1 } = await supabase.from('dia_cariler').select('*').ilike('unvan', `%${arama}%`).limit(limit);
  if (d1 && d1.length > 0) {
    return JSON.stringify(d1.map(r => ({...r, _durum: Number(r.bakiye) < 0 ? 'BÃÂÃÂ°Z BORÃÂÃÂLUYUZ' : Number(r.bakiye) > 0 ? 'FÃÂÃÂ°RMA BÃÂÃÂ°ZE BORÃÂÃÂLU' : 'DENK'})));
  }

  // Kelimelere bÃÂÃÂ¶l
  const words = arama.split(/\s+/).filter(w => w.length > 2);
  for (const w of words) {
    const { data: dw } = await supabase.from('dia_cariler').select('*').ilike('unvan', `%${w}%`).limit(limit);
    if (dw && dw.length > 0) return JSON.stringify(dw.map(r => ({...r, _durum: Number(r.bakiye) < 0 ? 'BÃÂÃÂ°Z BORÃÂÃÂLUYUZ' : Number(r.bakiye) > 0 ? 'FÃÂÃÂ°RMA BÃÂÃÂ°ZE BORÃÂÃÂLU' : 'DENK'})));
  }
  return JSON.stringify([]);
}

async function execStok({arama, limit=20}) {
  const a = arama.toLowerCase();
  if (a === 'hepsi' || a === 'listele') {
    const { data } = await supabase.from('dia_stoklar').select('*').order('fiili_stok', {ascending: false}).limit(limit);
    return JSON.stringify(data || []);
  }
  const { data: d1 } = await supabase.from('dia_stoklar').select('*').ilike("raw_data->>'aciklama'", `%${arama}%`).limit(limit);
  if (d1 && d1.length > 0) return JSON.stringify(d1);
  const words = arama.split(/\s+/).filter(w => w.length > 1);
  for (const w of words) {
    const { data: dw } = await supabase.from('dia_stoklar').select('*').ilike("raw_data->>'aciklama'", `%${w}%`).limit(limit);
    if (dw && dw.length > 0) return JSON.stringify(dw);
  }
  return JSON.stringify([]);
}

async function execFatura({arama, limit=15}) {
  const a = arama.toLowerCase().trim();
  const now = new Date();
  let query = supabase.from('dia_faturalar').select('*');

  if (a === 'bugun' || a === 'bugÃÂÃÂ¼n') {
    const today = now.toISOString().split('T')[0];
    query = query.eq('tarih', today);
  } else if (a === 'bu_ay' || a === 'bu ay') {
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    query = query.gte('tarih', monthStart);
  } else if (a === 'son' || a === 'son_faturalar') {
    query = query.order('tarih', {ascending: false});
  } else {
    query = query.ilike('cari_adi', `%${arama}%`);
  }

  const { data } = await query.order('tarih', {ascending: false}).limit(limit);
  return JSON.stringify(data || []);
}

async function execCek({arama, limit=20}) {
  const a = arama.toLowerCase().trim();
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7*86400000).toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];

  if (a === 'ozet' || a === 'portfoy_ozet') {
    const { data } = await supabase.from('dia_cekler').select('tutar, durum, vade');
    const all = data || [];
    const portfoy = all.filter(r => r.durum && r.durum.includes('PortfÃÂÃÂ¶y'));
    return JSON.stringify({
      toplam: all.length,
      portfoyde: { adet: portfoy.length, toplam: portfoy.reduce((s,r) => s+Number(r.tutar||0), 0) },
      yaklasan: portfoy.filter(r => r.vade >= today && r.vade <= nextMonth).slice(0,10)
    });
  }

  let query = supabase.from('dia_cekler').select('*');
  if (a === 'bu_hafta' || a === 'vadesi_yaklasan') {
    query = query.gte('vade', today).lte('vade', nextWeek);
  } else if (a === 'bu_ay') {
    query = query.gte('vade', today).lte('vade', nextMonth);
  } else if (a === 'gecikmis') {
    query = query.lt('vade', today);
  } else if (a !== 'hepsi') {
    query = query.ilike('cari_adi', `%${arama}%`);
  }

  const { data } = await query.order('vade', {ascending: true}).limit(limit);
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
    const ayIsimleri = ['', 'Ocak', 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂubat', 'Mart', 'Nisan', 'MayÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±s', 'Haziran', 'Temmuz', 'AÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂustos', 'EylÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼l', 'Ekim', 'KasÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m', 'AralÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k'];
    const { data } = await supabase.from('invoices').select('fatura_turu, toplam_tl, genel_toplam_tl').gte('tarih', monthStart).lt('tarih', nextMonth);
    if (!data || data.length === 0) return JSON.stringify({ ay: ayIsimleri[targetMonth], yil: targetYear, mesaj: 'Bu ay iÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§in fatura verisi bulunamadÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±.' });
    let satis_kdv = 0, alis_kdv = 0, satis_tutar = 0, alis_tutar = 0, satis_adet = 0, alis_adet = 0;
    for (const r of data) {
      const kdv = Number(r.genel_toplam_tl || 0) - Number(r.toplam_tl || 0);
      const tur = (r.fatura_turu || '').toLowerCase();
      if (tur.includes('satÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ') || tur.includes('fiyat farkÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± verilen')) { satis_kdv += kdv; satis_tutar += Number(r.genel_toplam_tl || 0); satis_adet++; }
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
  return JSON.stringify({ hata: 'GeÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§ersiz iÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂlem.' });
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
  if (!data || data.length === 0) { const words = arama.split(/\s+/).filter(w => w.length > 2); for (const word of words) { const { data: d } = await supabase.from('knowledge').select('*').ilike('content', `%${word}%`).limit(10); if (d && d.length > 0) return JSON.stringify(d); } return JSON.stringify({ sonuc: 'Bilgi bulunamadÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±.' }); }
  return JSON.stringify(data);
}

async function execBilgiEkle({ kategori, baslik, icerik }) {
  const { data, error } = await supabase.from('knowledge').insert({ category: kategori, title: baslik || null, content: icerik }).select().single();
  if (error) return JSON.stringify({ hata: error.message });
  return JSON.stringify({ basarili: true, id: data.id });
}

// ==================== KARLILIK RAPORU ====================
const DIA_URL_K = `https://${process.env.DIA_SERVER}.ws.dia.com.tr/api/v3`;
const SATIS_TURLERI = ['Toptan SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ', 'Perakende SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ', 'Verilen Hizmet'];
const IADE_TURLERI  = ['Toptan SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ade', 'Perakende SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ade', 'AlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±nan Fiyat FarkÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±', 'Verilen Fiyat FarkÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±'];
const GIDER_TURLERI = ['AlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±nan Hizmet', 'Mal AlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m'];
const AY_ADLARI = ['','Ocak','ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂubat','Mart','Nisan','MayÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±s','Haziran','Temmuz','AÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂustos','EylÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼l','Ekim','KasÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m','AralÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k'];

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

async function karlilikRaporuCek(chatId, basTarih, bitTarih) {
  await sendHtml(chatId, 'â³ KarlÄ±lÄ±k raporu hazÄ±rlanÄ±yor...');
  const sessionId = await diaLoginK();
  const simdi = new Date();
  const basTar = basTarih || `${simdi.getFullYear()}-${String(simdi.getMonth()+1).padStart(2,'0')}-01`;
  const bitTar = bitTarih || new Date(simdi.getFullYear(), simdi.getMonth()+1, 0).toISOString().split('T')[0];

  const res = await diaCallK('rpr/json', { rpr_raporsOnuc_getir: {
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

  let msg = `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ <b>KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k Raporu ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ${AY_ADLARI[parseInt(ayNo)]} ${yil}</b>\n<i>${basTar} ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ${bitTar}</i>\n\n`;
  msg += `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ° <b>Ciro:</b> ${formatPara(toplamCiro)} ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂº\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦ <b>Maliyet:</b> ${formatPara(toplamMaliyet)} ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂº\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ <b>Kar:</b> ${formatPara(toplamKar)} ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂº (%${marj})\n`;
  if (top5.length > 0) {
    msg += `\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ <b>En KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± 5 Cari:</b>\n`;
    for (const [ad, v] of top5) { const cMarj = v.ciro > 0 ? ((v.kar / v.ciro) * 100).toFixed(0) : 0; msg += `  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ ${ad}: ${formatPara(v.kar)} ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂº (%${cMarj})\n`; }
  }
  if (sifirMaliyetUyari.length > 0) {
    msg += `\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ <b>Maliyetsiz SatÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ (${sifirMaliyetUyari.length} fatura):</b>\n`;
    for (const u of sifirMaliyetUyari.slice(0, 5)) msg += `  ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ ${u}\n`;
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
  let cepler = [];
  try {
    const sessionId = await diaLoginK();
    const res = await diaCallK('bcs/json', {
      bcs_ceksenet_listele: {
        session_id: sessionId, firma_kodu: parseInt(process.env.DIA_FIRMA||'2'), donem_kodu: parseInt(process.env.DIA_DONEM||'3'),
        filters: [{ field: 'durum', operator: '=', value: 'Portföyde' }],
        sorts: [{ field: 'vade', sorttype: 'ASC' }],
        params: { __selectHeader: ['ceksenetno','vade','tutar','cariadi','banka','durum'] },
        limit: 200, offset: 0
      }
    });
    cepler = res.result || [];
  } catch(e) { console.error('Rapor hata:', e.message); }
  
  const bug = cepler.filter(x => x.vade === today);
  const yar = cepler.filter(x => x.vade === tomorrow);
  const haf = cepler.filter(x => x.vade >= today && x.vade <= next7);
  const gec = cepler.filter(x => x.vade < today);
  function fm(n){ return Number(n||0).toLocaleString('tr-TR',{minimumFractionDigits:0,maximumFractionDigits:0}); }
  
  let r = '🌅 <b>GÜNLÜK RAPOR — ' + today + '</b>
━━━━━━━━━━━━━━━━━━

';
  if(bug.length>0){
    r+='🔴 <b>Bugün (' + bug.length + ' adet — ' + fm(bug.reduce((s,x)=>s+(x.tutar||0),0)) + ' ₺)</b>
';
    bug.forEach((x,i)=>{r+=(i+1)+'. '+(x.cariadi||'-')+' — '+fm(x.tutar)+' ₺ | '+(x.banka||'')+'
';});
    r+='
';
  } else { r+='✅ Bugün vadesi dolan çek yok.

'; }
  if(yar.length>0){
    r+='⚠️ <b>Yarın (' + yar.length + ' adet — ' + fm(yar.reduce((s,x)=>s+(x.tutar||0),0)) + ' ₺)</b>
';
    yar.forEach((x,i)=>{r+=(i+1)+'. '+(x.cariadi||'-')+' — '+fm(x.tutar)+' ₺
';});
    r+='
';
  }
  if(haf.length>0) r+='📅 <b>7 GÜN: ' + fm(haf.reduce((s,x)=>s+(x.tutar||0),0)) + ' ₺ (' + haf.length + ' çek)</b>

';
  if(gec.length>0){
    r+='🚨 <b>Geçikmiş (' + gec.length + ' adet — ' + fm(gec.reduce((s,x)=>s+(x.tutar||0),0)) + ' ₺)</b>
';
    gec.slice(0,5).forEach((x,i)=>{r+=(i+1)+'. '+x.vade+' | '+(x.cariadi||'-')+' — '+fm(x.tutar)+' ₺
';});
    if(gec.length>5) r+=' ...ve '+(gec.length-5)+' çek daha
';
  }
  r+='━━━━━━━━━━━━━━━━━━
<i>OpenClaw Agent — Napol Global</i>';
  return r;
}

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
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n') || 'Cevap oluÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂturulamadÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±.';
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
    if (!user || !user.is_active) { await send(chatId, 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ« EriÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂim yetkiniz yok.'); return res.status(200).json({ ok: true }); }

    // ---- Limitsiz komutlar ----
    if (command === '/start') {
      await send(chatId, `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¤ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Merhaba ${user.full_name}!\n\nBen *OpenClaw Agent*, Napol Global ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂirket asistanÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±yÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m.\n\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /rapor ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ GÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼nlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼k rapor\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /karlilik ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Bu ayÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±n karlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k raporu\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /limit ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Limit durumu\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /ogren ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Bilgi ekle\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /yardim ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ YardÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m`);
      await logQuery(msg.from.id, 'start', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/yardim' || command === '/help') {
      await send(chatId, `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ *OpenClaw Agent Rehberi*\n\nDoÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂal dilde soru sorun:\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ Cari, ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¦ Stok, ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Fatura, ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂek, ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k\n\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /karlilik ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Bu ay karlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /karlilik 03 ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Mart ayÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± karlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /rapor ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ GÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼nlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼k rapor\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ /ogren [bilgi] ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Bilgi ekle`);
      await logQuery(msg.from.id, 'help', text, ''); return res.status(200).json({ ok: true });
    }
    if (command === '/limit') {
      const l = await checkLimits(msg.from.id);
      await send(chatId, `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ *Limit Durumu*\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¤ GÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼nlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼k: ${l.daily || 0}/${DAILY_LIMIT}\nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ° AylÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k: ~$${l.monthly || 0} / $${MONTHLY_BUDGET_USD}`);
      return res.status(200).json({ ok: true });
    }

    // ---- Admin komutlarÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± ----
    if (command === '/rapor') {
      if (user.role !== 'admin') { await send(chatId, '🚫 Sadece yönetici.'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const report = await generateMorningReport();
      await send(chatId, report);
      await logQuery(msg.from.id, 'rapor', text, 'GÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼nlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¼k rapor');
      return res.status(200).json({ ok: true });
    }

    // ---- YENÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°: KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k raporu komutu ----
    if (command === '/karlilik') {
      if (user.role !== 'admin') { await send(chatId, 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ« Bu komut sadece yÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¶neticiler iÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ§indir.'); return res.status(200).json({ ok: true }); }
      const p1 = text.split(' ')[1] || null;
      const p2 = text.split(' ')[2] || null;
      if (!p1) { await sendHtml(chatId, '<b>Tarih aral\u0131\u011f\u0131 girin:</b>\n\u2022 /karlilik 2026-01-01 2026-03-31'); return res.status(200).json({ ok: true }); } // /karlilik 04 ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ '04'
      try {
        await karlilikRaporuCek(chatId, p1, p2);
      } catch (err) {
        console.error('KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k raporu hata:', err);
        await sendHtml(chatId, `ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k raporu hatasÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±: ${err.message}`);
      }
      await logQuery(msg.from.id, 'karlilik', text, 'KarlÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±lÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±k raporu');
      return res.status(200).json({ ok: true });
    }

    if (command === '/ogren') {
      if (!cleanText) { await send(chatId, 'ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ KullanÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±m: /ogren [bilgi]'); return res.status(200).json({ ok: true }); }
      await typing(chatId);
      const result = await runAgent(`KullanÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±cÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂu bilgiyi eklemek istiyor: "${cleanText}". Uygun kategori belirle ve bilgi_ekle aracÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ±nÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ± kullan.`);
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
