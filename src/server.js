const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const MAX_ROOM = 5;
const MAX_CHAT = 100;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Favicon fix
app.get('/favicon.ico', (_, res) => res.status(204).end());

const peerServer = ExpressPeerServer(server, {
  debug: true, path: '/', allow_discovery: false, proxied: true,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]}
});
app.use('/peerjs', peerServer);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket'],
  allowEIO3: true, pingTimeout: 60000, pingInterval: 25000, path: '/socket.io/'
});

const rooms = new Map();
const COLORS = ['#7c6cf0','#2dd4a8','#f06060','#f0c040','#60a0f0','#f080c0','#80d060','#c080f0','#f0a040','#40d0d0'];

function mkCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function roomInfo(room) {
  const users = [];
  room.users.forEach((u, sid) => {
    users.push({ socketId: sid, username: u.username, peerId: u.peerId, isMuted: u.isMuted, isHost: sid === room.host, color: u.color });
  });

  // Screen share info
  let screenShare = null;
  if (room.screenSharer) {
    const ss = room.users.get(room.screenSharer);
    if (ss && ss.screenPeerId) {
      screenShare = {
        socketId: room.screenSharer,
        username: ss.username,
        screenPeerId: ss.screenPeerId
      };
    }
  }

  return { id: room.id, name: room.name, host: room.host, hasPassword: !!room.password, userCount: room.users.size, maxUsers: MAX_ROOM, users, screenShare };
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  if (room) io.to(roomId).emit('room:update', roomInfo(room));
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('room:create', ({ username, peerId, roomName, password }, cb) => {
    const roomId = mkCode();
    if (rooms.has(roomId)) return cb({ error: 'Tekrar dene' });
    const color = COLORS[0];
    const room = { id: roomId, name: roomName || `${username}'in Odası`, host: socket.id, password: password || null, createdAt: new Date(), users: new Map(), chatHistory: [], screenSharer: null };
    room.users.set(socket.id, { username, peerId, joinedAt: new Date(), isMuted: false, color, screenPeerId: null });
    rooms.set(roomId, room);
    socket.join(roomId);
    currentRoom = roomId;
    cb({ success: true, room: roomInfo(room), color });
  });

  socket.on('room:join', ({ roomId, username, peerId, password }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'Oda bulunamadı!' });
    if (room.password && room.password !== password) return cb({ error: 'Şifre yanlış!' });
    if (room.users.size >= MAX_ROOM) return cb({ error: 'Oda dolu! Max 5 kişi.' });
    const color = COLORS[room.users.size % COLORS.length];
    const existingPeers = [];
    room.users.forEach(u => existingPeers.push({ peerId: u.peerId, username: u.username, color: u.color }));
    room.users.set(socket.id, { username, peerId, joinedAt: new Date(), isMuted: false, color, screenPeerId: null });
    socket.join(roomId);
    currentRoom = roomId;
    const sysMsg = { type: 'system', text: `${username} katıldı`, time: Date.now() };
    room.chatHistory.push(sysMsg);
    io.to(roomId).emit('chat:message', sysMsg);
    socket.to(roomId).emit('user:joined', { socketId: socket.id, username, peerId, color });

    // Send room info including active screen share
    const info = roomInfo(room);
    cb({ success: true, room: info, existingPeers, color, chatHistory: room.chatHistory.slice(-50) });
    broadcast(roomId);
  });

  socket.on('chat:send', ({ text }) => {
    if (!currentRoom || !text?.trim()) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    const msg = { type: 'user', username: user.username, color: user.color, text: text.trim().substring(0, 500), time: Date.now() };
    room.chatHistory.push(msg);
    if (room.chatHistory.length > MAX_CHAT) room.chatHistory.shift();
    io.to(currentRoom).emit('chat:message', msg);
  });

  socket.on('chat:typing', ({ isTyping }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    socket.to(currentRoom).emit('chat:typing', { username: user.username, isTyping });
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

  // Screen share
  socket.on('screen:start', ({ screenPeerId }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (!user) return;
    user.screenPeerId = screenPeerId;
    room.screenSharer = socket.id;
    // Broadcast to everyone including late joiners
    io.to(currentRoom).emit('screen:started', { socketId: socket.id, username: user.username, screenPeerId });
    broadcast(currentRoom);
  });

  socket.on('screen:stop', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const user = room.users.get(socket.id);
    if (user) user.screenPeerId = null;
    if (room.screenSharer === socket.id) room.screenSharer = null;
    io.to(currentRoom).emit('screen:stopped', { socketId: socket.id });
    broadcast(currentRoom);
  });

  socket.on('ping:check', (_, cb) => { if (cb) cb(Date.now()); });

  socket.on('room:leave', () => { leave(socket, currentRoom); currentRoom = null; });
  socket.on('disconnect', () => { leave(socket, currentRoom); });

  function leave(sock, roomId) {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const user = room.users.get(sock.id);
    const username = user ? user.username : 'Birisi';
    // Clean up screen share
    if (room.screenSharer === sock.id) {
      room.screenSharer = null;
      io.to(roomId).emit('screen:stopped', { socketId: sock.id });
    }
    room.users.delete(sock.id);
    sock.leave(roomId);
    const sysMsg = { type: 'system', text: `${username} ayrıldı`, time: Date.now() };
    room.chatHistory.push(sysMsg);
    io.to(roomId).emit('chat:message', sysMsg);
    sock.to(roomId).emit('user:left', { socketId: sock.id, username });
    if (room.users.size === 0) rooms.delete(roomId);
    else {
      if (room.host === sock.id) {
        const nh = room.users.keys().next().value;
        room.host = nh;
        io.to(roomId).emit('room:new-host', { socketId: nh });
      }
      broadcast(roomId);
    }
  }

  socket.on('signal:offer', ({ to, offer }) => io.to(to).emit('signal:offer', { from: socket.id, offer }));
  socket.on('signal:answer', ({ to, answer }) => io.to(to).emit('signal:answer', { from: socket.id, answer }));
  socket.on('signal:ice', ({ to, candidate }) => io.to(to).emit('signal:ice', { from: socket.id, candidate }));
});

app.get('/api/rooms', (_, res) => {
  const list = [];
  rooms.forEach(r => list.push({ id: r.id, name: r.name, hasPassword: !!r.password, userCount: r.users.size, maxUsers: MAX_ROOM }));
  res.json({ rooms: list });
});
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Bulunamadı' });
  res.json(roomInfo(room));
});
app.get('/api/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime(), rooms: rooms.size, connections: io.engine.clientsCount }));

peerServer.on('connection', c => console.log(`🔗 ${c.getId()}`));
peerServer.on('disconnect', c => console.log(`🔌 ${c.getId()}`));

server.listen(PORT, '0.0.0.0', () => console.log(`\n🎙️  VoiceHub v4 | Port ${PORT} | Max ${MAX_ROOM}\n`));
