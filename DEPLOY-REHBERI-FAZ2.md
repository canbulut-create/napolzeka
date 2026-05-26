# NapolZeka Rapor v2 — Faz 2 Deploy Rehberi

Faz 1 canlıda ve test edildi (commit f1ef823, TCMB sync çalışıyor, dry-run rapor spec'le uyumlu, defter kârı doğru). Faz 2 hedefi: **gerçek Kâr 1 (güncel kur) + Kur farkı etkisi + maliyet eksik gerekçesi** üretmek için kalem sync, stok ekalan parse, ve `dia_karlilik_raporu` otomatik güncellemesi.

## Bu pakette ne var

```
yeni/
├── migrations/
│   ├── 20260526_napol_rapor_v2.sql        # (Faz 1 — uygulandı)
│   └── 20260527_napol_rapor_v2_faz2.sql   # YENİ — ekalan parse sütunları + view yeniden yazıldı
├── api/
│   ├── daily-report.js                    # Placeholder kaldırıldı, gerçek Kâr 1
│   ├── weekly-report.js                   # Aynı: gerçek Kâr 1 + kur farkı
│   ├── tcmb-sync.js                       # Değişiklik yok (env fallback eklendi)
│   └── dia-sync.js                        # YENİDEN YAZILDI — 3 yeni mod + parse + auth fix
├── vercel.json                            # 3 yeni cron eklendi
├── push.sh                                # Aynı (argümanlı)
└── DEPLOY-REHBERI-FAZ2.md                 # (bu dosya)
```

## Faz 2 ne ekliyor

| Konu | Durum |
|------|-------|
| Stok kart sync (`scf_stokkart_detay_listele`, key-based chunked) | YENİ — `?type=stok-full` |
| Ekalan parse: `"0,0940 USD"` → `{ tutar: 0.094, doviz: 'USD' }` | YENİ — `parseEkalanMaliyet()` |
| Fatura kalem sync (`scf_fatura_listele_ayrintili`) | YENİ — `?type=kalem` |
| Karlilik upsert (SCF2240A → tablo) | YENİ — `?type=karlilik-sync` |
| Kâr 1 (güncel kur) hesabı (kalem × stok × TCMB) | View içinde — `vw_gunluk_satis_karlilik` |
| Kur farkı etkisi (Kâr 2 − Kâr 1) | View içinde |
| Maliyet eksik kalem listesi (parse_fail / stok yok / tcmb yok) | YENİ — `vw_gunluk_maliyetsiz_kalemler` |
| Vercel cron auth (Bearer header desteği) | Endpoint'ler artık iki env adını da kabul ediyor |

---

## Önemli NOT: Vercel cron auth

**Vercel cron** tetiklemelerinde `Authorization: Bearer ${CRON_SECRET}` header'ını **sadece** `CRON_SECRET` adındaki env değişkeni varsa otomatik ekler. Manuel curl testlerin `NAPOL_CRON_SECRET` ile çalışıyor — ama Vercel'in otomatik cron tetiklemeleri muhtemelen **401 dönüyor şu an**.

**Çözüm (en güvenli yol):** Vercel projesine **ikinci bir env değişkeni** olarak `CRON_SECRET` ekle — `NAPOL_CRON_SECRET` ile **aynı değerle**. Endpoint'ler her ikisini de kabul ediyor; `CRON_SECRET` cron için, `NAPOL_CRON_SECRET` manuel test için.

```
Vercel → napolzeka → Settings → Environment Variables → Add:
  Key:   CRON_SECRET
  Value: (NAPOL_CRON_SECRET'in mevcut değeri — birebir aynı)
  Env:   Production
```

Bu adımı atlama, yoksa 18:00 cron'ları sessizce 401 alır.

---

## Adım 1 — Push

```bash
~/Documents/Claude/Projects/NapolZeka/yeni/push.sh "feat: Faz 2 - kalem sync + ekalan parse + Kar 1"
```

`push.sh` zaten 7 dosyayı taşıyor; yeni migration ve dia-sync.js otomatik dahil çünkü aynı path'lerde duruyorlar.

**Yeni dosyaların eşlemesi (push.sh'in zaten yaptığı):**
- `migrations/20260526_napol_rapor_v2.sql` (Faz 1 — değişmedi)
- `migrations/20260527_napol_rapor_v2_faz2.sql` (Faz 2 — push.sh'e ek satır gerek YOK çünkü tüm `migrations/*.sql`'i kopyalıyor)

> **Dikkat:** mevcut `push.sh` Faz 1 dosyalarını sabit isimle kopyalıyor. Yeni migration için tek satır ekleyebilirsin veya elle `cp` yapabilirsin. Aşağıda push.sh'in genişletilmesi gereken kısmı işaretledim.

Alternatif: push.sh'i şu satırla genişlet (commit öncesi):
```bash
cp "$YENI/migrations/20260527_napol_rapor_v2_faz2.sql" migrations/
```

`yeni/push.sh`'nin satır ~21'den sonrasına ekle:
```diff
   cp "$YENI/migrations/20260526_napol_rapor_v2.sql" migrations/
+  cp "$YENI/migrations/20260527_napol_rapor_v2_faz2.sql" migrations/
   cp "$YENI/api/daily-report.js"  api/
+  cp "$YENI/api/dia-sync.js"      api/
```

> Eğer bunu unutursan dia-sync.js eski (bozuk) halde kalır — Faz 2 çalışmaz. Mutlaka kontrol et.

---

## Adım 2 — Supabase migration v3

```sql
-- migrations/20260527_napol_rapor_v2_faz2.sql içeriğini Supabase SQL Editor'e yapıştır → Run
```

Veya: Cowork'e söyle: "Supabase migration v3'ü MCP ile uygula". Migration **idempotent** (RENAME haricinde — bu sütunlar Faz 1'de eklenmişti ama hâlâ NULL, RENAME güvenli).

Migration sonrası beklenen:
- `dia_stoklar.ek_alan_1` → `ekalan1_tutar` (rename)
- `dia_stoklar.ek_alan_1_doviz` → `ekalan1_doviz` (rename)
- `dia_stoklar.ek_alan_2` → `ekalan2_tutar` (rename)
- Yeni sütunlar: `ekalan2_doviz`, `ekalan1_raw`, `ekalan2_raw`, `ekalan_parse_hata`
- View'lar yeniden: `vw_gunluk_satis_karlilik`, `vw_haftalik_satis_karlilik`, **yeni** `vw_gunluk_maliyetsiz_kalemler`

---

## Adım 3 — Test sırası (KRİTİK)

DIA endpoint field adlarını canlıdan doğrulamadan sync etmiyoruz. Sıra:

### 3.1 Stok kart test (5 stok, ham JSON gör)
```bash
curl 'https://napolzeka.vercel.app/api/dia-sync?type=stok-test&token=<NAPOL_CRON_SECRET>'
```

Beklenen response:
```json
{
  "stok_test": [
    {
      "_key": 12345,
      "stokkartkodu": "ETK-001",
      "aciklama": "...",
      "ekalan1": "0,0940 USD",
      "ekalan2": "4,2857 TL",
      "doviz1": "...",
      "fiyat1": "...",
      "parse_ekalan1": { "tutar": 0.094, "doviz": "USD" },
      "parse_ekalan2": { "tutar": 4.2857, "doviz": "TL" },
      "all_keys": [ ... ]
    }
  ]
}
```

**Doğrula:** `parse_ekalan1.tutar` ve `parse_ekalan2.tutar` gerçek sayılarla doluyor mu? `all_keys` listesinde `ekalan1` ve `ekalan2` görüyor musun? Eğer ekalan değerleri NULL geliyorsa stok kartı bu alanı dolu değil veya `selectedcolumns`'a eklenmemiş olabilir (kod 105. satır kontrol et).

### 3.2 Kalem test (1 günün ilk 5 kalemi)
```bash
curl 'https://napolzeka.vercel.app/api/dia-sync?type=kalem-test&tarih=2026-04-30&token=<NAPOL_CRON_SECRET>'
```

**Doğrula:** `all_keys` listesinde gerçek field adları nedir? Özellikle:
- KDV hariç satır tutarı: `tutar`? `kdvharictutar`? `toplam`?
- Stok kodu: `stokkartkodu`? `stokkodu`?
- Miktar: `miktar`?
- Birim fiyat: `birimfiyat`?

Bu listeyi bana paylaş — `kalemKayitMap()` fonksiyonunu (dia-sync.js 217. satır civarı) gerçek field adlarıyla **kesinleştireceğiz**. Şu an `kalemKayitMap` güvenli fallback'lerle yazıldı ama production'da gözlemli isimle keskinleştirmek lazım.

### 3.3 İlk gerçek sync — tek gün test (30 Nisan)
Stok ve kalem field adları doğrulandıktan sonra:
```bash
# Tüm stok kartları (parse + upsert)
curl 'https://napolzeka.vercel.app/api/dia-sync?type=stok-full&token=<NAPOL_CRON_SECRET>'

# 30 Nisan'ın kalemleri
curl 'https://napolzeka.vercel.app/api/dia-sync?type=kalem&from=2026-04-30&to=2026-04-30&token=<NAPOL_CRON_SECRET>'
```

### 3.4 View doğrulaması
Supabase Studio SQL Editor:
```sql
SELECT * FROM vw_gunluk_satis_karlilik WHERE tarih = '2026-04-30';
SELECT * FROM vw_gunluk_maliyetsiz_kalemler WHERE tarih = '2026-04-30';
```

Beklenen: 30 Nisan'da 3 satış faturası (NPE...132/133/134), her birinde `guncel_kar` ve `defter_kar` dolu, `kur_farki_etkisi` hesaplanmış.

### 3.5 Daily-report dry-run
```bash
curl 'https://napolzeka.vercel.app/api/daily-report?tarih=2026-04-30&dry=1' \
  -H 'Authorization: Bearer <NAPOL_CRON_SECRET>'
```

Bu defa "Kâr (güncel kur)" satırı **gerçek değer** göstermeli — placeholder yok.

---

## Adım 4 — Backfill (Nisan + Mayıs)

`dia_karlilik_raporu` tablosu 30 Nisan'da takılı kaldı. Tek seferlik:

```bash
# Stok kartlarını çek (sadece bir kez yeter; haftalık cron zaten Pazar 22 UTC'de yenileyecek)
curl 'https://napolzeka.vercel.app/api/dia-sync?type=stok-full&token=<NAPOL_CRON_SECRET>'

# Karlilik tablosunu Mayıs sonuna kadar doldur
curl 'https://napolzeka.vercel.app/api/dia-sync?type=karlilik-sync&from=2026-04-01&to=2026-05-26&token=<NAPOL_CRON_SECRET>'

# Kalemleri Nisan 1'den bugüne kadar çek (büyük olabilir, sabırla bekle)
curl 'https://napolzeka.vercel.app/api/dia-sync?type=kalem&from=2026-04-01&to=2026-05-26&token=<NAPOL_CRON_SECRET>'
```

Sonra:
```bash
# Haftanın gerçek raporu (geçen Pzt-Cum)
curl 'https://napolzeka.vercel.app/api/weekly-report?dry=1' \
  -H 'Authorization: Bearer <NAPOL_CRON_SECRET>'
```

Çıktıda **Kâr (güncel kur)** ve **Kur farkı etkisi** gerçek değerleriyle gelecek.

---

## Adım 5 — Cron tablosu güncel

| Path | Schedule (UTC) | TR | Görev |
|------|----------------|-----|-------|
| `/api/tcmb-sync` | `0 6 * * 1-5` | Pzt-Cum 09:00 | TCMB kuru çek |
| `/api/fatura-sync` | `0 14 * * 1-6` | Pzt-Cmt 17:00 | DIA fatura header sync (mevcut) |
| `/api/dia-sync?type=kalem` | `15 14 * * 1-5` | Pzt-Cum 17:15 | **YENİ** — bugünkü kalemleri çek |
| `/api/dia-sync?type=karlilik-sync` | `30 14 * * 1-5` | Pzt-Cum 17:30 | **YENİ** — bugünkü karlilik raporu çek |
| `/api/daily-report` | `0 15 * * 1-5` | Pzt-Cum 18:00 | Günlük rapor |
| `/api/weekly-report` | `0 7 * * 6` | Cmt 10:00 | Haftalık rapor |
| `/api/haftalik-sync` | `0 23 * * 0` | Pzt 02:00 | Cari/çek sync (mevcut) |
| `/api/dia-sync?type=stok-full` | `0 22 * * 0` | Pzt 01:00 | **YENİ** — haftalık stok yenileme |

Sıra: tcmb → fatura header (mevcut) → kalem → karlilik → daily-report. 30 dakikalık aralık her sync için bolca süre bırakıyor.

---

## Bilinen sınırlar ve Faz 3 işleri

1. **`kalemKayitMap()` field adları tahmini.** İlk `kalem-test` çağrısının `all_keys` çıktısına göre `dia-sync.js` 217. satırı civarındaki map'i bir kez netleştirmek gerek. Özellikle `satir_tutari_tl` (`tutar`/`kdvharictutar`/`toplam` arasında hangisi).

2. **`karlilikSatirMap()` field adları gözlemden.** SCF2240A response'unun nasıl geldiğini canlı olarak doğrula. Şu an mevcut `dia_karlilik_raporu` tablosundaki sütunlara göre map yapıldı; DIA tarafında alan adı farklıysa boş alan döner.

3. **DIA rapor parametreleri (`tarih_bas`, `tarih_son`)** SCF2240A için bizim tahminimiz. `?type=rapor-params&rapor=SCF2240A` çağrısı doğru parametre adlarını döndürür. Eğer karlilik-sync 0 satır dönerse parametre adını kontrol et.

4. **TCMB kuru hafta sonu / tatil günleri:** TCMB Cmt/Pzr ve tatillerde XML yayınlamaz. O günlerde kesilen fatura için `vw_gunluk_maliyetsiz_kalemler` "tcmb_kur_eksik" sebep gösterir. Pratik çözüm: önceki iş günü kuruna fallback eden bir view veya kur araması — Faz 3.

5. **`raporlamadovizkuru` field'ı:** DIA fatura header'ında raporlama döviz kuru ayrı bir field. NapolZeka'nın kullandığı kur bu mu, yoksa `dovizkuru` mu? Tüm 391 faturanın TRY olduğunu söyledin, bu yüzden şu an önemsiz — ama dövizli fatura kesilirse gözden geçirilmeli.

---

## Geri alma

Migration v3 geri alımı:
```sql
DROP VIEW IF EXISTS public.vw_haftalik_satis_karlilik;
DROP VIEW IF EXISTS public.vw_gunluk_maliyetsiz_kalemler;
DROP VIEW IF EXISTS public.vw_gunluk_satis_karlilik;
ALTER TABLE public.dia_stoklar RENAME COLUMN ekalan1_tutar TO ek_alan_1;
ALTER TABLE public.dia_stoklar RENAME COLUMN ekalan1_doviz TO ek_alan_1_doviz;
ALTER TABLE public.dia_stoklar RENAME COLUMN ekalan2_tutar TO ek_alan_2;
ALTER TABLE public.dia_stoklar
  DROP COLUMN IF EXISTS ekalan2_doviz,
  DROP COLUMN IF EXISTS ekalan1_raw,
  DROP COLUMN IF EXISTS ekalan2_raw,
  DROP COLUMN IF EXISTS ekalan_parse_hata;
-- Faz 1 view'larını Faz 1 SQL'inden tekrar yarat.
```

Vercel deploy geri alımı: `git revert <commit>` veya Vercel Dashboard → Deployments → Promote to Production (önceki).
