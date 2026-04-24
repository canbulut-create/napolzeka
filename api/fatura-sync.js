module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
  try {
    const r = await fetch(
      'https://lsxvskcdbppslpxaixky.supabase.co/functions/v1/dia-sync?mod=gunluk',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
    );
    const d = await r.json();
    return res.status(200).json(d);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};