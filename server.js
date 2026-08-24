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
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const searchRoutes = require('./routes/search');
const messageRoutes = require('./routes/messages');
const storyRoutes = require('./routes/stories');
const noteRoutes = require('./routes/notes');
const reportRoutes = require('./routes/reports');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/stories', storyRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/reports', reportRoutes);

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
const invisibleUsers = new Set(); // userIds who've turned off "active status"

function broadcastPresence(){
    const visibleOnline = [...onlineUsers.keys()].filter(id => !invisibleUsers.has(id));
    io.emit('presence_update', { online: visibleOnline });
}

io.on('connection', (socket) => {
    onlineUsers.set(socket.userId, socket.id);
    broadcastPresence();
    socket.emit('presence_update', { online: [...onlineUsers.keys()].filter(id => !invisibleUsers.has(id)) });

    // Turning off "active status" hides you from everyone else's online indicators.
    // As a fair trade-off (same as WhatsApp/Instagram), you also stop seeing
    // other people's online status while this is off - enforced client-side
    // by simply not rendering presence dots when the toggle is off.
    socket.on('set_active_status', ({ visible }) => {
        if (visible) invisibleUsers.delete(socket.userId);
        else invisibleUsers.add(socket.userId);
        broadcastPresence();
    });

    socket.on('direct_message', async ({ recipientId, ciphertext, iv }) => {
        if (!ciphertext || !iv) return;
        try {
            const result = await pool.query(
                'INSERT INTO messages (sender_id, recipient_id, text, iv) VALUES ($1, $2, $3, $4) RETURNING id, text AS ciphertext, iv, created_at',
                [socket.userId, recipientId, ciphertext, iv]
            );
            const message = { ...result.rows[0], sender_id: socket.userId, recipient_id: Number(recipientId) };
            const recipientSocket = onlineUsers.get(Number(recipientId));
            if (recipientSocket) io.to(recipientSocket).emit('direct_message', message);
            socket.emit('direct_message', message); // echo back to sender
        } catch (err) {
            console.error(err);
        }
    });

    // Called when someone opens a conversation - marks the other person's
    // messages to them as read, and tells that person live (if online) so
    // their sent-message checkmarks can update from single to double tick.
    socket.on('mark_read', async ({ contactId }) => {
        try {
            await pool.query(
                'UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND recipient_id = $2 AND is_read = FALSE',
                [contactId, socket.userId]
            );
            const contactSocket = onlineUsers.get(Number(contactId));
            if (contactSocket) io.to(contactSocket).emit('read_receipt', { byUserId: socket.userId });
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.userId);
        broadcastPresence();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SocialVerified running on port ${PORT}`));
