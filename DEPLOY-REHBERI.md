# NapolZeka Rapor v2 — Faz 1 Deploy Rehberi

Bu pakette, **NapolZeka — Veri İşleme ve Raporlama Yeniden Tasarımı** spec'inin
Faz 1 (temel atma) çıktısı var: yeni Supabase tablo/sütun/view'lar,
spec formatına uyumlu çalışan günlük + haftalık rapor, TCMB kur fetcher
ve güncel cron yapılandırması.

## Bu pakette ne var?

```
yeni/
├── migrations/
│   └── 20260526_napol_rapor_v2.sql   # Supabase migration (sütun + tablo + view)
├── api/
│   ├── daily-report.js                # Pzt-Cum 18:00 TR günlük rapor
│   ├── weekly-report.js               # Cmt 10:00 TR haftalık rapor
│   └── tcmb-sync.js                   # TCMB günlük kur (Pzt-Cum 09:00 TR)
├── vercel.json                        # Güncellenmiş cron listesi
└── DEPLOY-REHBERI.md                  # (bu dosya)
```

## Faz 1 ne yapıyor, ne yapmıyor?

| Konu | Durum |
|------|-------|
| NPE prefix sınıflandırma | Zaten mevcut (`dia_karlilik_raporu.fatura_tipi` generated column) |
| Günlük rapor — spec formatı | Çalışıyor |
| Haftalık rapor — spec formatı | Çalışıyor |
| Maliyet eksik uyarısı | Çalışıyor (`maliyetsiz_mi` flag'inden) |
| Defter kârı (Kâr 2) | Hesaplanıyor (`dia_karlilik_raporu.kar` kullanılıyor) |
| **Güncel kur ile kâr (Kâr 1)** | **Faz 2** — kalem sync + stok ek_alan_1 + TCMB kuru gerekli |
| **Kur farkı etkisi** | **Faz 2** — Kâr 1 hesaplandıktan sonra otomatik |
| TCMB günlük kur çekme | Çalışıyor (`tcmb_kurlar` tablosuna yazıyor) |
| Stok ek_alan_1 / ek_alan_2 sync | **Faz 2** — `dia-sync.js`'e eklenecek |
| Fatura kalemleri (satır) sync | **Faz 2** — DIA `scf_faturadetay_listele` (veya muadili) endpoint'i lazım |
| dia_karlilik_raporu güncelliği | **Manuel** — şu an son satır 30 Nisan; SCF2240A çağrısı elle tetiklenmeli (Faz 2'de otomatize edilecek) |

> Faz 1 raporu çalıştığında **"Kâr (güncel kur): — (kalem sync bekleniyor)"** satırı görünecek.
> Bu, formatın spec'le aynı olduğunu ama kalem verisi henüz olmadığını gösteren bilinçli bir placeholder.

---

## Adım 1 — GitHub'a push

`yeni/` klasörü altındaki dosyaları `napolzeka` repo'sunda **şu konumlara** kopyala:

| Kaynak | Hedef |
|--------|-------|
| `yeni/api/daily-report.js` | `api/daily-report.js` (mevcut bozuk dosyanın üzerine yaz) |
| `yeni/api/weekly-report.js` | `api/weekly-report.js` (yeni) |
| `yeni/api/tcmb-sync.js` | `api/tcmb-sync.js` (yeni) |
| `yeni/vercel.json` | `vercel.json` (mevcudun üzerine yaz) |
| `yeni/migrations/20260526_napol_rapor_v2.sql` | `migrations/20260526_napol_rapor_v2.sql` (yeni, sürüm kontrolü için) |

Commit mesajı önerisi:
```
feat: Rapor v2 Faz 1 — günlük/haftalık rapor, TCMB sync, yeni cronlar

- api/daily-report.js: sıfırdan, spec formatında, defter kârı çalışır
- api/weekly-report.js: yeni, Cmt 10:00 TR haftalık rapor
- api/tcmb-sync.js: yeni, TCMB günlük USD/EUR efektif satış
- vercel.json: yeni cronlar (tcmb 06, daily 15, weekly Cmt 07 UTC)
- Supabase migration: ek_alan sütunları, tcmb_kurlar, fatura_kalemleri iskeleti, kâr view'ları
```

---

## Adım 2 — Supabase migration uygula

İki seçenek:

**A) Supabase SQL Editor (önerilen, manuel)**
1. https://supabase.com/dashboard/project/lsxvskcdbppslpxaixky/sql aç
2. `migrations/20260526_napol_rapor_v2.sql` içeriğini yapıştır
3. "Run" → tüm `CREATE / ALTER` komutları idempotent (IF NOT EXISTS / OR REPLACE)

**B) Cowork'e ricada bulun** (bu oturumda burada): Claude migration'ı MCP üzerinden uygulayabilir.

Migration sonrası beklenen yapı:
- `dia_stoklar` tablosunda `ek_alan_1`, `ek_alan_1_doviz`, `ek_alan_2` sütunları
- Yeni tablolar: `tcmb_kurlar`, `dia_fatura_kalemleri`
- Yeni view'lar: `vw_gunluk_satis_karlilik`, `vw_gunluk_alis`, `vw_haftalik_satis_karlilik`, `vw_haftalik_alis_ozet`

---

## Adım 3 — Vercel env değişkenleri

Vercel → `napolzeka` projesi → Settings → Environment Variables.

**Yeni eklenecek:**
| İsim | Değer | Açıklama |
|------|-------|----------|
| `CRON_SECRET` | rastgele uzun string (örn. `openssl rand -hex 32`) | Cron endpoint'lerinin auth'u. Üç yeni endpoint de bunu kontrol eder. |

**Var olduğunu varsaydığımız (kontrol edin):**
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` (veya `SUPABASE_KEY`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (Can'ın Telegram ID'si)
- `ADMIN_TELEGRAM_IDS` (opsiyonel, virgülle ayrılmış)
- `DIA_SERVER`, `DIA_USERNAME`, `DIA_PASSWORD`, `DIA_API_KEY`, `DIA_FIRMA`, `DIA_DONEM`

Değişiklikten sonra **Redeploy** gerekir (env değişiklik anında yansımıyor).

---

## Adım 4 — Manuel test (deploy sonrası)

`<CRON_SECRET>` yerine ayarladığın değeri koy. URL'ler yeni deployment URL'inde:

```bash
# 1) TCMB kuru çek (önce bunu çalıştır — diğer testler için fallback hazır olsun)
curl -X GET 'https://napolzeka.vercel.app/api/tcmb-sync' \
  -H 'Authorization: Bearer <CRON_SECRET>'

# 2) Günlük raporu DRY RUN ile dene (Telegram'a göndermez, response'ta metni döner)
curl 'https://napolzeka.vercel.app/api/daily-report?dry=1' \
  -H 'Authorization: Bearer <CRON_SECRET>'

# 3) Belirli bir tarih için günlük rapor (test için)
curl 'https://napolzeka.vercel.app/api/daily-report?tarih=2026-04-30&dry=1' \
  -H 'Authorization: Bearer <CRON_SECRET>'

# 4) Geçen haftanın haftalık raporu (DRY RUN)
curl 'https://napolzeka.vercel.app/api/weekly-report?dry=1' \
  -H 'Authorization: Bearer <CRON_SECRET>'

# 5) Belirli aralık için (test) — 20-24 Mayıs örneği gibi
curl 'https://napolzeka.vercel.app/api/weekly-report?pzt=2026-04-27&cum=2026-05-01&dry=1' \
  -H 'Authorization: Bearer <CRON_SECRET>'
```

DRY çıktısı tatmin ediciyse, `?dry=1` parametresini çıkararak gerçek bir test gönderimi yapabilirsin (Telegram'a düşer).

---

## Adım 5 — Cron yapılandırması

`vercel.json` push edildiğinde Vercel cron'ları otomatik günceller.

**Yeni durum:**

| Path | Schedule (UTC) | TR Saati | Görev |
|------|----------------|----------|-------|
| `/api/tcmb-sync` | `0 6 * * 1-5` | Pzt-Cum 09:00 | TCMB kur çek |
| `/api/fatura-sync` | `0 14 * * 1-6` | Pzt-Cmt 17:00 | DIA fatura sync (mevcut) |
| `/api/daily-report` | `0 15 * * 1-5` | Pzt-Cum 18:00 | **Yeni günlük rapor** |
| `/api/weekly-report` | `0 7 * * 6` | Cmt 10:00 | **Yeni haftalık rapor** |
| `/api/haftalik-sync` | `0 23 * * 0` | Pzt 02:00 | Cari/çek sync (mevcut) |

> Mevcut `fatura-sync` cron'u korundu ama saati 19:00 TR'den **17:00 TR'ye** çekildi
> ki yeni 18:00 raporundan önce çalışsın. Bu sync hâlâ Supabase edge function'a
> bir özet mesajı atıyor. Eğer yeni raporla çakıştığını düşünüyorsan:
> - Cron'u `vercel.json`'dan kaldırabilirsin (dia_faturalar tablosu güncel kalmaz)
> - Veya Supabase edge function'a `?notify=0` parametresi eklemek için kodu değiştirebilirsin (Faz 2)

---

## Adım 6 — dia_karlilik_raporu güncelliği

**Önemli kısıt:** Şu an `dia_karlilik_raporu` tablosu son **30 Nisan 2026**'da
güncellenmiş. Bu tablo `/api/dia-sync?type=rapor-cek&rapor=SCF2240A` ile elle
güncelleniyor. Faz 1 rapor cron'ları sadece bu tablodan okuyor — yani yeni
fatura verisi bu tabloya yansımıyorsa raporda görünmüyor.

**Geçici çözüm**: Günde bir kez elle SCF2240A çekme.
**Kalıcı çözüm (Faz 2)**: dia-sync.js'in karlilik tablosunu da otomatik
güncellemesi (mevcut `rpr_raporsonuc_getir` çağrısının arkasına `dia_karlilik_raporu`
upsert mantığı eklemek).

---

## Adım 7 — Bilinen sınırlar ve Faz 2 işleri

1. **DIA fatura kalem endpoint'i** netleşmeli. `scf_faturadetay_listele` adayı; DIA dokümanından doğrula.
2. **Stok kart sync**'i `dia-sync.js`'te genişlet:
   - `raw_data` JSON'undan `ek_alan_1`, `ek_alan_1_doviz`, `ek_alan_2` çıkar
   - Yeni sütunlara yaz
3. **Fatura kuru kaynağı** netleşmeli — DIA fatura header'ında `dovizadi`, `dovizkuru` field'ları kullanılabilir.
4. **vw_gunluk_satis_karlilik** view'ını **fatura kalemleri × stok × kur** ile yeniden hesaplayarak güncel kur kârını üret.
5. **daily-report.js**'te `Kâr (güncel kur)` ve `Fark` satırlarını gerçek hesaba çevir.
6. **Cron sıralaması**: rapor cron'u öncesinde TCMB sync + dia-sync(karlilik) tetiklemesini şart koş.
7. **RLS politikaları**: Şu an tüm `public.*` tabloları RLS'siz. Supabase advisory bunu kritik olarak işaretliyor; kullanıcı kararı.

---

## Geri alma (rollback)

Migration geri alımı için SQL dosyasının altında "Geri alma" bloğu var.
Endpoint'lerin tamamı eski sürümleri etkilemiyor — sadece yeni dosyalar ekleniyor.
Sadece `vercel.json` ve `api/daily-report.js` mevcut dosyaların üzerine yazıyor.
Git history üzerinden istenildiğinde geri alınabilir.
