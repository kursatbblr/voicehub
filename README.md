# 🎙 VoiceHub — Sesli Sohbet Sunucusu

WebRTC + Socket.IO + PeerJS tabanlı gerçek zamanlı sesli sohbet uygulaması.

## Özellikler

- 🏠 Oda oluşturma / katılma (6 haneli kod)
- 👥 Max 5 kişilik odalar
- 🎤 Yüksek kalite ses (48kHz, echo cancellation, noise suppression)
- 📡 Socket.IO ile oda yönetimi ve signaling
- 🔗 PeerJS Server ile peer-to-peer ses bağlantısı
- 🔇 Mikrofon aç/kapa, ses kısma
- 📊 Gerçek zamanlı ses seviye göstergesi
- 🌐 STUN/TURN desteği (farklı ağlar arası bağlantı)
- 📋 Aktif odalar listesi

## Kurulum

```bash
# Bağımlılıkları yükle
npm install

# Sunucuyu başlat
npm start
```

Sunucu `http://localhost:3000` adresinde çalışacak.

## VPS'e Deploy (Ubuntu/Debian)

### 1. Sunucuya Bağlan

```bash
ssh root@SUNUCU_IP
```

### 2. Node.js Kur

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 3. Projeyi Yükle

```bash
# Git ile
git clone <repo_url> /opt/voicehub
cd /opt/voicehub
npm install

# VEYA dosyaları SCP ile yükle
scp -r ./voice-chat-server root@SUNUCU_IP:/opt/voicehub
```

### 4. PM2 ile Çalıştır (Process Manager)

```bash
npm install -g pm2
cd /opt/voicehub
pm2 start src/server.js --name voicehub
pm2 startup
pm2 save
```

### 5. Nginx Reverse Proxy + SSL

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/voicehub`:

```nginx
server {
    listen 80;
    server_name voicehub.senindomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # PeerJS WebSocket
    location /peerjs {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/voicehub /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx

# SSL (HTTPS - WebRTC için şart!)
sudo certbot --nginx -d voicehub.senindomain.com
```

### 6. Firewall

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 3000
```

## Environment Variables

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `PORT` | `3000` | Sunucu portu |

## API Endpoints

| Endpoint | Açıklama |
|----------|----------|
| `GET /api/rooms` | Aktif odaları listele |
| `GET /api/rooms/:id` | Oda detayı |
| `GET /api/health` | Sunucu durumu |

## Mimari

```
┌─────────────────────────────────────────┐
│                 Client                   │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │ Socket.IO│  │  PeerJS  │  │ WebRTC │ │
│  │ Client   │  │  Client  │  │ Audio  │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
└───────┼──────────────┼────────────┼──────┘
        │              │            │
        ▼              ▼            │
┌───────────────────────────┐       │
│        Server             │       │
│  ┌──────────┐ ┌────────┐ │       │
│  │ Socket.IO│ │ PeerJS │ │       │
│  │  (Rooms) │ │ Server │ │       │
│  └──────────┘ └────────┘ │       │
└───────────────────────────┘       │
                                    │
        ┌───────────────────────────┘
        │  P2P Audio (direkt)
        ▼
┌──────────────┐
│  Diğer Peer  │
└──────────────┘
```

## Notlar

- **HTTPS zorunlu!** WebRTC mikrofon erişimi sadece HTTPS'de çalışır (localhost hariç).
- TURN sunucusu olarak ücretsiz `openrelay.metered.ca` kullanılıyor. Production için kendi TURN sunucunu kur (coturn).
- Oda boşalınca otomatik silinir.
- Host çıkınca otomatik yeni host atanır.
