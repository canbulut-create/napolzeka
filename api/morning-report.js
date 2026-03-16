const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendTG(chatId, text) {
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

function formatMoney(n) {
  if (n === null || n === undefined) return '0';
  return Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

module.exports = async function handler(req, res) {
  // Güvenlik: sadece Vercel Cron veya secret ile çağrılabilir
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET || 'openclaw-sabah-2026';
  
  if (authHeader !== `Bearer ${cronSecret}` && req.headers['x-vercel-cron'] !== '1') {
    // Manuel tetikleme için query param da kabul et
    if (req.query.secret !== cronSecret) {
      return res.status(401).json({ error: 'Yetkisiz' });
    }
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const next3days = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    const next7days = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    let report = `🌅 *GÜNLÜK SABAH RAPORU*\n📅 ${today}\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    // 1. BUGÜN VADESİ DOLAN ÇEKLER
    const { data: bugunCekler } = await supabase.from('checks').select('*')
      .eq('vade', today).order('tutar', { ascending: false });

    if (bugunCekler && bugunCekler.length > 0) {
      const toplamBugun = bugunCekler.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `🔴 *BUGÜN VADESİ DOLAN ÇEKLER (${bugunCekler.length} adet)*\n`;
      report += `Toplam: ${formatMoney(toplamBugun)} TL\n\n`;
      bugunCekler.forEach((r, i) => {
        report += `${i + 1}. ${r.borclu || '-'}\n   ${formatMoney(r.tutar)} ${r.doviz} | ${r.durum_aciklama || r.durum_kodu} | Seri: ${r.seri_no}\n`;
      });
      report += `\n`;
    } else {
      report += `✅ Bugün vadesi dolan çek yok.\n\n`;
    }

    // 2. YARIN VADESİ DOLAN ÇEKLER
    const { data: yarinCekler } = await supabase.from('checks').select('*')
      .eq('vade', tomorrow).order('tutar', { ascending: false });

    if (yarinCekler && yarinCekler.length > 0) {
      const toplamYarin = yarinCekler.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `⚠️ *YARIN VADESİ DOLACAK (${yarinCekler.length} adet)*\n`;
      report += `Toplam: ${formatMoney(toplamYarin)} TL\n\n`;
      yarinCekler.forEach((r, i) => {
        report += `${i + 1}. ${r.borclu || '-'} — ${formatMoney(r.tutar)} ${r.doviz}\n`;
      });
      report += `\n`;
    }

    // 3. ÖNÜMÜZDEKI 3 GÜN
    const { data: ucGun } = await supabase.from('checks').select('*')
      .gt('vade', tomorrow).lte('vade', next3days).order('vade', { ascending: true });

    if (ucGun && ucGun.length > 0) {
      const toplamUcGun = ucGun.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `📅 *3 GÜN İÇİNDE (${ucGun.length} adet)*\n`;
      report += `Toplam: ${formatMoney(toplamUcGun)} TL\n\n`;
      ucGun.forEach((r, i) => {
        report += `${i + 1}. ${r.vade} | ${r.borclu || '-'} — ${formatMoney(r.tutar)} ${r.doviz}\n`;
      });
      report += `\n`;
    }

    // 4. HAFTALIK ÖZET
    const { data: haftaCekler } = await supabase.from('checks').select('*')
      .gte('vade', today).lte('vade', next7days);

    if (haftaCekler && haftaCekler.length > 0) {
      const toplamHafta = haftaCekler.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `📊 *7 GÜNLÜK TOPLAM: ${formatMoney(toplamHafta)} TL (${haftaCekler.length} çek)*\n\n`;
    }

    // 5. GECİKMİŞ ÇEKLER
    const { data: gecikmis } = await supabase.from('checks').select('*')
      .lt('vade', today).eq('durum_aciklama', 'Portföyde')
      .order('vade', { ascending: true });

    if (gecikmis && gecikmis.length > 0) {
      const toplamGecik = gecikmis.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `🚨 *VADESİ GEÇMİŞ PORTFÖYDE (${gecikmis.length} adet)*\n`;
      report += `Toplam: ${formatMoney(toplamGecik)} TL\n\n`;
      gecikmis.slice(0, 5).forEach((r, i) => {
        report += `${i + 1}. ${r.vade} | ${r.borclu || '-'} — ${formatMoney(r.tutar)} ${r.doviz}\n`;
      });
      if (gecikmis.length > 5) report += `   ... ve ${gecikmis.length - 5} çek daha\n`;
      report += `\n`;
    }

    // 6. PORTFÖY ÖZETİ
    const { data: tumCekler } = await supabase.from('checks').select('*');
    if (tumCekler) {
      const portfoy = tumCekler.filter(r => r.durum_aciklama === 'Portföyde');
      const toplamPortfoy = portfoy.reduce((s, r) => s + (r.tutar || 0), 0);
      report += `━━━━━━━━━━━━━━━━━━━━━━\n`;
      report += `💼 Portföy: ${portfoy.length} çek — ${formatMoney(toplamPortfoy)} TL\n`;
      report += `📋 Toplam: ${tumCekler.length} çek/senet\n`;
    }

    report += `\n_OpenClaw — Napol Global AI Asistan_`;

    // Admin'lere gönder
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    
    for (const adminId of adminIds) {
      await sendTG(adminId, report);
    }

    return res.status(200).json({ ok: true, sent_to: adminIds.length, report_length: report.length });
  } catch (error) {
    console.error('Morning report error:', error);
    return res.status(500).json({ error: error.message });
  }
};
