# 🍿 CineSync — Birlikte Film & YouTube İzleme Platformu (Watch Party)

2-3 (veya daha fazla) arkadaşın aynı odaya bağlanarak **milisaniyelik senkronizasyonla** ortak YouTube videosu, Film veya Ekran Paylaşımı izleyebileceği gerçek zamanlı web uygulaması.

## ✨ Özellikler

1. **▶️ YouTube Senkronizasyonu**
   - Herhangi bir YouTube video linkini yapıştırdığınızda odadaki herkeste aynı anda açılır.
   - Bir kişi videoyu durdurduğunda, başlattığında veya ileri/geri sardığında diğer herkesin ekranında anında senkronize olur.
2. **🎬 Film / Video Linki & Lokal Dosya Senkronizasyonu**
   - **Doğrudan Link:** `.mp4`, `.webm` veya `.m3u8` (HLS) video linklerini doğrudan açıp birlikte izleyebilirsiniz.
   - **Bilgisayardan Lokal Dosya Seçme:** Aynı film dosyası (`.mp4`, `.mkv`, `.webm`) herkesin bilgisayarında indiriliyse dosya yükleme/kota derdi olmadan herkes kendi bilgisayarından dosyayı seçer; uygulama sadece oynatma/durdurma/saniye bilgisini senkronize eder.
   - **Altyazı Desteği:** `.srt` ve `.vtt` altyazı dosyalarını tek tıkla ekleyebilirsiniz (`.srt` dosyaları otomatik olarak WebVTT formatına dönüştürülür).
3. **🖥️ Canlı Ekran & Sekme Paylaşımı (WebRTC)**
   - Bir kişi tarayıcı sekmesini (Netflix, BluTV, Web vb.) veya tüm ekranını **ses dahil** paylaşabilir; odadaki diğer kişiler kurulumsuz canlı izler.
4. **💬 Canlı Sohbet & Uçuşan Emojiler**
   - Oda içi anlık mesajlaşma, sistem bildirimleri (kim odaya katıldı, kim videoyu hangi dakikaya sardı) ve video ekranında uçuşan anlık emoji tepkileri (`😂`, `😱`, `🔥`, `❤️`, `👏`, `🍿`, `🤯`).
5. **🔗 Tek Tıkla Davet Linki**
   - `?room=ODA-KODU` içeren davet linkini kopyalayıp arkadaşlarınıza gönderebilirsiniz.

---

## 🚀 Kurulum ve Çalıştırma

```bash
# Bağımlılıkları yükleyin
npm install

# Sunucuyu başlatın
npm start
```

Tarayıcınızdan **`http://localhost:3000`** adresine gidin.

---

## 🌐 Arkadaşlarla Uzaktan İzlemek İçin Ücretsiz Yayınlama

* **Hızlı Test (Tünel ile):** Kendi bilgisayarınızda çalışırken `npx localtunnel --port 3000` veya `ngrok http 3000` komutuyla anında paylaşılabilir bir HTTPS linki alabilirsiniz.
* **Kalıcı Sunucu (Render / Railway / Glitch):** Bu GitHub deposunu [Render.com](https://render.com) veya [Railway.app](https://railway.app) üzerine bağlayarak 7/24 ücretsiz bir Web Service olarak yayınlayabilirsiniz.
