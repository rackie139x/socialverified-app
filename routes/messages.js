const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// List everyone you've exchanged messages with, most recent first.
// This is separate from the follow system - you can message anyone,
// not just people you follow - so this reflects actual conversation history.
router.get('/conversations', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT DISTINCT ON (other_user_id) other_user_id, u.name, u.avatar_url, u.is_verified,
                   m.created_at AS last_message_at, m.sender_id AS last_sender_id,
                   m.ciphertext AS last_ciphertext, m.iv AS last_iv, m.is_read AS last_is_read
            FROM (
                SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS other_user_id,
                       sender_id, text AS ciphertext, iv, is_read, created_at
                FROM messages WHERE sender_id = $1 OR recipient_id = $1
            ) m
            JOIN users u ON u.id = m.other_user_id
            ORDER BY other_user_id, m.created_at DESC
        `, [req.userId]);
        result.rows.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
        res.json({ conversations: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load conversations' });
    }
});

// Get message history with a specific contact. Returns ciphertext + iv only -
// the server has no way to read the actual content, decryption happens
// entirely in the browser using each user's private key.
router.get('/with/:contactId', requireAuth, async (req, res) => {
    const contactId = req.params.contactId;
    try {
        const result = await pool.query(`
            SELECT id, sender_id, recipient_id, text AS ciphertext, iv, created_at
            FROM messages
            WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
            ORDER BY created_at ASC
            LIMIT 200
        `, [req.userId, contactId]);
        res.json({ messages: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load messages' });
    }
});

module.exports = router;
