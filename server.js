require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const pool = require('./db');

const authRoutes = require('./routes/auth');
const postRoutes = require('./routes/posts');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Socket.IO real-time chat ----
// Clients connect with their JWT; we verify it before allowing them to send/receive
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('No auth token'));
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = payload.userId;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

const onlineUsers = new Map(); // userId -> socket.id

io.on('connection', (socket) => {
    onlineUsers.set(socket.userId, socket.id);

    socket.on('direct_message', async ({ recipientId, text }) => {
        if (!text || !text.trim()) return;
        try {
            const result = await pool.query(
                'INSERT INTO messages (sender_id, recipient_id, text) VALUES ($1, $2, $3) RETURNING id, text, created_at',
                [socket.userId, recipientId, text.trim()]
            );
            const message = { ...result.rows[0], sender_id: socket.userId, recipient_id: recipientId };
            const recipientSocket = onlineUsers.get(Number(recipientId));
            if (recipientSocket) io.to(recipientSocket).emit('direct_message', message);
            socket.emit('direct_message', message); // echo back to sender
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.userId);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SocialVerified running on port ${PORT}`));
