# Lumo Panel

Discord botlarını (ve genel Node/Python servislerini) web arayüzünden kurup 7/24 çalıştıran
kontrol paneli. **Pterodactyl'in mantığı** buraya taşındı — ama Laravel/MySQL/Redis/Wings
yığını olmadan: tek Node süreci, tek şifreli durum dosyası, sıfır çalışma zamanı bağımlılığı.

> Bu sürüm, önceki sürümün yeniden yazımıdır. Yeni olan: **egg şablonları**, **port tahsisi
> havuzu**, **kurulum adımı (installer)**, **başlangıç tespiti**, **çökme koruması**,
> **zamanlanmış görevler**, **şifreli/güvenli yedekler**, **roller** ve **denetim kaydı**.

---

## Pterodactyl'den ne taşındı, ne taşınmadı

| Pterodactyl kavramı | Lumo'daki karşılığı | Durum |
| --- | --- | --- |
| Nest / Egg (çalışma ortamı şablonu) | `server/lib/eggs.js` + yönetici tanımlı egg'ler | ✅ |
| Egg değişkenleri (`{{VAR}}`, sır işaretleme) | `sanitizeVariables`, `renderTemplate`, `maskVariables` | ✅ |
| Installer container (bir kez çalışan kurulum) | `POST /api/servers/:id/power {action:"install"}` | ✅ |
| Egg'e göre Docker imajı + başlangıç komutu | `containerArgs()` | ✅ |
| Kaynak limitleri (bellek/CPU/pid/disk) | `--memory --cpus --pids-limit` + disk denetimi | ✅ |
| Allocation (port havuzu, sunucuya port atama) | `server/lib/allocations.js` | ✅ |
| Power durumları: starting/running/stopping/offline | `server/lib/servers.js` → `STATUS` | ✅ |
| Startup detection + startup timeout | egg `startupDetection` / `startupTimeoutMs` | ✅ |
| Otomatik yeniden başlatma + çökme koruması | artan bekleme (1s→30s) + pencere başına çökme limiti | ✅ |
| Schedules (cron: güç / komut / yedek) | `server/lib/schedules.js` + `cron.js` | ✅ |
| Backups (al / indir / geri yükle / saklama) | `server/lib/backups.js` (saf Node tar.gz) | ✅ |
| Dosya yöneticisi (jail'li) | `server/lib/files.js` | ✅ |
| Canlı konsol + stdin | SSE + `POST /input` | ✅ |
| Alt kullanıcılar / roller | `viewer` · `operator` · `admin` | ✅ |
| Suspension (askıya alma) | limit aşımı veya yönetici kararı | ✅ |
| Node'lara dağıtım (Wings daemon) | Yok — tek makine. | ❌ |
| MySQL/Redis veritabanı sunucuları | Yok — şifreli dosya durumu. | ❌ |
| Egg üzerinden oyun sunucusu şablonları | Kapsam dışı (bot/servis odaklı). | ❌ |
| 2FA (TOTP) | Yol haritasında. | ⏳ |

---

## Hızlı başlangıç (Docker'sız, geliştirme)

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # PANEL_MASTER_KEY'e yaz
npm start                 # → http://localhost:8080
npm test                  # 19 test
```

`npm install` yok — bağımlılık listesi boş. Node 20+ yeterli.

İlk açılışta panel yönetici hesabı kurmanı ister; sonra:

1. **+ Yeni** → sunucuya ad ver, **egg** seç (Node.js/discord.js, Python/discord.py, serbest komut…).
2. **Değişkenler** → `DISCORD_TOKEN` gibi sırları gir. Sırlar şifreli kasada tutulur ve API'de `••••••••` görünür.
3. **Dosyalar** → botunun dosyalarını yükle, gerekirse düzenle.
4. **Kurulumu Çalıştır** → egg'in install komutu (örn. `npm install --omit=dev`) bir kez çalışır.
5. **Başlat** → konsoldan canlı izle. `Başlangıç tespit edildi` satırı gelince durum `running` olur.

> Geliştirmede `PANEL_BOT_DRIVER=local`: süreçler panel kullanıcısıyla aynı ortamda çalışır,
> **izolasyon zayıftır**. Üretimde `docker` kullan.

---

## Üretim kurulumu (VPS + Docker + HTTPS)

Panel bot konteynerlerini host'un Docker soketi üzerinden başlatır; `docker run -v <yol>`
komutundaki yol **host'ta** geçerli olmalıdır. Bu yüzden sunucu dizini host'ta ve panel
konteynerinde aynı mutlak yolda mount edilir:

```bash
sudo mkdir -p /opt/lumo-panel && sudo chown "$USER" /opt/lumo-panel
git clone <repo-url> /opt/lumo-panel && cd /opt/lumo-panel

cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"   # PANEL_MASTER_KEY
# .env içinde ayrıca: LUMO_DIR=/opt/lumo-panel  ve  PANEL_TRUST_PROXY=1

docker compose up -d --build
docker compose logs -f panel
```

HTTPS için ters proxy (Caddy en kolayı; SSE akışını bozmaması için `flush_interval -1` ayarlıdır):

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # alan adını düzenle
sudo systemctl reload caddy
```

Docker'sız kurulum için `deploy/systemd/lumo-panel.service` hazırdır:
`Restart=always`, `ProtectSystem=strict`, boş `CapabilityBoundingSet` ve yalnızca
`data/` + `servers/` dizinlerine yazma izni.

### Klasör düzeni

```
server/
  index.js         HTTP API, rotalar, kimlik, roller, statik dosyalar
  lib/config.js    .env + ortam değişkenleri → tipli yapılandırma
  lib/crypto.js    AES-256-GCM kasa, scrypt parola, HMAC oturum, ana anahtar
  lib/store.js     atomik yazılan şifreli durum + denetim kaydı
  lib/eggs.js      nest/egg şablonları, değişken doğrulama, `{{VAR}}` render
  lib/docker.js    Docker sürücüsü: izolasyon bayrakları, ağ, stats, installer
  lib/servers.js   süpervizör: durumlar, limitler, başlangıç tespiti, backoff
  lib/files.js     realpath ile hapsedilmiş dosya yöneticisi
  lib/backups.js   tar.gz yedek/geri yükleme + saklama politikası
  lib/schedules.js cron görev motoru (güç / komut / yedek)
  lib/cron.js      5 alanlı cron çözümleyici
  lib/allocations.js  port havuzu
  lib/tar.js       bağımlılıksız tar yazıcı/okuyucu
  lib/http.js      gövde, çerez, güvenlik başlıkları, hız sınırı
  lib/system.js    makine/süreç istatistikleri
public/            arayüz (bağımlılıksız SPA, satır içi script yok)
deploy/            systemd birimi + Caddy örneği
tests/             node:test ile birim + uçtan uca testler
data/              panel.enc (şifreli durum) + backups/
servers/<id>/      bot dosyaları (yalnızca kendi konteynerine mount edilir)
```

---

## API özeti

Tüm uçlar `/api` altındadır. Yazma istekleri oturum çerezi ister; tarayıcı `Origin`
başlığı gönderdiğinde eşleşmezse 403 döner. Rol gereksinimleri aşağıda belirtilmiştir.

| Yöntem | Yol | İş | Rol |
| --- | --- | --- | --- |
| `GET` | `/api/health` · `/api/setup/status` | Sağlık / kurulum durumu | — |
| `POST` | `/api/setup` | İlk yönetici hesabı | — |
| `POST` | `/api/auth/login` · `/logout` · `/password` | Oturum işlemleri | — / oturum |
| `GET` | `/api/me` · `/api/system` · `/api/allocations` | Oturum, makine, port havuzu | izleyici |
| `GET` | `/api/eggs` | Nest + egg listesi (sırlar gizli) | izleyici |
| `POST`/`DELETE` | `/api/eggs[/:id]` | Özel egg ekle / sil | yönetici |
| `GET`/`POST` | `/api/servers` | Listele / oluştur | izleyici / yönetici |
| `GET`/`PATCH`/`DELETE` | `/api/servers/:id` | Oku / güncelle / sil (`?files=1`) | izleyici / operatör / yönetici |
| `POST` | `/api/servers/:id/power` | `start` · `stop` · `restart` · `kill` · `install` | operatör |
| `POST` | `/api/servers/:id/input` | Konsola girdi | operatör |
| `GET` | `/api/servers/:id/logs?since=` · `/stream` | Log geçmişi / SSE canlı akış | izleyici |
| `POST` | `/api/servers/:id/suspend` · `/resume` | Askıya al / çıkar | yönetici |
| `GET`/`PUT`/`DELETE` | `/api/servers/:id/file?path=` | Dosya oku / yaz / sil | izleyici / operatör |
| `GET` | `/api/servers/:id/files?path=` · `/usage` · `/download?path=` | Dizin, disk kullanımı, indirme | izleyici |
| `POST` | `/api/servers/:id/mkdir` · `/rename` · `/upload` | Klasör, taşıma, çoklu yükleme | operatör |
| `GET`/`POST` | `/api/servers/:id/backups` | Yedekleri listele / al | izleyici / operatör |
| `GET`/`POST`/`DELETE` | `/api/backups/:id/download` · `/restore` · `/api/backups/:id` | İndir / geri yükle / sil | operatör |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/schedules[/:id]` (+`/run`) | Zamanlanmış görevler | izleyici / operatör |
| `GET`/`POST`/`PATCH`/`DELETE` | `/api/users[/:id]` | Kullanıcı ve rol yönetimi | yönetici |
| `GET` | `/api/audit?limit=` | Denetim kaydı | operatör |

---

## Güvenlik modeli

**Beklemede şifreleme.** Panelin tüm durumu — kullanıcılar, sunucular, **bot token'ları** —
tek dosyada (`data/panel.enc`) AES-256-GCM ile şifrelenir. Ana anahtar yalnızca
`PANEL_MASTER_KEY` ortam değişkeninden gelir; dosyada veya veritabanında durmaz. Dosyayı
kopyalayan biri anahtar olmadan hiçbir şey okuyamaz; kurcalarsa GCM kimlik doğrulaması
çözümlemeyi reddeder (yanlış anahtarla açmak veriyi bozmak yerine paneli durdurur).

Parolalar scrypt + rastgele salt ile özetlenir ve sabit zamanlı karşılaştırılır; kullanıcı
yoksa da aynı maliyette scrypt çalıştırılır (kullanıcı adı zamanlama ile sızmasın diye).
Oturumlar HMAC ile imzalanmış `HttpOnly` + `SameSite=Strict` çerezlerdir; sunucuda oturum
tablosu yoktur ve parola değişince tüm eski çerezler anında geçersizleşir.

**Egg/API tarafı.** Egg değişkenleri beyaz listeye göre doğrulanır (`^[A-Z_][A-Z0-9_]*$`),
zorunlu alanlar denetlenir, sırlar API yanıtlarında maskelenir ve denetim kaydına **asla**
yazılmaz. Docker komutları hiçbir zaman kabuktan geçmez: `execFile`/`spawn` argüman dizisi
kullanılır, dolayısıyla sunucu adına yazılan metin komut çalıştıramaz.

**Bot izolasyonu (`docker` sürücüsü).**

| Önlem | Değer |
| --- | --- |
| Yetenekler | `--cap-drop ALL` |
| Ayrıcalık yükseltme | `--security-opt no-new-privileges` |
| Kök dosya sistemi | `--read-only` (+ `/tmp` tmpfs) |
| Kaynak sınırı | `--memory` · `--cpus` · `--pids-limit` (sunucu bazında) |
| Ağ | bot başına ayrı köprü (`lumo-net-<id>`) → botlar birbirini göremez |
| Mount | yalnızca kendi dizini (`servers/<id>`) |
| Ortam | yalnızca egg değişkenleri + `PATH/HOME/TMPDIR/LANG/TZ` |
| Port | yalnızca tahsis edilen port, varsayılan `127.0.0.1`'e bağlı |

`PANEL_MASTER_KEY` bota **sızmaz**: ortam değişkenleri `process.env` kopyalanarak değil,
açık bir listeyle kurulur — bu davranış testlerde doğrulanır.

Yedekler geri yüklenirken her arşiv girişi yeniden doğrulanır (`..`, mutlak yol ve
Windows sürücü harfi reddedilir), ayrıca sha256 özeti uyuşmayan arşiv geri yüklenmez.
Dosya yöneticisi tüm yolları `realpath` ile sunucu dizinine hapseder; sembolik bağlarla
dışarı çıkma denemesi engellenir.

**Bilinen sınırlar (dürüst olalım).**

- Docker soketini panele vermek, panele pratikte **host root'una denk** yetki verir.
  Paneli yalnızca bu işe ayrılmış bir makinede çalıştır; mümkünse rootless Docker kullan.
- `local` sürücüde izolasyon yoktur; geliştirme dışında kullanma. Aynı nedenle bu sürücü
  bellek/CPU ölçümü de vermez (kutular 0 / — kalır); metrikler Docker `stats` akışından gelir.
- Diskteki limit, konteyner seviyesinde kota değil **denetim**tir: kullanım limiti aşarsa
  panel sunucuyu askıya alır (XFS prjquota kuruluysa `--storage-opt` ile sertleştirilebilir).
- SSH ile çalışan botlar için idealdir; düşük gecikmeli ses (voice) kullanımı CPU
  sınırlarından etkilenebilir.
- Çalışan bir botun token'ı kendi süreç belleğinde düz durur (Discord'a başka türlü
  bağlanamaz). Diski şifreleyerek (LUKS) ve dosya izinlerini kısarak sınırla.

---

## Geliştirme ve testler

```bash
npm start      # panel
npm run dev    # --watch ile yeniden başlatma
npm test       # 19 test
```

Arayüz CSP'si `'unsafe-inline'` olmadan çalışır: `public/` altında **satır içi `script` veya
`style` kullanılmaz** (satır içi `style` özniteliği tarayıcıda sessizce yok sayılır). Sabit
değerler `public/styles.css` içindeki yardımcı sınıflarla, dinamik değerler CSSOM
(`el.style.width = ...`) ile uygulanır.

Testler gerçek süreçler ve gerçek bir HTTP sunucusu başlatır:

- `tests/crypto.test.js` — ana anahtar ayrıştırma, GCM gidiş-dönüş, kurcalama reddi,
  scrypt doğrulama, oturum bileti imzası/süresi.
- `tests/core.test.js` — tar gidiş-dönüş (uzun yollar dahil), kötü niyetli arşiv girişleri,
  cron ayrıştırma/eşleştirme, dosya hapsi (mutlak yol, `..`, sembolik bağ), egg doğrulama,
  port havuzu tükenmesi.
- `tests/servers.test.js` — başlangıç tespiti, konsola girdi, `PANEL_MASTER_KEY` sızıntısı,
  otomatik yeniden başlatma, çökme koruması, başlangıç zaman aşımı, disk limitinde askıya alma.
- `tests/api.test.js` — kurulum akışı, CSRF reddi, yetkisiz erişim, sunucu oluşturma,
  başlatma, log akışı, yedek al/geri yükle, görev CRUD + çalıştırma, roller, parola değişimi
  sonrası oturum düşmesi, yol kaçışı denemeleri, denetim kaydında sır olmaması.

## Yol haritası

- TOTP tabanlı 2FA ve API anahtarları (otomasyon için)
- Docker `stats` akışıyla canlı CPU/bellek grafiği (şu an 5 saniyelik örnekleme)
- Bot grupları: başlatma sırası ve bağımlılıklar
- Egg içi `configFiles` ile hazır yapılandırma üretimi
- Yedeklerin S3/SFTP'ye kopyalanması ve zamanlanmış dışa aktarım
- `--storage-opt` ile disk kotasının sertleştirilmesi
