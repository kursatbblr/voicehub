const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const MAX_ROOM_SIZE = 5;
const MAX_CHAT_HISTORY = 100;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ======================== PEERJS ========================
const peerServer = ExpressPeerServer(server, {
  debug: true, path: '/', allow_discovery: false, proxied: true,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  }
});
app.use('/peerjs', peerServer);

// ======================== SOCKET.IO ========================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  allowEIO3: true, pingTimeout: 60000, pingInterval: 25000,
  path: '/socket.io/'
});

const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function getRoomInfo(room) {
  const users = [];
  room.users.forEach((user, socketId) => {
    users.push({
      socketId, username: user.username, peerId: user.peerId,
      isMuted: user.isMuted, isHost: socketId === room.host, color: user.color
    });
  });
  return {
    id: room.id, name: room.name, host: room.host,
    hasPassword: !!room.password,
    userCount: room.users.size, maxUsers: MAX_ROOM_SIZE, users
  };
}

function broadcastRoomUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room:update', getRoomInfo(room));
}

const USER_COLORS = ['#7c6cf0','#2dd4a8','#f06060','#f0c040','#60a0f0','#f080c0','#80d060','#c080f0','#f0a040','#40d0d0'];

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ username, peerId, roomName, password }, callback) => {
    const roomId = generateRoomCode();
    if (rooms.has(roomId)) return callback({ error: 'Tekrar dene' });
    const color = USER_COLORS[0];
    const room = {
      id: roomId, name: roomName || `${username}'in Odası`,
      host: socket.id, password: password || null,
      createdAt: new Date(), users: new Map(), chatHistory: []
    };
    room.users.set(socket.id, { username, peerId, joinedAt: new Date(), isMuted: false, color });
    rooms.set(roomId, room);
    socket.join(roomId);
    currentRoom = roomId;
    callback({ success: true, room: getRoomInfo(room), color });
  });

  socket.on('room:join', ({ roomId, username, peerId, password }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'Oda bulunamadı!' });
    if (room.password && room.password !== password) return callback({ error: 'Şifre yanlış!' });
    if (room.users.size >= MAX_ROOM_SIZE) return callback({ error: 'Oda dolu! Max 5 kişi.' });
    const color = USER_COLORS[room.users.size % USER_COLORS.length];
    const existingPeers = [];
    room.users.forEach((u) => existingPeers.push({ peerId: u.peerId, username: u.username, color: u.color }));
    room.users.set(socket.id, { username, peerId, joinedAt: new Date(), isMuted: false, color });
    socket.join(roomId);
    currentRoom = roomId;
    const sysMsg = { type: 'system', text: `${username} katıldı`, time: Date.now() };
    room.chatHistory.push(sysMsg);
    io.to(roomId).emit('chat:message', sysMsg);
    socket.to(roomId).emit('user:joined', { socketId: socket.id, username, peerId, color });
    callback({ success: true, room: getRoomInfo(room), existingPeers, color, chatHistory: room.chatHistory.slice(-50) });
    broadcastRoomUpdate(roomId);
  });

  socket.on('chat:send', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    const msg = { type: 'user', username: user.username, color: user.color, text: text.trim().substring(0, 500), time: Date.now() };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > MAX_CHAT_HISTORY) room.chatHistory.shift();
    io.to(currentRoom).emit('chat:message', msg);
  });

  socket.on('sound:play', ({ soundId }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(currentRoom).emit('sound:play', { soundId, username: user.username });
  });

  socket.on('user:mute', ({ isMuted }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) {
      user.isMuted = isMuted;
      socket.to(currentRoom).emit('user:mute-changed', { socketId: socket.id, peerId: user.peerId, isMuted });
    }
  });

  socket.on('screen:start', ({ peerId }) => { if (currentRoom) socket.to(currentRoom).emit('screen:started', { socketId: socket.id, peerId }); });
  socket.on('screen:stop', () => { if (currentRoom) socket.to(currentRoom).emit('screen:stopped', { socketId: socket.id }); });
  socket.on('ping:check', (_, cb) => { if (cb) cb(Date.now()); });

  socket.on('room:leave', () => { handleLeave(socket, currentRoom); currentRoom = null; });
  socket.on('disconnect', () => { handleLeave(socket, currentRoom); });

  function handleLeave(sock, roomId) {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(sock.id);
    const username = user ? user.username : 'Birisi';
    room.users.delete(sock.id);
    sock.leave(roomId);
    const sysMsg = { type: 'system', text: `${username} ayrıldı`, time: Date.now() };
    room.chatHistory.push(sysMsg);
    io.to(roomId).emit('chat:message', sysMsg);
    sock.to(roomId).emit('user:left', { socketId: sock.id, username });
    if (room.users.size === 0) { rooms.delete(roomId); }
    else {
      if (room.host === sock.id) {
        const nh = room.users.keys().next().value;
        room.host = nh;
        io.to(roomId).emit('room:new-host', { socketId: nh });
      }
      broadcastRoomUpdate(roomId);
    }
  }

  socket.on('signal:offer', ({ to, offer }) => io.to(to).emit('signal:offer', { from: socket.id, offer }));
  socket.on('signal:answer', ({ to, answer }) => io.to(to).emit('signal:answer', { from: socket.id, answer }));
  socket.on('signal:ice', ({ to, candidate }) => io.to(to).emit('signal:ice', { from: socket.id, candidate }));
});

app.get('/api/rooms', (req, res) => {
  const list = [];
  rooms.forEach((r) => list.push({ id: r.id, name: r.name, hasPassword: !!r.password, userCount: r.users.size, maxUsers: MAX_ROOM_SIZE }));
  res.json({ rooms: list });
});
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Bulunamadı' });
  res.json(getRoomInfo(room));
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), rooms: rooms.size, connections: io.engine.clientsCount }));

peerServer.on('connection', (c) => console.log(`🔗 ${c.getId()}`));
peerServer.on('disconnect', (c) => console.log(`🔌 ${c.getId()}`));

server.listen(PORT, '0.0.0.0', () => console.log(`\n🎙️  VoiceHub v2.0 | Port ${PORT} | Max ${MAX_ROOM_SIZE}\n`));
