-- ============================================================================
-- NapolZeka Rapor v2 — dovizkuru hibrit kuralı
-- Tarih: 2026-05-28
-- Sebep: Kalem-test çıktısı NPE faturalarının çoğunun dövizli kesildiğini
--        ortaya çıkardı (dovizkuru = 45.0661 / 45.1337 → USD). Faturadaki
--        gerçek kur, TCMB fallback'inden daha doğru. Ama döviz cinsi
--        uyumsuzluğunda fatura kuru yanlış sonuç verir → ekalan1_doviz ile
--        fatura_doviz eşleşmesi koşulunu da koruyoruz.
--
-- Mantık:
--   * fatura_kuru > 1 VE fatura_doviz = ekalan1_doviz  → fatura_kuru (doğru, faturanın anındaki kur)
--   * ekalan1_doviz = 'TL'                            → 1 (TL satış-TL maliyet)
--   * ekalan1_doviz = 'USD'                           → tcmb_kurlar.usd_satis
--   * ekalan1_doviz = 'EUR'                           → tcmb_kurlar.eur_satis
--   * aksi halde                                       → NULL (maliyet eksik)
-- ============================================================================

-- Eski view'ı DROP edip yeniden yarat (haftalık view ona dayandığı için onu da)
DROP VIEW IF EXISTS public.vw_haftalik_satis_karlilik;
DROP VIEW IF EXISTS public.vw_gunluk_satis_karlilik;

CREATE OR REPLACE VIEW public.vw_gunluk_satis_karlilik AS
WITH kalem_zenginlestirilmis AS (
  SELECT
    k.fatura_no,
    k.fatura_tarihi,
    k.stok_kodu,
    k.miktar,
    k.satir_tutari_tl,
    k.fatura_kuru,
    k.fatura_doviz,
    s.ekalan1_tutar,
    s.ekalan1_doviz,
    s.ekalan2_tutar,
    s.ekalan_parse_hata,
    -- Hibrit kur seçimi:
    CASE
      -- 1) Fatura dövizi ekalan1 dövizine eşit ve gerçek kur var → fatura kuru
      WHEN k.fatura_kuru IS NOT NULL AND k.fatura_kuru > 1
           AND k.fatura_doviz IS NOT NULL
           AND UPPER(k.fatura_doviz) = s.ekalan1_doviz
        THEN k.fatura_kuru
      -- 2) Ekalan1 TL ise her zaman 1
      WHEN s.ekalan1_doviz = 'TL'
        THEN 1::numeric
      -- 3) TCMB fallback
      WHEN s.ekalan1_doviz = 'USD' THEN t.usd_satis
      WHEN s.ekalan1_doviz = 'EUR' THEN t.eur_satis
      ELSE NULL
    END AS guncel_kur,
    -- Hangi kaynak kullanıldı (debug + raporlama için):
    CASE
      WHEN k.fatura_kuru IS NOT NULL AND k.fatura_kuru > 1
           AND k.fatura_doviz IS NOT NULL
           AND UPPER(k.fatura_doviz) = s.ekalan1_doviz
        THEN 'fatura_kuru'
      WHEN s.ekalan1_doviz = 'TL'
        THEN 'sabit_1'
      WHEN s.ekalan1_doviz IN ('USD','EUR') AND
           CASE s.ekalan1_doviz WHEN 'USD' THEN t.usd_satis WHEN 'EUR' THEN t.eur_satis END IS NOT NULL
        THEN 'tcmb'
      ELSE 'eksik'
    END AS kur_kaynagi,
    -- Bu kalem hesaplanabilir mi?
    CASE
      WHEN s.ekalan1_tutar IS NULL OR s.ekalan2_tutar IS NULL THEN false
      WHEN s.ekalan_parse_hata IS NOT NULL THEN false
      WHEN s.ekalan1_doviz IS NULL THEN false
      WHEN s.ekalan1_doviz = 'TL' THEN true
      WHEN k.fatura_kuru IS NOT NULL AND k.fatura_kuru > 1
           AND k.fatura_doviz IS NOT NULL
           AND UPPER(k.fatura_doviz) = s.ekalan1_doviz THEN true
      WHEN s.ekalan1_doviz IN ('USD','EUR')
           AND CASE s.ekalan1_doviz WHEN 'USD' THEN t.usd_satis WHEN 'EUR' THEN t.eur_satis END IS NOT NULL
        THEN true
      ELSE false
    END AS kalem_hesaplanir
  FROM public.dia_fatura_kalemleri k
  LEFT JOIN public.dia_stoklar  s ON s.stok_kart_kodu = k.stok_kodu
  LEFT JOIN public.tcmb_kurlar  t ON t.tarih = k.fatura_tarihi
),
fatura_ozet AS (
  SELECT
    fatura_tarihi AS tarih,
    fatura_no,
    SUM(satir_tutari_tl) AS kdv_haric_satis,
    SUM(satir_tutari_tl) FILTER (WHERE kalem_hesaplanir) AS hesaplanan_satis,
    SUM(miktar * ekalan1_tutar * guncel_kur) FILTER (WHERE kalem_hesaplanir) AS guncel_maliyet,
    SUM(miktar * ekalan2_tutar)               FILTER (WHERE kalem_hesaplanir) AS defter_maliyet,
    BOOL_OR(NOT kalem_hesaplanir) AS maliyetsiz_mi,
    COUNT(*) FILTER (WHERE NOT kalem_hesaplanir) AS maliyetsiz_kalem_sayisi,
    COUNT(*) AS toplam_kalem_sayisi,
    -- Hangi kur kaynaklarının kullanıldığını gör (rapor altına opsiyonel bilgi):
    STRING_AGG(DISTINCT kur_kaynagi, ',') AS kur_kaynaklari
  FROM kalem_zenginlestirilmis
  GROUP BY fatura_tarihi, fatura_no
)
SELECT
  f.tarih,
  f.fatura_no,
  (SELECT cari_unvan FROM public.dia_karlilik_raporu
   WHERE fatura_no = f.fatura_no LIMIT 1) AS cari_unvan,
  f.kdv_haric_satis,
  COALESCE(f.hesaplanan_satis - f.guncel_maliyet, 0) AS guncel_kar,
  CASE WHEN f.hesaplanan_satis > 0
    THEN ROUND((f.hesaplanan_satis - f.guncel_maliyet) / f.hesaplanan_satis * 100, 2)
    ELSE NULL END AS guncel_marj,
  f.guncel_maliyet,
  COALESCE(f.hesaplanan_satis - f.defter_maliyet, 0) AS defter_kar,
  CASE WHEN f.hesaplanan_satis > 0
    THEN ROUND((f.hesaplanan_satis - f.defter_maliyet) / f.hesaplanan_satis * 100, 2)
    ELSE NULL END AS defter_marj,
  f.defter_maliyet,
  COALESCE((f.hesaplanan_satis - f.defter_maliyet) - (f.hesaplanan_satis - f.guncel_maliyet), 0)
    AS kur_farki_etkisi,
  f.maliyetsiz_mi,
  f.maliyetsiz_kalem_sayisi,
  f.toplam_kalem_sayisi,
  f.kur_kaynaklari
FROM fatura_ozet f
ORDER BY f.tarih, f.fatura_no;

COMMENT ON VIEW public.vw_gunluk_satis_karlilik
  IS 'Faz 2.6: Hibrit kur — fatura_kuru>1 + doviz eşleşmesi varsa onu, yoksa TCMB. kur_kaynaklari sütunu debug için.';

-- vw_haftalik_satis_karlilik aynı şekilde günlük view'a dayanıyor
CREATE OR REPLACE VIEW public.vw_haftalik_satis_karlilik AS
SELECT
  tarih,
  COUNT(*)                              AS fatura_sayisi,
  SUM(kdv_haric_satis)                  AS toplam_kdv_haric_satis,
  SUM(guncel_kar)                       AS toplam_guncel_kar,
  SUM(defter_kar)                       AS toplam_defter_kar,
  SUM(kur_farki_etkisi)                 AS toplam_kur_farki_etkisi,
  CASE WHEN SUM(kdv_haric_satis) > 0
    THEN ROUND(SUM(guncel_kar) / SUM(kdv_haric_satis) * 100, 2)
    ELSE NULL END                       AS guncel_marj,
  CASE WHEN SUM(kdv_haric_satis) > 0
    THEN ROUND(SUM(defter_kar) / SUM(kdv_haric_satis) * 100, 2)
    ELSE NULL END                       AS defter_marj,
  COUNT(*) FILTER (WHERE maliyetsiz_mi) AS maliyetsiz_fatura_sayisi
FROM public.vw_gunluk_satis_karlilik
GROUP BY tarih
ORDER BY tarih;

COMMENT ON VIEW public.vw_haftalik_satis_karlilik
  IS 'Faz 2.6: günlük view''dan grupla.';

-- ============================================================================
-- NOT: vw_gunluk_maliyetsiz_kalemler view'ı Faz 2 migration'ından geliyor
-- ve yapısı değişmiyor — TCMB eksikliği kontrolünü hâlâ doğru yapıyor.
-- Dilersek "fatura kuru var ama doviz uyumsuz" durumunu da gerekçe olarak
-- ekleyebiliriz. Şimdilik mevcut versiyonu bırakıyorum.
-- ============================================================================
