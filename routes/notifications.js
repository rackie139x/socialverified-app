const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Get my notifications (most recent first)
router.get('/', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT n.id, n.type, n.post_id, n.is_read, n.created_at,
                   u.id AS actor_id, u.name AS actor_name
            FROM notifications n
            JOIN users u ON u.id = n.actor_id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC
            LIMIT 50
        `, [req.userId]);
        res.json({ notifications: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load notifications' });
    }
});

// Unread count (for a badge indicator)
router.get('/unread-count', requireAuth, async (req, res) => {
    const result = await pool.query(
        'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE',
        [req.userId]
    );
    res.json({ count: Number(result.rows[0].count) });
});

// Mark all as read
router.post('/mark-read', requireAuth, async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
});

module.exports = router;
