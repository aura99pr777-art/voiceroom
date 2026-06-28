const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store: { roomId: { socketId: { name, socketId } } }
const rooms = {};

io.on('connection', (socket) => {

  // ── Join a room ──────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, name }) => {
    // Sanitise inputs
    roomId = String(roomId).slice(0, 40).replace(/[^a-zA-Z0-9_-]/g, '');
    name   = String(name).slice(0, 30).replace(/[<>]/g, '');
    if (!roomId || !name) return;

    socket.join(roomId);
    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { name, socketId: socket.id };
    socket.roomId   = roomId;
    socket.userName = name;

    // Send existing users to the newcomer
    const others = Object.values(rooms[roomId]).filter(u => u.socketId !== socket.id);
    socket.emit('existing-users', others);

    // Tell everyone else a new user joined
    socket.to(roomId).emit('user-joined', { socketId: socket.id, name });
  });

  // ── WebRTC signalling ─────────────────────────────────────────────────────
  socket.on('offer', ({ to, offer, name }) => {
    io.to(to).emit('offer', { from: socket.id, offer, name: socket.userName || name });
  });

  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // ── State broadcast (mute / camera / screen-share) ────────────────────────
  socket.on('user-state', (state) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('user-state', { socketId: socket.id, ...state });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (socket.roomId && rooms[socket.roomId]) {
      delete rooms[socket.roomId][socket.id];
      socket.to(socket.roomId).emit('user-left', socket.id);
      if (Object.keys(rooms[socket.roomId]).length === 0) {
        delete rooms[socket.roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`VoiceRoom running → http://localhost:${PORT}`);
});
