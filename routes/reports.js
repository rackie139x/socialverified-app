const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

// Report a post or user. Stored for moderation review - there's no admin
// dashboard yet to act on these, but nothing is lost; they're saved and
// ready for whenever moderation tooling gets built.
router.post('/', requireAuth, async (req, res) => {
    const { target_type, target_id, reason } = req.body;
    if (!['post', 'user'].includes(target_type)) return res.status(400).json({ error: 'target_type must be post or user' });
    if (!target_id || !reason || !reason.trim()) return res.status(400).json({ error: 'target_id and reason are required' });
    try {
        await pool.query(
            'INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1, $2, $3, $4)',
            [req.userId, target_type, target_id, reason.trim()]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not submit report' });
    }
});

module.exports = router;
