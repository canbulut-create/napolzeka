const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ==================== LIMITLER ====================
const DAILY_LIMIT = 50;           // kullanıcı başına günlük soru
const MONTHLY_BUDGET_USD = 10;    // aylık maksimum API harcaması
const COST_PER_QUERY = 0.005;     // ortalama soru başı maliyet ($)

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
  await fetch(`${TG}/sendChatAction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' })
  }).catch(() => {});
}

// ==================== AUTH ====================
async function getOrCreateUser(tgUser) {
  try {
    const { data: existing } = await supabase
      .from('users').select('*').eq('telegram_id', tgUser.id).single();
    if (existing) return existing;

    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim()));
    const isAdmin = adminIds.includes(tgUser.id);

    const { data: newUser } = await supabase.from('users').insert({
      telegram_id: tgUser.id,
      telegram_username: tgUser.username || null,
      full_name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(),
      role: isAdmin ? 'admin' : 'user',
      permissions: isAdmin
        ? ['stok', 'cari', 'fatura', 'cek', 'satis', 'rapor', 'admin']
        : ['stok', 'cari']
    }).select().single();
    return newUser;
  } catch (e) { console.error('Auth error:', e); return null; }
}

function hasPerm(user, perm) {
  if (!user || !user.is_active) return false;
  if (user.role === 'admin') return true;
  return user.permissions && user.permissions.includes(perm);
}

// ==================== RATE LIMITING ====================
async function checkDailyLimit(telegramId) {
  const today = new Date().toISOString().split('T')[0];
  const { count } = await supabase
    .from('query_logs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', telegramId)
    .gte('created_at', today + 'T00:00:00')
    .lte('created_at', today + 'T23:59:59');
  return (count || 0) < DAILY_LIMIT ? { ok: true, remaining: DAILY_LIMIT - (count || 0) } : { ok: false, remaining: 0 };
}

async function checkMonthlyBudget() {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01T00:00:00`;
  const { count } = await supabase
    .from('query_logs')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', monthStart)
    .not('query_type', 'in', '("start","help")');
  const estimatedCost = (count || 0) * COST_PER_QUERY;
  return estimatedCost < MONTHLY_BUDGET_USD ? { ok: true, spent: estimatedCost.toFixed(2) } : { ok: false, spent: estimatedCost.toFixed(2) };
}

// ==================== LOGGER ====================
async function logQuery(telegramId, queryType, queryText, responseText) {
  try {
    await supabase.from('query_logs').insert({
      user_id: telegramId, query_type: queryType,
      query_text: queryText, response_text: responseText ? responseText.substring(0, 2000) : null
    });
  } catch (e) { console.error('Log error:', e); }
}

// ==================== CLAUDE AI ====================
async function askClaude(question, context, systemPrompt) {
  const defaultSystem = `Sen OpenClaw, Napol Global şirketinin AI asistanısın.
Kağıt, ambalaj ve medikal ambalaj sektöründe üretim/ticaret yapan bir şirketin asistanısın.
Türkçe cevap ver. Kısa, net ve profesyonel ol.
Verilen veride cevap yoksa "Bu bilgiyi bulamadım" de. Asla uydurma.
Sayıları Türk formatında göster: 1.234.567,89 TL
Bakiye negatifse = firmaya borcumuz, pozitifse = firma bize borçlu.
Tabloları düzgün listele. Sıralama isteniyorsa sırala.`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemPrompt || defaultSystem,
      messages: [{
        role: 'user',
        content: context ? `Şirket verileri:\n${context}\n\nSoru: ${question}` : question
      }]
    });
    return response.content[0].text;
  } catch (error) {
    console.error('Claude error:', error);
    return 'AI servisi şu an yanıt veremiyor. Lütfen biraz sonra tekrar deneyin.';
  }
}

// ==================== AKILLI CARİ SORGULAMA ====================
async function queryAccounts(question) {
  const q = question.toLowerCase();
  let results = [];
  let context = '';

  // GENEL SORGULAR — en borçlu, en alacaklı, toplam vs.
  if (q.includes('en borçlu') || q.includes('en çok borç') || (q.includes('ilk') && q.includes('borç'))) {
    const limit = extractNumber(q) || 5;
    const { data } = await supabase.from('accounts').select('*')
      .lt('bakiye', 0).order('bakiye', { ascending: true }).limit(limit);
    if (data) results = data;
    context = `EN BORÇLU OLDUĞUMUZ ${results.length} FİRMA:\n` + results.map((r, i) =>
      `${i + 1}. ${r.unvan} (${r.cari_kodu}) | Borç: ${r.bakiye} TL | Şehir: ${r.sehir || '-'}`
    ).join('\n');
  }
  else if (q.includes('en alacak') || q.includes('bize borçlu') || q.includes('en çok alacak')) {
    const limit = extractNumber(q) || 5;
    const { data } = await supabase.from('accounts').select('*')
      .gt('bakiye', 0).order('bakiye', { ascending: false }).limit(limit);
    if (data) results = data;
    context = `BİZE EN BORÇLU ${results.length} FİRMA:\n` + results.map((r, i) =>
      `${i + 1}. ${r.unvan} (${r.cari_kodu}) | Alacak: ${r.bakiye} TL | Şehir: ${r.sehir || '-'}`
    ).join('\n');
  }
  else if (q.includes('toplam borç') || q.includes('toplam alacak') || q.includes('genel durum') || q.includes('özet') || q.includes('toplam cari')) {
    const { data: borclu } = await supabase.from('accounts').select('bakiye').lt('bakiye', 0);
    const { data: alacakli } = await supabase.from('accounts').select('bakiye').gt('bakiye', 0);
    const { count: toplam } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
    const toplamBorc = borclu ? borclu.reduce((s, r) => s + r.bakiye, 0) : 0;
    const toplamAlacak = alacakli ? alacakli.reduce((s, r) => s + r.bakiye, 0) : 0;
    context = `CARİ GENEL DURUM:\nToplam cari: ${toplam}\nBorçlu olduğumuz firma sayısı: ${borclu ? borclu.length : 0}\nToplam borcumuz: ${toplamBorc} TL\nBize borçlu firma sayısı: ${alacakli ? alacakli.length : 0}\nToplam alacağımız: ${toplamAlacak} TL\nNet pozisyon: ${toplamBorc + toplamAlacak} TL`;
    results = [{ ozet: true }];
  }
  else if (q.includes('ilk') || q.includes('listele') || q.includes('tüm') || q.includes('hepsi')) {
    const limit = extractNumber(q) || 10;
    const { data } = await supabase.from('accounts').select('*')
      .neq('bakiye', 0).order('bakiye', { ascending: true }).limit(limit);
    if (data) results = data;
    context = `BAKİYESİ OLAN İLK ${results.length} CARİ:\n` + results.map((r, i) =>
      `${i + 1}. ${r.unvan} | Bakiye: ${r.bakiye} TL | ${r.bakiye < 0 ? 'BORÇ' : 'ALACAK'}`
    ).join('\n');
  }
  else {
    // FİRMA BAZLI ARAMA
    const searchTerm = question.replace(/cari|hesap|bakiye|borç|alacak|ne\s*kadar|nedir|var\s*mı|sorgula/gi, '').trim();
    if (searchTerm) {
      const { data } = await supabase.from('accounts').select('*')
        .or(`unvan.ilike.%${searchTerm}%,cari_kodu.ilike.%${searchTerm}%,aciklama.ilike.%${searchTerm}%`)
        .order('bakiye', { ascending: true }).limit(10);
      if (data && data.length > 0) results = data;

      if (results.length === 0) {
        const words = searchTerm.split(/\s+/).filter(w => w.length > 2);
        for (const word of words) {
          const { data } = await supabase.from('accounts').select('*')
            .or(`unvan.ilike.%${word}%,aciklama.ilike.%${word}%`).limit(10);
          if (data && data.length > 0) { results = data; break; }
        }
      }
    }

    if (results.length === 0) return '🏢 Bu firmayı bulamadım. Firma adını kontrol edip tekrar dener misin?';

    context = results.map(r =>
      `Firma: ${r.unvan} | Kodu: ${r.cari_kodu || '-'} | Kısa Ad: ${r.aciklama || '-'} | Bakiye: ${r.bakiye} TL | B/A: ${r.borc_alacak || '-'} | Tel: ${r.telefon || '-'} | Şehir: ${r.sehir || '-'}`
    ).join('\n');
  }

  return await askClaude(question, context,
    `Sen Napol Global şirketinin muhasebe asistanısın.
Bakiye negatifse: "Bu firmaya X TL borcunuz var" de.
Bakiye pozitifse: "Bu firma size X TL borçlu" de.
Listeyi düzgün numaralı göster.
Sayıları Türk formatında göster (1.234.567,89 TL).
Kısa ve net ol. Emoji: 💰 alacak, 🔴 borç, ✅ denk.`);
}

// ==================== STOK SORGULAMA ====================
async function queryStock(question) {
  const q = question.toLowerCase();
  let results = [];

  // Genel stok sorguları
  if (q.includes('tüm') || q.includes('hepsi') || q.includes('listele') || q.includes('kaç ürün')) {
    const { data } = await supabase.from('stock').select('*').gt('fiili_stok', 0).order('fiili_stok', { ascending: false }).limit(20);
    if (data) results = data;
  } else {
    const searchTerm = question.replace(/stok|depo|var\s*mı|kaç|ne\s*kadar|kaldı\s*mı/gi, '').trim();
    if (searchTerm) {
      const { data } = await supabase.from('stock').select('*')
        .or(`aciklama.ilike.%${searchTerm}%,kart_kodu.ilike.%${searchTerm}%,grup_kodu.ilike.%${searchTerm}%`)
        .limit(20);
      if (data && data.length > 0) results = data;
    }
    if (results.length === 0 && searchTerm) {
      const words = searchTerm.split(/\s+/).filter(w => w.length > 1);
      for (const word of words) {
        const { data } = await supabase.from('stock').select('*').ilike('aciklama', `%${word}%`).limit(20);
        if (data && data.length > 0) { results = data; break; }
      }
    }
  }

  if (results.length === 0) return '📦 Bu ürünü stokta bulamadım. Ürün adını kontrol edip tekrar dener misin?';

  const context = results.map(r =>
    `Ürün: ${r.aciklama} | Kod: ${r.kart_kodu || '-'} | Fiili Stok: ${r.fiili_stok} ${r.ana_birim || ''} | Gerçek Stok: ${r.gercek_stok} | Maliyet: ${r.birim_maliyet || '-'}`
  ).join('\n');

  return await askClaude(question, context,
    'Sen depo stok asistanısın. Stok bilgilerini liste halinde göster. Emoji: 📦 var, ⚠️ az (5 altı), ❌ yok. Türkçe ve kısa cevap ver.');
}

// ==================== FATURA SORGULAMA ====================
async function queryInvoices(question) {
  const q = question.toLowerCase();
  let results = [];

  if (q.includes('son') || q.includes('listele') || q.includes('bu ay') || q.includes('bu hafta')) {
    const { data } = await supabase.from('invoices').select('*')
      .order('tarih', { ascending: false }).limit(15);
    if (data) results = data;
  } else {
    const searchTerm = question.replace(/fatura|kaç|ne\s*kadar|listele|son|göster/gi, '').trim();
    if (searchTerm) {
      const { data } = await supabase.from('invoices').select('*')
        .or(`cari_firma.ilike.%${searchTerm}%,fatura_no.ilike.%${searchTerm}%`)
        .order('tarih', { ascending: false }).limit(15);
      if (data && data.length > 0) results = data;
    }
    if (results.length === 0) {
      const { data } = await supabase.from('invoices').select('*')
        .order('tarih', { ascending: false }).limit(10);
      if (data) results = data;
    }
  }

  const context = results.map(r =>
    `Tarih: ${r.tarih} | Firma: ${r.cari_firma} | No: ${r.fatura_no} | Toplam: ${r.toplam_tl} TL | Genel: ${r.genel_toplam_tl} TL | Tür: ${r.fatura_turu || '-'}`
  ).join('\n');

  return await askClaude(question, context,
    'Sen muhasebe asistanısın. Fatura bilgilerini tarih sırasıyla listele. Sayıları Türk formatında göster. Kısa ve net ol.');
}

// ==================== ÇEK SORGULAMA (GELİŞTİRİLMİŞ) ====================
async function queryChecks(question) {
  const q = question.toLowerCase();
  let results = [];
  let context = '';

  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  // YAKLAŞAN ÇEKLER
  if (q.includes('yakın') || q.includes('yaklaşan') || q.includes('bu hafta') || q.includes('ödenmesi gereken')) {
    const { data } = await supabase.from('checks').select('*')
      .gte('vade', today).lte('vade', nextWeek)
      .order('vade', { ascending: true });
    if (data && data.length > 0) {
      results = data;
      context = `BU HAFTA VADESİ DOLAN ÇEKLER (${today} - ${nextWeek}):\n`;
    } else {
      // Bu hafta yoksa bu ay bak
      const { data: aylik } = await supabase.from('checks').select('*')
        .gte('vade', today).lte('vade', nextMonth)
        .order('vade', { ascending: true });
      if (aylik) results = aylik;
      context = `ÖNÜMÜZDEKI 30 GÜNDE VADESİ DOLAN ÇEKLER:\n`;
    }
  }
  // GECİKMİŞ ÇEKLER
  else if (q.includes('gecik') || q.includes('geçmiş') || q.includes('ödenmemiş')) {
    const { data } = await supabase.from('checks').select('*')
      .lt('vade', today)
      .eq('durum_aciklama', 'Portföyde')
      .order('vade', { ascending: true });
    if (data) results = data;
    context = `VADESİ GEÇMİŞ PORTFÖYDEKI ÇEKLER:\n`;
  }
  // PORTFÖY ÖZETİ
  else if (q.includes('portföy') || q.includes('toplam') || q.includes('özet') || q.includes('durum')) {
    const { data } = await supabase.from('checks').select('*');
    if (data) {
      results = data;
      const portfoy = data.filter(r => r.durum_aciklama === 'Portföyde');
      const tahsil = data.filter(r => r.durum_aciklama && r.durum_aciklama.includes('Tahsil'));
      const toplamPortfoy = portfoy.reduce((s, r) => s + (r.tutar || 0), 0);
      const toplamTahsil = tahsil.reduce((s, r) => s + (r.tutar || 0), 0);
      context = `ÇEK/SENET PORTFÖY ÖZETİ:\nToplam çek sayısı: ${data.length}\nPortföyde: ${portfoy.length} adet - ${toplamPortfoy} TL\nTahsilde: ${tahsil.length} adet - ${toplamTahsil} TL\nToplam: ${toplamPortfoy + toplamTahsil} TL\n\nVADESİ EN YAKIN 5 ÇEK:\n`;
      const yakinlar = portfoy.filter(r => r.vade >= today).sort((a, b) => a.vade > b.vade ? 1 : -1).slice(0, 5);
      context += yakinlar.map((r, i) =>
        `${i + 1}. ${r.borclu} | Vade: ${r.vade} | Tutar: ${r.tutar} ${r.doviz}`
      ).join('\n');
      return await askClaude(question, context, 'Sen finans asistanısın. Çek portföy özetini düzgün göster. Sayıları Türk formatında göster. Emoji: 📅 vade, ✅ portföy, 🏦 tahsil.');
    }
  }
  // FİRMA BAZLI
  else {
    const searchTerm = question.replace(/çek|senet|vade|portföy|tahsil/gi, '').trim();
    if (searchTerm) {
      const { data } = await supabase.from('checks').select('*')
        .or(`borclu.ilike.%${searchTerm}%,cari_hesap.ilike.%${searchTerm}%,seri_no.ilike.%${searchTerm}%`)
        .order('vade', { ascending: true }).limit(15);
      if (data && data.length > 0) results = data;
    }
    if (results.length === 0) {
      const { data } = await supabase.from('checks').select('*')
        .gte('vade', today).order('vade', { ascending: true }).limit(15);
      if (data) results = data;
      context = `VADESİ YAKLAŞAN ÇEKLER:\n`;
    }
  }

  if (!context) context = '';
  context += results.map((r, i) =>
    `${i + 1}. ${r.borclu || '-'} | Durum: ${r.durum_aciklama || r.durum_kodu} | Seri: ${r.seri_no} | Vade: ${r.vade} | Tutar: ${r.tutar} ${r.doviz}`
  ).join('\n');

  if (results.length === 0) return '📅 Belirtilen kriterlerde çek bulunamadı.';

  return await askClaude(question, context,
    'Sen finans asistanısın. Çek bilgilerini tarih sırasıyla listele. Vadesi 7 gün içinde olanları ⚠️ ile işaretle. Sayıları Türk formatında göster. Kısa ve net ol.');
}

// ==================== SATIŞ SORGULAMA ====================
async function querySales(question) {
  const q = question.toLowerCase();
  let results = [];

  if (q.includes('en karlı') || q.includes('en iyi')) {
    const { data } = await supabase.from('sales').select('*')
      .eq('satir_tipi', 'fatura').order('kar_yuzde', { ascending: false }).limit(10);
    if (data) results = data;
  } else {
    const searchTerm = question.replace(/satış|karlılık|kar|en\s*karlı|ne\s*kadar/gi, '').trim();
    if (searchTerm) {
      const { data } = await supabase.from('sales').select('*')
        .eq('satir_tipi', 'fatura')
        .or(`cari_unvan.ilike.%${searchTerm}%,fatura_no.ilike.%${searchTerm}%`)
        .order('tarih', { ascending: false }).limit(15);
      if (data && data.length > 0) results = data;
    }
    if (results.length === 0) {
      const { data } = await supabase.from('sales').select('*')
        .eq('satir_tipi', 'fatura').order('tarih', { ascending: false }).limit(10);
      if (data) results = data;
    }
  }

  const context = results.map((r, i) =>
    `${i + 1}. Tarih: ${r.tarih} | Firma: ${r.cari_unvan} | Toplam: ${r.toplam_tutar} TL | Maliyet: ${r.maliyet} TL | Kar: ${r.kar_toplam} TL | Kar%: ${r.kar_yuzde ? Number(r.kar_yuzde).toFixed(1) : '-'}%`
  ).join('\n');

  return await askClaude(question, context,
    'Sen satış analiz asistanısın. Satış ve karlılık bilgilerini düzgün listele. Sayıları Türk formatında göster. Kısa ve net ol.');
}

// ==================== YARDIMCI ====================
function extractNumber(text) {
  const m = text.match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function detectIntent(text) {
  const t = text.toLowerCase();
  const scores = {
    stok: ['stok', 'depo', 'var mı', 'kaldı', 'kaç ton', 'kaç kg', 'gsm', 'glasin', 'kraft', 'fluting', 'kağıt', 'karton', 'rulo', 'palet', 'pof', 'bopp', 'film', 'shrink', 'mikron'].filter(k => t.includes(k)).length,
    cari: ['cari', 'bakiye', 'borç', 'alacak', 'firma', 'müşteri', 'tedarikçi', 'hesap', 'ünvan', 'en borçlu', 'bize borçlu', 'ilk 5', 'ilk 10'].filter(k => t.includes(k)).length,
    fatura: ['fatura', 'irsaliye', 'kesilen', 'son fatura'].filter(k => t.includes(k)).length,
    cek: ['çek', 'senet', 'vade', 'portföy', 'tahsil', 'ciro', 'ödenmesi', 'yaklaşan'].filter(k => t.includes(k)).length,
    satis: ['satış', 'karlılık', 'kar', 'kâr', 'en karlı', 'margin', 'maliyet'].filter(k => t.includes(k)).length
  };
  const max = Math.max(...Object.values(scores));
  if (max === 0) return 'general';
  return Object.entries(scores).find(([, v]) => v === max)[0];
}

// ==================== MAIN WEBHOOK ====================
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, msg: 'OpenClaw bot running' });

  try {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (isGroup && !text.startsWith('/') && !text.toLowerCase().includes('@')) {
      return res.status(200).json({ ok: true });
    }

    const cleanText = text.replace(/@\w+/g, '').replace(/^\/\w+\s*/, '').trim();
    const command = text.split(' ')[0].split('@')[0].toLowerCase();

    const user = await getOrCreateUser(msg.from);
    if (!user || !user.is_active) {
      await send(chatId, '🚫 Erişim yetkiniz yok.');
      return res.status(200).json({ ok: true });
    }

    // START ve HELP limitsiz
    if (command === '/start') {
      const response = `🤖 Merhaba ${user.full_name}!\n\nBen *OpenClaw*, Napol Global şirket asistanıyım.\n\n📦 /stok — Stok sorgula\n🏢 /cari — Cari hesap sorgula\n📄 /fatura — Fatura sorgula\n📅 /cek — Çek/senet sorgula\n📊 /satis — Satış karlılık sorgula\n📋 /limit — Günlük limit durumu\n❓ /yardim — Yardım\n\nYa da doğrudan sorunuzu yazın!\n\n_Örnek: "en borçlu 5 firma" veya "vadesi yaklaşan çekler"_`;
      await send(chatId, response);
      await logQuery(msg.from.id, 'start', text, response);
      return res.status(200).json({ ok: true });
    }

    if (command === '/yardim' || command === '/help') {
      const response = `📋 *OpenClaw Kullanım Rehberi*\n\n🏢 *Cari Sorgulama:*\n/cari Ağaoğlu — firma ara\n"en borçlu 5 firma"\n"toplam borcumuz ne kadar"\n"cari genel durum"\n\n📦 *Stok:*\n/stok glasin\n"depoda POF var mı"\n\n📅 *Çek/Senet:*\n/cek — vadesi yaklaşanlar\n"bu hafta ödenmesi gereken çekler"\n"çek portföy özeti"\n"gecikmiş çekler"\n\n📄 *Fatura:*\n/fatura Gelişim\n"son faturalar"\n\n📊 *Satış:*\n"en karlı satışlar"\n\n📋 /limit — günlük limit durumu`;
      await send(chatId, response);
      await logQuery(msg.from.id, 'help', text, response);
      return res.status(200).json({ ok: true });
    }

    if (command === '/limit') {
      const daily = await checkDailyLimit(msg.from.id);
      const monthly = await checkMonthlyBudget();
      const response = `📋 *Limit Durumu*\n\n👤 Günlük: ${DAILY_LIMIT - daily.remaining}/${DAILY_LIMIT} soru kullanıldı (${daily.remaining} kaldı)\n💰 Aylık bütçe: ~$${monthly.spent} / $${MONTHLY_BUDGET_USD}`;
      await send(chatId, response);
      return res.status(200).json({ ok: true });
    }

    // LIMIT KONTROL
    const dailyCheck = await checkDailyLimit(msg.from.id);
    if (!dailyCheck.ok) {
      await send(chatId, `⚠️ Günlük soru limitinize ulaştınız (${DAILY_LIMIT}). Yarın tekrar deneyebilirsiniz.`);
      return res.status(200).json({ ok: true });
    }

    const budgetCheck = await checkMonthlyBudget();
    if (!budgetCheck.ok) {
      await send(chatId, `⚠️ Aylık API bütçesi doldu ($${MONTHLY_BUDGET_USD}). Yöneticinize başvurun.`);
      return res.status(200).json({ ok: true });
    }

    // SORGULAR
    let response = '';
    let qType = 'general';

    if (command === '/stok') {
      if (!hasPerm(user, 'stok')) response = '🚫 Stok sorgulama yetkiniz yok.';
      else if (!cleanText) response = '📦 Ne sorgulayayım?\nÖrnek: /stok glasin';
      else { await typing(chatId); response = await queryStock(cleanText); }
      qType = 'stok';
    }
    else if (command === '/cari') {
      if (!hasPerm(user, 'cari')) response = '🚫 Cari sorgulama yetkiniz yok.';
      else if (!cleanText) response = '🏢 Hangi firma?\nÖrnek: /cari Ağaoğlu\nÖrnek: "en borçlu 5 firma"';
      else { await typing(chatId); response = await queryAccounts(cleanText); }
      qType = 'cari';
    }
    else if (command === '/fatura') {
      if (!hasPerm(user, 'fatura')) response = '🚫 Fatura yetkiniz yok.';
      else { await typing(chatId); response = await queryInvoices(cleanText || 'son faturalar'); }
      qType = 'fatura';
    }
    else if (command === '/cek') {
      if (!hasPerm(user, 'cek')) response = '🚫 Çek sorgulama yetkiniz yok.';
      else { await typing(chatId); response = await queryChecks(cleanText || 'vadesi yaklaşan çekler'); }
      qType = 'cek';
    }
    else if (command === '/satis') {
      if (!hasPerm(user, 'satis')) response = '🚫 Satış yetkiniz yok.';
      else { await typing(chatId); response = await querySales(cleanText || 'son satışlar'); }
      qType = 'satis';
    }
    else {
      await typing(chatId);
      const intent = detectIntent(text);
      if (intent === 'stok' && hasPerm(user, 'stok')) { response = await queryStock(text); qType = 'stok'; }
      else if (intent === 'cari' && hasPerm(user, 'cari')) { response = await queryAccounts(text); qType = 'cari'; }
      else if (intent === 'fatura' && hasPerm(user, 'fatura')) { response = await queryInvoices(text); qType = 'fatura'; }
      else if (intent === 'cek' && hasPerm(user, 'cek')) { response = await queryChecks(text); qType = 'cek'; }
      else if (intent === 'satis' && hasPerm(user, 'satis')) { response = await querySales(text); qType = 'satis'; }
      else { response = await askClaude(text, null, null); qType = 'general'; }
    }

    await send(chatId, response);
    await logQuery(msg.from.id, qType, text, response);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(200).json({ ok: true });
  }
};
