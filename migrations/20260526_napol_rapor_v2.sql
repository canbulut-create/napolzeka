-- ============================================================================
-- NapolZeka Rapor v2 — Faz 1 Migration
-- Tarih: 2026-05-26
-- Kapsam: Yeni günlük + haftalık rapor altyapısı için tablo/sütun/view eklentileri.
--         Bu migration mevcut verilere DOKUNMAZ — sadece yeni alanlar ekler.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) dia_stoklar — Stok kartı maliyet alanları
-- ---------------------------------------------------------------------------
-- ek_alan_1       : Yabancı para birimindeki maliyet (örn. 12.50)
-- ek_alan_1_doviz : ek_alan_1'in para birimi ('USD' / 'EUR' / NULL)
-- ek_alan_2       : Stok sisteme girdiği tarihteki TL maliyet (sabit)
-- Bu alanlar DIA stok kartında elle giriliyor; eksik olabilir.
-- ---------------------------------------------------------------------------
ALTER TABLE public.dia_stoklar
  ADD COLUMN IF NOT EXISTS ek_alan_1        numeric,
  ADD COLUMN IF NOT EXISTS ek_alan_1_doviz  text,
  ADD COLUMN IF NOT EXISTS ek_alan_2        numeric;

COMMENT ON COLUMN public.dia_stoklar.ek_alan_1
  IS 'Stok kartı yabancı para maliyeti (USD veya EUR)';
COMMENT ON COLUMN public.dia_stoklar.ek_alan_1_doviz
  IS 'ek_alan_1 para birimi: USD veya EUR (NULL = tanımsız)';
COMMENT ON COLUMN public.dia_stoklar.ek_alan_2
  IS 'Stok sisteme girdiğindeki TL maliyet (defter maliyeti)';

-- Stok aramaları için index (kalem maliyeti birleştirmesinde kullanılacak)
CREATE INDEX IF NOT EXISTS idx_dia_stoklar_stok_kart_kodu
  ON public.dia_stoklar (stok_kart_kodu);

-- ---------------------------------------------------------------------------
-- 2) tcmb_kurlar — TCMB günlük efektif satış kurları
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tcmb_kurlar (
  tarih       date PRIMARY KEY,
  usd_satis   numeric NOT NULL,
  eur_satis   numeric NOT NULL,
  kaynak      text DEFAULT 'TCMB today.xml',
  cekildi_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE public.tcmb_kurlar
  IS 'TCMB günlük efektif satış kurları (USD/EUR). Faturada kur yoksa fallback.';

-- ---------------------------------------------------------------------------
-- 3) dia_fatura_kalemleri — Satır seviyesinde fatura kalemleri (Faz 2)
-- ---------------------------------------------------------------------------
-- Faz 2'de DIA scf_faturadetay_listele (veya muadili) endpoint'i ile doldurulacak.
-- Şu an için iskelet — daily-report bu tablo boş olsa da çalışır.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dia_fatura_kalemleri (
  id              bigserial PRIMARY KEY,
  dia_key         bigint UNIQUE,
  fatura_no       text NOT NULL,
  fatura_tarihi   date,
  stok_kodu       text,
  stok_adi        text,
  miktar          numeric,
  birim           text,
  birim_fiyat_tl  numeric,
  satir_tutari_tl numeric,           -- KDV hariç, satır toplamı TL
  fatura_kuru     numeric,           -- DIA faturasındaki kur (TL/yabancı)
  fatura_doviz    text,              -- Faturanın döviz cinsi
  raw_data        jsonb,
  synced_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dia_fatura_kalemleri_fatura_no
  ON public.dia_fatura_kalemleri (fatura_no);
CREATE INDEX IF NOT EXISTS idx_dia_fatura_kalemleri_tarih
  ON public.dia_fatura_kalemleri (fatura_tarihi);
CREATE INDEX IF NOT EXISTS idx_dia_fatura_kalemleri_stok
  ON public.dia_fatura_kalemleri (stok_kodu);

COMMENT ON TABLE public.dia_fatura_kalemleri
  IS 'Fatura kalemleri (satır seviyesi). Faz 2''de DIA''dan sync edilecek.';

-- ---------------------------------------------------------------------------
-- 4) İndeksler — günlük/haftalık sorguların hızlanması için
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_dia_karlilik_tarih
  ON public.dia_karlilik_raporu (tarih);
CREATE INDEX IF NOT EXISTS idx_dia_karlilik_tip_tarih
  ON public.dia_karlilik_raporu (fatura_tipi, tarih);

-- ---------------------------------------------------------------------------
-- 5) View: vw_gunluk_satis_karlilik
--    Günlük raporun ana kaynağı. Fatura bazında defter kârı (Kâr 2).
--    Kâr 1 (güncel kur) alanları Faz 2'de doldurulacak.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_gunluk_satis_karlilik AS
SELECT
  tarih,
  fatura_no,
  cari_kodu,
  cari_unvan,
  ABS(toplam_tutar)                     AS kdv_haric_satis,
  COALESCE(maliyet, 0)                  AS defter_maliyet,
  COALESCE(kar, 0)                      AS defter_kar,
  COALESCE(kar_orani, 0)                AS defter_marj,
  -- Faz 2 için placeholder sütunlar (kalem + ek_alan_1 + kur ile hesaplanacak):
  NULL::numeric                         AS guncel_maliyet,
  NULL::numeric                         AS guncel_kar,
  NULL::numeric                         AS guncel_marj,
  NULL::numeric                         AS kur_farki_etkisi,
  maliyetsiz_mi,
  stok_kodu,
  fatura_tipi
FROM public.dia_karlilik_raporu
WHERE fatura_tipi = 'satis'
  AND COALESCE(gider_kalemi_mi, false) = false;

COMMENT ON VIEW public.vw_gunluk_satis_karlilik
  IS 'Günlük satış kârlılığı. Faz 1: defter kârı. Faz 2''de güncel kur sütunları gelecek.';

-- ---------------------------------------------------------------------------
-- 6) View: vw_gunluk_alis
--    Günlük raporda alış toplamı gösterimi için.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_gunluk_alis AS
SELECT
  tarih,
  fatura_no,
  cari_kodu,
  cari_unvan,
  ABS(toplam_tutar) AS kdv_haric_tutar,
  fatura_tipi
FROM public.dia_karlilik_raporu
WHERE fatura_tipi = 'alis';

-- ---------------------------------------------------------------------------
-- 7) View: vw_haftalik_satis_karlilik
--    Haftalık raporun gün-gün dağılım kaynağı.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_haftalik_satis_karlilik AS
SELECT
  tarih,
  COUNT(*)                              AS fatura_sayisi,
  SUM(ABS(toplam_tutar))                AS toplam_kdv_haric_satis,
  SUM(COALESCE(maliyet, 0))             AS toplam_defter_maliyet,
  SUM(COALESCE(kar, 0))                 AS toplam_defter_kar,
  CASE
    WHEN SUM(ABS(toplam_tutar)) > 0
      THEN ROUND(SUM(COALESCE(kar,0)) / SUM(ABS(toplam_tutar)) * 100, 2)
    ELSE 0
  END                                   AS defter_marj,
  COUNT(*) FILTER (WHERE maliyetsiz_mi) AS maliyetsiz_satir,
  -- Faz 2 placeholder:
  NULL::numeric                         AS toplam_guncel_kar,
  NULL::numeric                         AS guncel_marj,
  NULL::numeric                         AS kur_farki_etkisi
FROM public.dia_karlilik_raporu
WHERE fatura_tipi = 'satis'
  AND COALESCE(gider_kalemi_mi, false) = false
GROUP BY tarih
ORDER BY tarih;

COMMENT ON VIEW public.vw_haftalik_satis_karlilik
  IS 'Haftalık satış kârlılığı (günlük gruplanmış). Faz 2''de güncel kur sütunları gelecek.';

-- ---------------------------------------------------------------------------
-- 8) View: vw_haftalik_alis_ozet
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_haftalik_alis_ozet AS
SELECT
  tarih,
  COUNT(*)               AS fatura_sayisi,
  SUM(ABS(toplam_tutar)) AS toplam_kdv_haric
FROM public.dia_karlilik_raporu
WHERE fatura_tipi = 'alis'
GROUP BY tarih
ORDER BY tarih;

-- ============================================================================
-- Migration sonu. Geri alma için (gerekirse):
--   DROP VIEW IF EXISTS public.vw_haftalik_alis_ozet, public.vw_haftalik_satis_karlilik,
--                       public.vw_gunluk_alis, public.vw_gunluk_satis_karlilik;
--   DROP TABLE IF EXISTS public.dia_fatura_kalemleri, public.tcmb_kurlar;
--   ALTER TABLE public.dia_stoklar
--     DROP COLUMN IF EXISTS ek_alan_2,
--     DROP COLUMN IF EXISTS ek_alan_1_doviz,
--     DROP COLUMN IF EXISTS ek_alan_1;
-- ============================================================================
