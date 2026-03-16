const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// ==================== CONFIG ====================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ==================== TELEGRAM HELPERS ====================
async function send(chatId, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
    }).catch(() => {
      // Markdown parse hatası olursa düz metin gönder
      fetch(`${TG}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
    });
  }
}

async function typing(chatId) {
  await fetch(`${TG}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  } catch (e) {
    console.error('Auth error:', e);
    return null;
  }
}

function hasPerm(user, perm) {
  if (!user || !user.is_active) return false;
  if (user.role === 'admin') return true;
  return user.permissions && user.permissions.includes(perm);
}

// ==================== CLAUDE AI ====================
async function askClaude(question, context, systemPrompt) {
  const defaultSystem = `Sen OpenClaw, Napol Global şirketinin AI asistanısın.
Kağıt, ambalaj ve medikal ambalaj sektöründe faaliyet gösteren bir üretim/ticaret şirketinde çalışıyorsun.
Türkçe cevap ver. Kısa, net ve profesyonel ol.
Eğer verilen veride cevap yoksa "Bu bilgiyi bulamadım" de.
Asla uydurma bilgi verme.
Sayıları binlik ayraçlı göster (örn: 1.234.567,89 TL).
Bakiye negatifse "borçlu olduğunuz", pozitifse "size borçlu" demek.`;

  try {
    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt || defaultSystem,
      messages: [{
        role: 'user',
        content: context ? `Şirket verileri:\n${context}\n\nSoru: ${question}` : question
      }]
    });
    return response.content[0].text;
  } catch (error) {
    console.error('Claude error:', error);
    return 'Bir hata oluştu, lütfen tekrar deneyin.';
  }
}

// ==================== LOGGER ====================
async function logQuery(telegramId, queryType, queryText, responseText) {
  try {
    await supabase.from('query_logs').insert({
      user_id: telegramId,
      query_type: queryType,
      query_text: queryText,
      response_text: responseText ? responseText.substring(0, 2000) : null
    });
  } catch (e) { console.error('Log error:', e); }
}

// ==================== STOK SORGULAMA ====================
async function queryStock(question) {
  const searchTerm = question.replace(/stok|depo|var\s*mı|kaç|ne\s*kadar|kaldı\s*mı/gi, '').trim();
  let results = [];

  if (searchTerm) {
    const { data } = await supabase.from('stock').select('*')
      .or(`aciklama.ilike.%${searchTerm}%,kart_kodu.ilike.%${searchTerm}%,grup_kodu.ilike.%${searchTerm}%`)
      .limit(20);
    if (data && data.length > 0) results = data;
  }

  if (results.length === 0 && searchTerm) {
    const words = searchTerm.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const { data } = await supabase.from('stock').select('*').ilike('aciklama', `%${word}%`).limit(20);
      if (data && data.length > 0) { results = data; break; }
    }
  }

  if (results.length === 0) return '📦 Bu ürünü stokta bulamadım. Ürün adını kontrol edip tekrar dener misin?';

  const context = results.map(r =>
    `Ürün: ${r.aciklama} | Kod: ${r.kart_kodu || '-'} | Fiili Stok: ${r.fiili_stok} ${r.ana_birim || ''} | Gerçek Stok: ${r.gercek_stok} | Grup: ${r.grup_kodu || '-'} | Maliyet: ${r.birim_maliyet || '-'}`
  ).join('\n');

  return await askClaude(question, context,
    'Sen bir depo stok asistanısın. Kısa ve net cevap ver. Stok varsa miktarı ve birimi belirt. Emoji: 📦 var, ⚠️ az, ❌ yok. Türkçe cevap ver.');
}

// ==================== CARİ SORGULAMA ====================
async function queryAccounts(question) {
  const searchTerm = question.replace(/cari|hesap|bakiye|borç|alacak|ne\s*kadar|nedir|var\s*mı|sorgula/gi, '').trim();
  let results = [];

  if (searchTerm) {
    const { data } = await supabase.from('accounts').select('*')
      .or(`unvan.ilike.%${searchTerm}%,cari_kodu.ilike.%${searchTerm}%,aciklama.ilike.%${searchTerm}%`)
      .order('bakiye', { ascending: true }).limit(10);
    if (data && data.length > 0) results = data;
  }

  if (results.length === 0 && searchTerm) {
    const words = searchTerm.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const { data } = await supabase.from('accounts').select('*')
        .or(`unvan.ilike.%${word}%,aciklama.ilike.%${word}%`).limit(10);
      if (data && data.length > 0) { results = data; break; }
    }
  }

  if (results.length === 0) return '🏢 Bu firmayı bulamadım. Firma adını kontrol edip tekrar dener misin?';

  const context = results.map(r =>
    `Firma: ${r.unvan} | Kodu: ${r.cari_kodu || '-'} | Kısa Ad: ${r.aciklama || '-'} | Bakiye: ${r.bakiye} TL | B/A: ${r.borc_alacak || '-'} | Tel: ${r.telefon || '-'} | Şehir: ${r.sehir || '-'}`
  ).join('\n');

  return await askClaude(question, context,
    `Sen bir muhasebe asistanısın. Cari hesap bilgilerini kısa ve net özetle.
Bakiye negatifse: "Bu firmaya X TL borcunuz var" de.
Bakiye pozitifse: "Bu firma size X TL borçlu" de.
Bakiye 0 ise: "Bu firmayla bakiye denk" de.
Sayıları binlik ayraçlı göster. Emoji: 💰 alacak, 🔴 borç, ✅ denk. Türkçe cevap ver.`);
}

// ==================== FATURA SORGULAMA ====================
async function queryInvoices(question) {
  const searchTerm = question.replace(/fatura|kaç|ne\s*kadar|listele|son|göster/gi, '').trim();
  let results = [];

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

  const context = results.map(r =>
    `Tarih: ${r.tarih} | Firma: ${r.cari_firma} | Fatura No: ${r.fatura_no} | Toplam: ${r.toplam_tl} TL | Genel Toplam: ${r.genel_toplam_tl} TL | Tür: ${r.fatura_turu || '-'}`
  ).join('\n');

  return await askClaude(question, context,
    'Sen bir muhasebe asistanısın. Fatura bilgilerini kısa ve net özetle. Sayıları binlik ayraçlı göster. Türkçe cevap ver.');
}

// ==================== ÇEK SORGULAMA ====================
async function queryChecks(question) {
  const searchTerm = question.replace(/çek|senet|vade|portföy|tahsil/gi, '').trim();
  let results = [];

  if (searchTerm) {
    const { data } = await supabase.from('checks').select('*')
      .or(`borclu.ilike.%${searchTerm}%,cari_hesap.ilike.%${searchTerm}%,seri_no.ilike.%${searchTerm}%`)
      .order('vade', { ascending: true }).limit(15);
    if (data && data.length > 0) results = data;
  }

  if (results.length === 0) {
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase.from('checks').select('*')
      .gte('vade', today).order('vade', { ascending: true }).limit(15);
    if (data && data.length > 0) results = data;
    else {
      const { data: all } = await supabase.from('checks').select('*')
        .order('vade', { ascending: false }).limit(15);
      if (all) results = all;
    }
  }

  const context = results.map(r =>
    `Tür: ${r.turu} | Durum: ${r.durum_aciklama || r.durum_kodu} | Seri: ${r.seri_no} | Vade: ${r.vade} | Borçlu: ${r.borclu} | Tutar: ${r.tutar} ${r.doviz}`
  ).join('\n');

  return await askClaude(question, context,
    'Sen bir finans asistanısın. Çek/senet bilgilerini kısa ve net özetle. Vadesi yaklaşanları vurgula. Emoji: 📅 vade yakın, ✅ portföyde, 🏦 tahsilde. Türkçe cevap ver.');
}

// ==================== SATIŞ SORGULAMA ====================
async function querySales(question) {
  const searchTerm = question.replace(/satış|karlılık|kar|en\s*karlı|ne\s*kadar/gi, '').trim();
  let results = [];

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

  const context = results.map(r =>
    `Tarih: ${r.tarih} | Firma: ${r.cari_unvan} | Fatura: ${r.fatura_no} | Toplam: ${r.toplam_tutar} TL | Maliyet: ${r.maliyet} TL | Kar: ${r.kar_toplam} TL | Kar%: ${r.kar_yuzde ? Number(r.kar_yuzde).toFixed(1) : '-'}%`
  ).join('\n');

  return await askClaude(question, context,
    'Sen bir satış analiz asistanısın. Satış ve karlılık bilgilerini kısa ve net özetle. Sayıları binlik ayraçlı göster. Türkçe cevap ver.');
}

// ==================== INTENT DETECTION ====================
function detectIntent(text) {
  const t = text.toLowerCase();
  const scores = {
    stok: ['stok', 'depo', 'var mı', 'kaldı', 'kaç ton', 'kaç kg', 'gsm', 'glasin', 'kraft', 'fluting', 'kağıt', 'karton', 'rulo', 'palet', 'lot', 'pof', 'bopp', 'film', 'shrink', 'mikron'].filter(k => t.includes(k)).length,
    cari: ['cari', 'bakiye', 'borç', 'alacak', 'firma', 'müşteri', 'tedarikçi', 'hesap', 'ünvan'].filter(k => t.includes(k)).length,
    fatura: ['fatura', 'irsaliye', 'kesilen', 'kestiğimiz', 'satış fatura', 'alış fatura'].filter(k => t.includes(k)).length,
    cek: ['çek', 'senet', 'vade', 'portföy', 'tahsil', 'ciro'].filter(k => t.includes(k)).length,
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

    let response = '';
    let qType = 'general';

    if (command === '/start') {
      response = `🤖 Merhaba ${user.full_name}!\n\nBen OpenClaw, Napol Global şirket asistanıyım.\n\n📦 /stok — Stok sorgula\n🏢 /cari — Cari hesap sorgula\n📄 /fatura — Fatura sorgula\n📅 /cek — Çek/senet sorgula\n📊 /satis — Satış karlılık sorgula\n❓ /yardim — Yardım\n\nYa da doğrudan sorunuzu yazın!`;
      qType = 'start';
    }
    else if (command === '/yardim' || command === '/help') {
      response = `📋 *OpenClaw Kullanım Rehberi*\n\n📦 /stok glasin\n🏢 /cari Ağaoğlu\n📄 /fatura Gelişim\n📅 /cek Arteks\n📊 /satis FPS\n\nKomut olmadan da soru sorabilirsiniz!\nÖrn: "depoda POF var mı?" veya "Bebiller bakiyesi ne?"`;
      qType = 'help';
    }
    else if (command === '/stok') {
      if (!hasPerm(user, 'stok')) response = '🚫 Stok sorgulama yetkiniz yok.';
      else if (!cleanText) response = '📦 Ne sorgulayayım?\nÖrnek: /stok glasin';
      else { await typing(chatId); response = await queryStock(cleanText); }
      qType = 'stok';
    }
    else if (command === '/cari') {
      if (!hasPerm(user, 'cari')) response = '🚫 Cari sorgulama yetkiniz yok.';
      else if (!cleanText) response = '🏢 Hangi firma?\nÖrnek: /cari Ağaoğlu';
      else { await typing(chatId); response = await queryAccounts(cleanText); }
      qType = 'cari';
    }
    else if (command === '/fatura') {
      if (!hasPerm(user, 'fatura')) response = '🚫 Fatura sorgulama yetkiniz yok.';
      else { await typing(chatId); response = await queryInvoices(cleanText || 'son faturalar'); }
      qType = 'fatura';
    }
    else if (command === '/cek') {
      if (!hasPerm(user, 'cek')) response = '🚫 Çek sorgulama yetkiniz yok.';
      else { await typing(chatId); response = await queryChecks(cleanText || 'vadesi yaklaşan çekler'); }
      qType = 'cek';
    }
    else if (command === '/satis') {
      if (!hasPerm(user, 'satis')) response = '🚫 Satış sorgulama yetkiniz yok.';
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
