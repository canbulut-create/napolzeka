-- ============================================================================
-- NapolZeka Rapor v2 — Faz 2 Migration
-- Tarih: 2026-05-27
-- Kapsam:
--   * dia_stoklar: ekalan1/2 parse edilmiş sütunlar (tutar + döviz + raw + hata)
--   * Faz 1'deki ek_alan_* sütunları yeni isimlere RENAME edilir (boştular)
--   * View'lar DROP + yeniden CREATE: kalem × stok × TCMB ile gerçek Kâr 1 + Kâr 2
--   * Yeni view: vw_gunluk_maliyetsiz_kalemler (rapor uyarı bölümü için)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) dia_stoklar — Faz 1 sütunlarını yeniden adlandır + parse sütunları ekle
-- ---------------------------------------------------------------------------
-- Faz 1'de eklediğimiz ek_alan_1/2/doviz sütunları henüz dolu değil (stok sync hiç çalışmadı).
-- Bu yüzden RENAME güvenli.
ALTER TABLE public.dia_stoklar
  RENAME COLUMN ek_alan_1 TO ekalan1_tutar;
ALTER TABLE public.dia_stoklar
  RENAME COLUMN ek_alan_1_doviz TO ekalan1_doviz;
ALTER TABLE public.dia_stoklar
  RENAME COLUMN ek_alan_2 TO ekalan2_tutar;

-- Yeni sütunlar
ALTER TABLE public.dia_stoklar
  ADD COLUMN IF NOT EXISTS ekalan2_doviz       text,
  ADD COLUMN IF NOT EXISTS ekalan1_raw         text,
  ADD COLUMN IF NOT EXISTS ekalan2_raw         text,
  ADD COLUMN IF NOT EXISTS ekalan_parse_hata   text;

COMMENT ON COLUMN public.dia_stoklar.ekalan1_tutar
  IS 'DIA ekalan1 string''inden parse edilmiş sayısal değer (ör. "0,0940 USD" → 0.094)';
COMMENT ON COLUMN public.dia_stoklar.ekalan1_doviz
  IS 'ekalan1 para birimi: USD / EUR / TL';
COMMENT ON COLUMN public.dia_stoklar.ekalan2_tutar
  IS 'DIA ekalan2 (TL maliyet) parse edilmiş sayısal değer';
COMMENT ON COLUMN public.dia_stoklar.ekalan2_doviz
  IS 'ekalan2 para birimi (beklenen: TL, ama doğrulama için yazıyoruz)';
COMMENT ON COLUMN public.dia_stoklar.ekalan1_raw
  IS 'DIA''dan gelen ham ekalan1 string''i (debug için)';
COMMENT ON COLUMN public.dia_stoklar.ekalan2_raw
  IS 'DIA''dan gelen ham ekalan2 string''i (debug için)';
COMMENT ON COLUMN public.dia_stoklar.ekalan_parse_hata
  IS 'Parse başarısızsa hata nedeni (NULL = sorun yok)';

-- ---------------------------------------------------------------------------
-- 2) dia_fatura_kalemleri index'leri ve doğrulamalar
-- ---------------------------------------------------------------------------
-- Faz 1'de oluşturuldu, ek index gerekirse buraya eklenir.
-- KDV hariç satır toplamı için satir_tutari_tl alanı zaten var.

-- ---------------------------------------------------------------------------
-- 3) Eski view'ları DROP — yeniden yaratacağız
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.vw_haftalik_satis_karlilik;
DROP VIEW IF EXISTS public.vw_gunluk_satis_karlilik;

-- ---------------------------------------------------------------------------
-- 4) vw_gunluk_satis_karlilik (Faz 2 — gerçek Kâr 1 + Kâr 2)
--    Mantık:
--      Kâr 1 = (KDV'siz TL satış − miktar × ekalan1_tutar × TCMB_kuru(ekalan1_doviz, tarih))
--      Kâr 2 = (KDV'siz TL satış − miktar × ekalan2_tutar)
--    Eksik (parse_hata veya stok eşleşmeyen veya kur bulunamayan) kalemler:
--      → kâra dahil edilmez (spec madde 3 son cümle)
--      → fatura için maliyetsiz_mi=true işaretlenir
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_gunluk_satis_karlilik AS
WITH kalem_zenginlestirilmis AS (
  SELECT
    k.fatura_no,
    k.fatura_tarihi,
    k.stok_kodu,
    k.miktar,
    k.satir_tutari_tl,
    s.ekalan1_tutar,
    s.ekalan1_doviz,
    s.ekalan2_tutar,
    s.ekalan_parse_hata,
    -- TCMB kuru: ekalan1_doviz'e göre o günkü efektif satış
    CASE s.ekalan1_doviz
      WHEN 'TL'  THEN 1::numeric
      WHEN 'USD' THEN t.usd_satis
      WHEN 'EUR' THEN t.eur_satis
      ELSE NULL
    END AS guncel_kur,
    -- Bu kalem hesaplanabilir mi?
    CASE
      WHEN s.ekalan1_tutar IS NULL OR s.ekalan2_tutar IS NULL THEN false
      WHEN s.ekalan_parse_hata IS NOT NULL THEN false
      WHEN s.ekalan1_doviz IS NULL THEN false
      WHEN s.ekalan1_doviz IN ('USD','EUR') AND
           CASE s.ekalan1_doviz WHEN 'USD' THEN t.usd_satis WHEN 'EUR' THEN t.eur_satis END IS NULL
        THEN false
      ELSE true
    END AS kalem_hesaplanir
  FROM public.dia_fatura_kalemleri k
  LEFT JOIN public.dia_stoklar  s ON s.stok_kart_kodu = k.stok_kodu
  LEFT JOIN public.tcmb_kurlar  t ON t.tarih = k.fatura_tarihi
),
fatura_ozet AS (
  SELECT
    fatura_tarihi AS tarih,
    fatura_no,
    -- KDV hariç satış: tüm kalemler (eksik dahil)
    SUM(satir_tutari_tl) AS kdv_haric_satis,
    -- Hesaplanabilir kalemlerin satış toplamı (kâr marj payidası)
    SUM(satir_tutari_tl) FILTER (WHERE kalem_hesaplanir) AS hesaplanan_satis,
    -- Güncel maliyet (Kâr 1): sadece hesaplanabilir kalemler
    SUM(miktar * ekalan1_tutar * guncel_kur) FILTER (WHERE kalem_hesaplanir) AS guncel_maliyet,
    -- Defter maliyet (Kâr 2): sadece hesaplanabilir kalemler
    SUM(miktar * ekalan2_tutar)               FILTER (WHERE kalem_hesaplanir) AS defter_maliyet,
    -- En az bir kalemde sorun varsa fatura için flag
    BOOL_OR(NOT kalem_hesaplanir) AS maliyetsiz_mi,
    COUNT(*) FILTER (WHERE NOT kalem_hesaplanir) AS maliyetsiz_kalem_sayisi,
    COUNT(*) AS toplam_kalem_sayisi
  FROM kalem_zenginlestirilmis
  GROUP BY fatura_tarihi, fatura_no
)
SELECT
  f.tarih,
  f.fatura_no,
  -- Cari ünvanı dia_karlilik_raporu'ndan (kalemler tablosu cari ünvanı tutmuyor)
  (SELECT cari_unvan FROM public.dia_karlilik_raporu
   WHERE fatura_no = f.fatura_no LIMIT 1) AS cari_unvan,
  f.kdv_haric_satis,
  -- Güncel kur (Kâr 1)
  COALESCE(f.hesaplanan_satis - f.guncel_maliyet, 0) AS guncel_kar,
  CASE
    WHEN f.hesaplanan_satis > 0
      THEN ROUND((f.hesaplanan_satis - f.guncel_maliyet) / f.hesaplanan_satis * 100, 2)
    ELSE NULL
  END AS guncel_marj,
  f.guncel_maliyet,
  -- Defter (Kâr 2)
  COALESCE(f.hesaplanan_satis - f.defter_maliyet, 0) AS defter_kar,
  CASE
    WHEN f.hesaplanan_satis > 0
      THEN ROUND((f.hesaplanan_satis - f.defter_maliyet) / f.hesaplanan_satis * 100, 2)
    ELSE NULL
  END AS defter_marj,
  f.defter_maliyet,
  -- Fark: Kâr 2 − Kâr 1 (pozitif → defter, güncelden fazla kâr gösteriyor = kur farkı etkisi)
  COALESCE((f.hesaplanan_satis - f.defter_maliyet) - (f.hesaplanan_satis - f.guncel_maliyet), 0) AS kur_farki_etkisi,
  f.maliyetsiz_mi,
  f.maliyetsiz_kalem_sayisi,
  f.toplam_kalem_sayisi
FROM fatura_ozet f
ORDER BY f.tarih, f.fatura_no;

COMMENT ON VIEW public.vw_gunluk_satis_karlilik
  IS 'Faz 2: kalem × stok × TCMB ile fatura bazında Kâr 1 (güncel kur) + Kâr 2 (defter) + fark.';

-- ---------------------------------------------------------------------------
-- 5) vw_gunluk_maliyetsiz_kalemler — rapor uyarı bölümü için
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_gunluk_maliyetsiz_kalemler AS
SELECT
  k.fatura_tarihi AS tarih,
  k.fatura_no,
  k.stok_kodu,
  k.stok_adi,
  CASE
    WHEN s.stok_kart_kodu IS NULL THEN 'stok_kartı_yok'
    WHEN s.ekalan1_tutar IS NULL  THEN 'ekalan1_eksik'
    WHEN s.ekalan2_tutar IS NULL  THEN 'ekalan2_eksik'
    WHEN s.ekalan_parse_hata IS NOT NULL THEN s.ekalan_parse_hata
    WHEN s.ekalan1_doviz IN ('USD','EUR')
         AND (SELECT 1 FROM public.tcmb_kurlar
              WHERE tarih = k.fatura_tarihi
                AND CASE s.ekalan1_doviz WHEN 'USD' THEN usd_satis WHEN 'EUR' THEN eur_satis END IS NOT NULL
              LIMIT 1) IS NULL
      THEN 'tcmb_kur_eksik'
    ELSE NULL
  END AS sebep
FROM public.dia_fatura_kalemleri k
LEFT JOIN public.dia_stoklar s ON s.stok_kart_kodu = k.stok_kodu
WHERE
  s.stok_kart_kodu IS NULL
  OR s.ekalan1_tutar IS NULL
  OR s.ekalan2_tutar IS NULL
  OR s.ekalan_parse_hata IS NOT NULL
  OR (s.ekalan1_doviz IN ('USD','EUR')
      AND NOT EXISTS (
        SELECT 1 FROM public.tcmb_kurlar
        WHERE tarih = k.fatura_tarihi
          AND CASE s.ekalan1_doviz WHEN 'USD' THEN usd_satis WHEN 'EUR' THEN eur_satis END IS NOT NULL
      ));

COMMENT ON VIEW public.vw_gunluk_maliyetsiz_kalemler
  IS 'Faz 2: Maliyet hesabı yapılamayan kalemler — günlük rapor uyarı bölümü için.';

-- ---------------------------------------------------------------------------
-- 6) vw_haftalik_satis_karlilik (Faz 2 — günlük view üzerinden grupla)
-- ---------------------------------------------------------------------------
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
  IS 'Faz 2: Haftalık rapor için günlük gruplanmış kâr özeti.';

-- ============================================================================
-- Geri alma (rollback) — gerekirse:
--   DROP VIEW IF EXISTS public.vw_haftalik_satis_karlilik;
--   DROP VIEW IF EXISTS public.vw_gunluk_maliyetsiz_kalemler;
--   DROP VIEW IF EXISTS public.vw_gunluk_satis_karlilik;
--   ALTER TABLE public.dia_stoklar
--     RENAME COLUMN ekalan1_tutar TO ek_alan_1;
--   ALTER TABLE public.dia_stoklar
--     RENAME COLUMN ekalan1_doviz TO ek_alan_1_doviz;
--   ALTER TABLE public.dia_stoklar
--     RENAME COLUMN ekalan2_tutar TO ek_alan_2;
--   ALTER TABLE public.dia_stoklar
--     DROP COLUMN IF EXISTS ekalan2_doviz,
--     DROP COLUMN IF EXISTS ekalan1_raw,
--     DROP COLUMN IF EXISTS ekalan2_raw,
--     DROP COLUMN IF EXISTS ekalan_parse_hata;
--   -- Faz 1 view'larını tekrar yarat (önceki migration'dan kopyala).
-- ============================================================================
