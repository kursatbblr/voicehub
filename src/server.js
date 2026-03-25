const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ======================== CONFIG ========================
const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 5;

// ======================== MIDDLEWARE ========================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ======================== PEERJS SERVER ========================
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_discovery: false,
  // TURN/STUN config - ücretsiz Google STUN + gerekirse TURN eklenebilir
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Ücretsiz TURN sunucuları (test için)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  }
});

app.use('/peerjs', peerServer);

// ======================== SOCKET.IO ========================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ======================== ROOM STATE ========================
const rooms = new Map();
// Room structure:
// {
//   id: string,
//   name: string,
//   host: string (socketId),
//   createdAt: Date,
//   users: Map<socketId, { username, peerId, joinedAt, isMuted }>
// }

// ======================== HELPERS ========================
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function getRoomInfo(room) {
  const users = [];
  room.users.forEach((user, socketId) => {
    users.push({
      socketId,
      username: user.username,
      peerId: user.peerId,
      isMuted: user.isMuted,
      isHost: socketId === room.host
    });
  });
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    userCount: room.users.size,
    maxUsers: MAX_ROOM_SIZE,
    users
  };
}

function broadcastRoomUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const info = getRoomInfo(room);
  io.to(roomId).emit('room:update', info);
}

// ======================== SOCKET HANDLERS ========================
io.on('connection', (socket) => {
  console.log(`✅ Bağlandı: ${socket.id}`);
  let currentRoom = null;

  // ---- ODA OLUŞTUR ----
  socket.on('room:create', ({ username, peerId, roomName }, callback) => {
    const roomId = generateRoomCode();

    // Unique kontrol
    if (rooms.has(roomId)) {
      return callback({ error: 'Tekrar dene, kod çakıştı' });
    }

    const room = {
      id: roomId,
      name: roomName || `${username}'in Odası`,
      host: socket.id,
      createdAt: new Date(),
      users: new Map()
    };

    room.users.set(socket.id, {
      username,
      peerId,
      joinedAt: new Date(),
      isMuted: false
    });

    rooms.set(roomId, room);
    socket.join(roomId);
    currentRoom = roomId;

    console.log(`🏠 Oda oluşturuldu: ${roomId} by ${username}`);

    callback({ success: true, room: getRoomInfo(room) });
  });

  // ---- ODAYA KATIL ----
  socket.on('room:join', ({ roomId, username, peerId }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      return callback({ error: 'Oda bulunamadı! Kodu kontrol et.' });
    }

    if (room.users.size >= MAX_ROOM_SIZE) {
      return callback({ error: 'Oda dolu! Maksimum 5 kişi.' });
    }

    // Mevcut kullanıcıların peer ID'lerini al (yeni kişi bunlara bağlanacak)
    const existingPeers = [];
    room.users.forEach((user) => {
      existingPeers.push({
        peerId: user.peerId,
        username: user.username
      });
    });

    room.users.set(socket.id, {
      username,
      peerId,
      joinedAt: new Date(),
      isMuted: false
    });

    socket.join(roomId);
    currentRoom = roomId;

    console.log(`👋 ${username} odaya katıldı: ${roomId}`);

    // Odadaki herkese haber ver
    socket.to(roomId).emit('user:joined', {
      socketId: socket.id,
      username,
      peerId
    });

    callback({
      success: true,
      room: getRoomInfo(room),
      existingPeers
    });

    broadcastRoomUpdate(roomId);
  });

  // ---- MUTE DURUMU ----
  socket.on('user:mute', ({ isMuted }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (user) {
      user.isMuted = isMuted;
      socket.to(currentRoom).emit('user:mute-changed', {
        socketId: socket.id,
        peerId: user.peerId,
        isMuted
      });
    }
  });

  // ---- ODADAN ÇIKIŞ ----
  socket.on('room:leave', () => {
    handleLeave(socket, currentRoom);
    currentRoom = null;
  });

  // ---- BAĞLANTI KESİLMESİ ----
  socket.on('disconnect', () => {
    console.log(`❌ Ayrıldı: ${socket.id}`);
    handleLeave(socket, currentRoom);
  });

  function handleLeave(sock, roomId) {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.get(sock.id);
    const username = user ? user.username : 'Birisi';

    room.users.delete(sock.id);
    sock.leave(roomId);

    // Odadaki herkese haber ver
    sock.to(roomId).emit('user:left', {
      socketId: sock.id,
      username
    });

    // Oda boşsa sil
    if (room.users.size === 0) {
      rooms.delete(roomId);
      console.log(`🗑️ Oda silindi: ${roomId}`);
    } else {
      // Host gittiyse yeni host ata
      if (room.host === sock.id) {
        const newHost = room.users.keys().next().value;
        room.host = newHost;
        io.to(roomId).emit('room:new-host', { socketId: newHost });
      }
      broadcastRoomUpdate(roomId);
    }
  }

  // ---- SIGNAL RELAY (PeerJS yetmezse yedek) ----
  socket.on('signal:offer', ({ to, offer }) => {
    io.to(to).emit('signal:offer', { from: socket.id, offer });
  });

  socket.on('signal:answer', ({ to, answer }) => {
    io.to(to).emit('signal:answer', { from: socket.id, answer });
  });

  socket.on('signal:ice', ({ to, candidate }) => {
    io.to(to).emit('signal:ice', { from: socket.id, candidate });
  });
});

// ======================== REST API ========================
app.get('/api/rooms', (req, res) => {
  const list = [];
  rooms.forEach((room) => {
    list.push({
      id: room.id,
      name: room.name,
      userCount: room.users.size,
      maxUsers: MAX_ROOM_SIZE
    });
  });
  res.json({ rooms: list });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Oda bulunamadı' });
  res.json(getRoomInfo(room));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    rooms: rooms.size,
    connections: io.engine.clientsCount
  });
});

// ======================== PEERJS EVENTS ========================
peerServer.on('connection', (client) => {
  console.log(`🔗 PeerJS bağlandı: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`🔌 PeerJS ayrıldı: ${client.getId()}`);
});

// ======================== START ========================
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║                                          ║
║   🎙️  VoiceHub Server Çalışıyor!        ║
║                                          ║
║   🌐 http://localhost:${PORT}              ║
║   📡 Socket.IO: aktif                    ║
║   🔗 PeerJS: /peerjs                     ║
║   👥 Max oda kapasitesi: ${MAX_ROOM_SIZE} kişi        ║
║                                          ║
╚══════════════════════════════════════════╝
  `);
});
