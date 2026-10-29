# GIDAOKUR

Gıda etiketlerini, besin bilgilerini ve olası alerjen eşleşmelerini daha anlaşılır sunan çok sayfalı bir web uygulaması.

## Sayfalar

- index.html — başlangıç ve ana özelliklere kısa yollar
- nasil-calisir.html — kullanım adımları ve veri açıklamaları
- urun-incele.html — barkod/ürün araması, fotoğraf tarama ve elle etiket girişi
- alerjenlerim.html — yerel demo hesabı, alerjen tercihleri ve yıldız ilerlemesi
- rehber.html — etiket okuma rehberi

## Başlatma

1. ZIP'i bir klasöre çıkar.
2. Hızlı deneme için index.html dosyasını aç; üst menüdeki başlıklar ayrı HTML sayfalarını açar.
3. Hesap, fotoğraftan barkod/OCR ve ürün sorgusu gibi özellikler için internet bağlantısı gerekir.
4. İsteğe bağlı yerel sunucu için Windows'ta baslat.bat dosyasını çalıştır ve http://127.0.0.1:3000 adresini aç.
5. GitHub Pages'e yayımlarken bütün HTML, CSS, JS ve logo dosyalarını depo kökünde birlikte tut.

## Ürün verisi ve görsel tarama

Barkodla ürün kaydı Open Food Facts API'sinden sorgulanır. Ürün fotoğrafında ZXing ile barkod çözme denenir; barkod bulunamazsa Tesseract OCR ambalaj yazısını arama ifadesi olarak çıkarmaya çalışır. OCR sonucu tahmindir; bulunan ürünü kontrol et. Bu özellikler için tarayıcıda internet bağlantısı ve ilgili üçüncü taraf kütüphanelerin yüklenmesi gerekir. Veri tabanında her ürün bulunmayabilir; ürün adıyla arama da eşleşme garantisi vermez.

Ürün bilgisinin bir kısmı Open Food Facts topluluk kayıtlarından gelir ve eksik, eski veya hatalı olabilir. Veri bulunmayan alanlarda tahmin üretilmez. Ürünün güncel ambalajını her zaman kontrol et.

## Renk ve alerjen uyarıları

Besin renkleri sistemdeki besin değeri eşiklerini özetler: kırmızı yüksek, sarı orta, yeşil düşük aralık. Bunlar sağlık tavsiyesi veya ürünün “sağlıklı/güvenli” olduğu garantisi değildir.

Alerjen taraması içerik ve uyarı metninde otomatik ifade eşleştirmesidir. Koyu kırmızı eşleşme uyarısı gösterir; eşleşme bulunmaması üründe alerjen olmadığı anlamına gelmez. Alerji durumunda paketin içindekiler ve çapraz bulaşma uyarılarını incele.

## Yıldızlar ve hesap

Hesap, tercih ve yıldızlar bu demo sürümünde yalnızca aynı tarayıcının yerel depolamasında tutulur. 20 farklı ürün barkodu için en fazla 20 yıldız alınabilir; 1 yıldız = 2 TL ve 20 yıldız = 40 TL değerinde DEMO kupon oluşturur. Kupon gerçek mağazada geçerli değildir. Gerçek çevrim içi hesap, e-posta doğrulama ve cihazlar arası eşitleme için güvenli bir sunucu ve iş ortağı gerekir.

Yerel veritabanı ve ortam dosyalarını GitHub'a ekleme.