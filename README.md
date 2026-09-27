# Lumo Panel

Discord botlarını web arayüzünden yükleyip, 7/24 çalıştıran kendi kendine yeten kontrol paneli.
Pterodactyl'in mantığını basitleştirip modern bir arayüze indirir: her bot kendi izole ortamında
çalışır, sırlar diske şifreli yazılır, konsol canlı akar.

**Sıfır çalışma zamanı bağımlılığı.** Node 20+ dışında hiçbir şey gerekmez — `npm install` yok,
framework yok, veritabanı sunucusu yok.

---

## GitHub Actions konusunda net olalım

İstenen şeyin bir kısmını **yapmadım ve yapmayacağım**: GitHub Actions'ı, 5 saatte bir kendini
yeniden tetikleyerek "sonsuz" çalışan bir ücretsiz hosting motoruna çevirmek.

Nedenleri kısa ve teknik:

- **Kural ihlali.** GitHub'ın Kabul Edilebilir Kullanım Politikası'na göre Actions, depoyla
  ilişkili yazılımın üretimi/testi/dağıtımı için verilir; sürekli çalışan bir servis barındırmak
  için kullanılamaz.
- **Teknik olarak da çalışmaz.** Her job en fazla 6 saat yaşar, runner'lar geçicidir: kalıcı disk,
  kalıcı port ve kalıcı bellek yoktur. Discord gateway oturumu her devirde kopar, botun durumu
  sıfırlanır. Yeniden tetikleme zinciri de bir yerde kopar.
- **Sonuç:** ilk gün hesap askıya alınır.

Bunun yerine, istenen *sonucu* gerçekten sağlayan yolu kurdum: **panel + süpervizör + bot başına
otomatik yeniden başlatma.** Actions ise depoda yalnızca CI/CD (test, imaj derleme, sunucuya
dağıtım) için kullanılıyor. Ücretsiz 7/24 seçenekleri için [aşağıya](#gerçek-724-seçenekleri) bak.

---

## Neler var

| Alan | Durum |
| --- | --- |
| Modern koyu tema arayüz (SPA, bağımlılıksız) | ✅ |
| Kullanıcı adı + parola girişi (scrypt), oturum çerezi | ✅ |
| İlk açılışta yönetici kurulumu | ✅ |
| Bot CRUD, başlat / durdur / yeniden başlat | ✅ |
| Canlı konsol (SSE) + stdin'e girdi gönderme | ✅ |
| Log geçmişi (son 1500 satır, sunucu tarafında) | ✅ |
| Dosya yöneticisi: listele, oku, düzenle, yükle, sil, klasör | ✅ |
| Sırlar: AES-256-GCM ile şifreli kasa, bota yalnızca kendi sürecinde aktarılır | ✅ |
| Bot başına Docker izolasyonu (ağ, yetki, cpu/bellek/pid sınırı) | ✅ |
| Otomatik yeniden başlatma (artan bekleme + çökme koruması) | ✅ |
| Panel/ makine yeniden başlayınca botları otomatik ayağa kaldırma | ✅ |
| Denetim kaydı (kim, ne zaman, ne yaptı — sır içermez) | ✅ |
| 2FA (TOTP), çok kullanıcı, zamanlanmış yeniden başlatma | ⏳ yol haritasında |

---

## 3 dakikada çalıştır (Docker'sız, geliştirme)

```bash
cp .env.example .env
# .env içine PANEL_MASTER_KEY yaz (64 hex karakter):
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"

npm start          # → http://localhost:8080
```

İlk açılışta panel yönetici hesabı oluşturmanı ister. Sonra:

1. **Bot oluştur** → isim ver (ör. "Moderasyon").
2. **Dosyalar** sekmesi → botunun dosyalarını yükle (`index.js`, `package.json`, `komutlar/…`).
3. **Ayarlar** sekmesi → `DISCORD_TOKEN` ve diğer sırları ortam değişkeni olarak ekle.
4. **Başlat** → konsoldan canlı logları izle.

> Bu modda `PANEL_BOT_DRIVER=local` olduğu için botlar paneli çalıştıran kullanıcıyla aynı
> ortamı paylaşır. Hızlı denemek için uygundur, izolasyon **zayıftır**. Üretimde Docker kullan.

---

## Üretim kurulumu (VPS + Docker + HTTPS)

Panel bir konteynerde çalışıp host'un Docker soketini kullanır. Bu yüzden **bot dizini host'ta ve
konteynerde aynı mutlak yolda olmalıdır** (aksi halde `docker run -v` host'ta geçersiz bir yol alır).
Compose dosyası bu yüzden `LUMO_DIR` üzerinden çalışır:

```bash
# 1) Sunucuda projeyi sabit bir yere klonla
sudo mkdir -p /opt/lumo-panel && sudo chown "$USER" /opt/lumo-panel
git clone <repo-url> /opt/lumo-panel && cd /opt/lumo-panel

# 2) Sırları hazırla
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # PANEL_MASTER_KEY'e yaz
# .env içinde: LUMO_DIR=/opt/lumo-panel  ve  PANEL_TRUST_PROXY=1

# 3) Ayağa kaldır
docker compose up -d
docker compose logs -f panel
```

Ardından HTTPS için ters proxy (Caddy en kolayı):

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # alan adını düzenle
sudo systemctl reload caddy
```

Docker'sız (bare-metal) kurulum için `deploy/systemd/lumo-panel.service` hazır bir systemd birimi
içerir: `Restart=always` sayesinde panel ölürse 3 saniyede geri gelir, sertleştirme ayarları
(ProtectSystem, NoNewPrivileges, PrivateTmp) açıktır.

---

## 7/24 nasıl sağlanıyor

Kesintisiz çalışma dört ayrı katmanın birlikte çalışmasıyla olur. Hiçbiri tek başına yeterli değil:

1. **Panel süreci** — systemd `Restart=always` veya Docker `restart: unless-stopped`. Panel çökerse
   ya da makine yeniden başlarsa panel kendi kendine geri gelir.
2. **Panel açılışı → botlar** — panel ayağa kalktığında "açılışta otomatik başlat" işaretli tüm
   botlar kendiliğinden başlar. Böylece yeniden başlatma botları da beraberinde getirir.
3. **Bot çökmesi → otomatik yeniden başlatma** — süreç beklenmedik şekilde ölürse artan bekleme
   süresiyle (1s → 2s → 4s → … → en fazla 30s) yeniden başlatılır.
4. **Çökme koruması** — bir bot saat içinde 20'den fazla çökerse döngüye girmemesi için otomatik
   yeniden başlatma durur ve bot "koruma" durumuna geçer. Sağlıklı çalışan (60 saniyeden uzun yaşayan)
   bir botun çökme geçmişi sıfırlanır, yani ara sıra çöken bot kalıcı olarak düşmez.

Bot başına izlenebilenler: durum, PID, çalışma süresi, yeniden başlatma sayısı, çıkış kodu,
son hata, bellek kullanımı (Linux'ta) ve tüm konsol çıktısı.

---

## Güvenlik modeli

**Şifreleme (beklemede / at rest).**
Panelin tüm durumu — kullanıcılar, bot tanımları, **bot token'ları** — tek bir dosyada
(`data/panel.enc`) AES-256-GCM ile şifreli tutulur. Ana anahtar `PANEL_MASTER_KEY` ortam
değişkeninden gelir; veritabanında veya dosyada saklanmaz. Dosyayı kopyalayan biri anahtar olmadan
hiçbir şey okuyamaz, veriyi kurcalarsa GCM kimlik doğrulaması çözümlemeyi reddeder.

Parolalar scrypt + rastgele salt ile tek yönlü özetlenir ve sabit zamanlı karşılaştırılır.
Oturumlar HMAC imzalı, `HttpOnly` + `SameSite=Strict` çerezlerdir; sunucuda oturum durumu tutulmaz.

**Panel erişimi.**

- Katı CSP (`unsafe-inline` yok), `X-Frame-Options: DENY`, `nosniff`, COOP/CORP.
- Siteler arası sahte istek koruması: `Origin` başlığı doğrulanır + `SameSite=Strict`.
- Girişte IP başına hız sınırı (10 dakikada 10 hatalı deneme).
- Kullanıcı adı yokken de parola doğrulaması yapılır (zamanlama ile kullanıcı adı sızmasın diye).
- Tüm işlemler denetim kaydına yazılır (sır içermez).

**Bot izolasyonu (`docker` sürücüsü).**

Her bot ayrı bir konteynerde çalışır:

| Önlem | Değer |
| --- | --- |
| Yetenekler | `--cap-drop ALL` |
| Ayrıcalık yükseltme | `--security-opt no-new-privileges` |
| Kök dosya sistemi | `--read-only` (+ `/tmp` tmpfs) |
| Kaynak sınırı | `--memory 512m --cpus 0.5 --pids-limit 256` |
| Ağ | bot başına ayrı ağ → botlar birbirine erişemez |
| Mount | yalnızca kendi dizini (`bots/<id>`) |

Yani bir bot ne panele ne başka bir botun dosyalarına erişemez; diğer botlara ağ üzerinden de
bağlanamaz.

**Panelin çalıştırma ortamı ayrıca korunur.** Panele bağlı bota `process.env` olduğu gibi
aktarılmaz: yalnızca `PATH`, `HOME`, `TMPDIR` gibi zararsız değişkenler geçer. Böylece
`PANEL_MASTER_KEY` bot koduna **sızmaz** (bu, `tests/bots.test.js` içinde test edilir).
Dosya API'sinde `..`, mutlak yollar ve sembolik bağlantılar reddedilir; her yol `realpath`
karşılaştırmasıyla bot dizinine hapsedilir.

**Bilinen sınırlar (dürüst olalım).**

- Docker soketini mount etmek panele **host üzerinde root'a denk** yetki verir. Bu yüzden paneli
  yalnızca bu işe ayrılmış bir makinede çalıştır; mümkünse **rootless Docker** kullan.
- `local` sürücüde botlar paneli çalıştıran kullanıcıyla aynı yetkiye sahiptir. Geliştirme dışında
  kullanma.
- Şifreleme "beklemede"dir: çalışan bir botun token'ı kendi süreç belleğinde düz durur (başka türlü
  Discord'a bağlanamaz). Diski şifreleyerek (LUKS) ve dosya izinlerini kısarak bunu da sınırla.
- 2FA ve çok kullanıcı henüz yok.

---

## Gerçek 7/24 seçenekleri

| Seçenek | Ne veriyor | Not |
| --- | --- | --- |
| **Oracle Cloud Always Free** | 4 ARM çekirdeğe kadar kalıcı ücretsiz VM (24 GB RAM'e kadar) | Gerçek ücretsiz seçeneklerin en cömerti; kart doğrulaması ister, boşta kalan kaynak geri alınabilir |
| **Kendi bilgisayarın / eski laptop** | Sıfır ek maliyet, panel LAN'da çalışır | Uyku modunu kapat, dinamik IP için tünel (Cloudflare Tunnel) kullan |
| **Raspberry Pi / mini PC** | 7/24, düşük tüketim, sessiz | Tek seferlik donanım maliyeti |
| **Fly.io / Koyeb** | Konteyner barındırma, ücretsiz kota | Uykuya dalma ve kota sınırları var; kalıcı disk ücretli olabilir |
| **Ucuz VPS (Hetzner, Contabo…)** | ~3–5 €/ay, tam kontrol, kalıcı IP | En sorunsuz ve öngörülebilir yol |

Kendi bilgisayarında çalıştırırken dışarıdan erişim için port açmak yerine
**Cloudflare Tunnel** kullanmak daha güvenlidir: HTTPS ve kimlik doğrulama bedava gelir, router'da
port açman gerekmez.

---

## API özeti

Tüm uçlar `/api` altındadır; yazma işlemleri oturum çerezi + `Origin` doğrulaması ister.

| Yöntem | Yol | İş |
| --- | --- | --- |
| `GET` | `/api/health` | Sağlık kontrolü (kimlik gerekmez) |
| `GET` | `/api/setup/status` | Kurulum gerekiyor mu (kimlik gerekmez) |
| `POST` | `/api/setup` | İlk yönetici hesabı (yalnızca kullanıcı yokken) |
| `POST` | `/api/auth/login` \| `/logout` | Oturum aç / kapat |
| `POST` | `/api/auth/password` | Parola değiştir |
| `GET` | `/api/me`, `/api/system`, `/api/audit` | Oturum, makine durumu, denetim kaydı |
| `GET`/`POST` | `/api/bots` | Listele / oluştur |
| `GET`/`PATCH`/`DELETE` | `/api/bots/:id` | Oku / güncelle / sil |
| `POST` | `/api/bots/:id/start` \| `/stop` \| `/restart` \| `/input` | Yaşam döngüsü |
| `GET` | `/api/bots/:id/logs?since=` \| `/stream` | Log geçmişi / SSE canlı akış |
| `GET`/`PUT`/`DELETE` | `/api/bots/:id/file?path=` | Dosya oku / yaz / sil |
| `GET` | `/api/bots/:id/files?path=` | Dizin listele |
| `POST` | `/api/bots/:id/mkdir` \| `/upload` | Klasör oluştur / çoklu yükleme (base64) |

---

## Geliştirme

```bash
npm start      # panel
npm run dev    # --watch ile otomatik yeniden başlatma
npm test       # 29 test: şifreleme, yol kaçışı, süreç yaşam döngüsü, uçtan uca HTTP
```

Testler ayrı bir süreçte gerçek panel örneği başlatır ve şunları doğrular: kurulum akışı, yetkisiz
erişimin reddi, CSRF koruması, dosya yolu kaçışının engellenmesi, botun başlatılıp log üretmesi,
çöken botun otomatik geri gelmesi, `PANEL_MASTER_KEY`'in bota sızmaması ve token'ların diskte düz
metin görünmemesi.

```
server/
  index.js         HTTP sunucusu, rotalar, kimlik, statik dosyalar
  lib/crypto.js    AES-256-GCM, scrypt, HMAC oturum, ana anahtar ayrıştırma
  lib/store.js     Şifreli, atomik yazılan durum deposu
  lib/bots.js      Bot süreç yöneticisi, Docker izolasyonu, log/restart mantığı
  lib/http.js      Gövde okuma, cookie, güvenlik başlıkları, hız sınırı
  lib/system.js    Makine ve süreç istatistikleri
public/            Arayüz (bağımlılıksız SPA)
deploy/            systemd birimi ve Caddy örneği
tests/             node:test ile birim + uçtan uca testler
```

---

## Yol haritası

- TOTP tabanlı 2FA ve çok kullanıcılı roller (izleyici / operatör / yönetici)
- Bot başına zamanlanmış yeniden başlatma (ör. her gün 04:00)
- Docker `stats` akışıyla canlı CPU/bellek grafiği
- Bot başlatma sırasını ve bağımlılıklarını tanımlayan "bot grupları"
- Yedekleme: şifreli `panel.enc` + bot dizinlerinin zamanlanmış anlık görüntüsü
- Discord OAuth ile tek tıkla bot kurulumu
