const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

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
