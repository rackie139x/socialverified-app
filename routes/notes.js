const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Active notes from everyone (frontend shows yours first, others after)
router.get('/', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT n.id, n.text, n.created_at, n.expires_at,
                   u.id AS author_id, u.name AS author_name
            FROM notes n JOIN users u ON u.id = n.user_id
            WHERE n.expires_at > NOW()
            ORDER BY n.created_at DESC
        `);
        res.json({ notes: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load notes' });
    }
});

// Post a note - only one active note per person, so posting a new one replaces the old
router.post('/', requireAuth, async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Note text is required' });
    if (text.length > 60) return res.status(400).json({ error: 'Notes are limited to 60 characters' });
    try {
        await pool.query('DELETE FROM notes WHERE user_id = $1', [req.userId]);
        const result = await pool.query(
            'INSERT INTO notes (user_id, text) VALUES ($1, $2) RETURNING id, text, created_at, expires_at',
            [req.userId, text.trim()]
        );
        res.json({ note: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not post note' });
    }
});

module.exports = router;
