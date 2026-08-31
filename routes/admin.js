const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// Every route here requires a logged-in admin account
router.use(requireAuth, requireAdmin);

// ---- Overview stats ----
router.get('/stats', async (req, res) => {
    try {
        const [users, posts, pendingReports, bannedUsers] = await Promise.all([
            pool.query('SELECT COUNT(*) FROM users'),
            pool.query('SELECT COUNT(*) FROM posts'),
            pool.query("SELECT COUNT(*) FROM reports WHERE status = 'pending'"),
            pool.query('SELECT COUNT(*) FROM users WHERE is_banned = TRUE')
        ]);
        res.json({
            total_users: Number(users.rows[0].count),
            total_posts: Number(posts.rows[0].count),
            pending_reports: Number(pendingReports.rows[0].count),
            banned_users: Number(bannedUsers.rows[0].count)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load stats' });
    }
});

// ---- Reports ----
// Returns pending reports with enough context to act on them - who reported,
// why, and what the target post/user actually is.
router.get('/reports', async (req, res) => {
    try {
        const reportsResult = await pool.query(`
            SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at,
                   u.id AS reporter_id, u.name AS reporter_name
            FROM reports r
            JOIN users u ON u.id = r.reporter_id
            WHERE r.status = 'pending'
            ORDER BY r.created_at DESC
        `);
        const reports = reportsResult.rows;

        for (const report of reports) {
            if (report.target_type === 'post') {
                const post = await pool.query(`
                    SELECT p.id, p.text, p.image_url, u.id AS author_id, u.name AS author_name
                    FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1
                `, [report.target_id]);
                report.target = post.rows[0] || null;
            } else {
                const user = await pool.query('SELECT id, name, email, is_banned FROM users WHERE id = $1', [report.target_id]);
                report.target = user.rows[0] || null;
            }
        }
        res.json({ reports });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load reports' });
    }
});

router.post('/reports/:id/resolve', async (req, res) => {
    await pool.query("UPDATE reports SET status = 'resolved' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
});

router.post('/reports/:id/dismiss', async (req, res) => {
    await pool.query("UPDATE reports SET status = 'dismissed' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
});

// Remove a reported post directly from a report (also auto-resolves the report)
router.delete('/posts/:id', async (req, res) => {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    await pool.query("UPDATE reports SET status = 'resolved' WHERE target_type = 'post' AND target_id = $1", [req.params.id]);
    res.json({ ok: true });
});

// ---- User search (to find someone to ban/verify) ----
router.get('/users', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const result = await pool.query(
        `SELECT id, name, username, email, is_admin, is_banned, is_verified FROM users
         WHERE name ILIKE $1 OR username ILIKE $1 OR email ILIKE $1 LIMIT 20`,
        [`%${q}%`]
    );
    res.json({ users: result.rows });
});

// Ban / unban a user. Banned users cannot log in (enforced in routes/auth.js).
router.post('/users/:id/ban', async (req, res) => {
    const result = await pool.query('SELECT is_banned FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const newValue = !result.rows[0].is_banned;
    await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [newValue, req.params.id]);
    res.json({ is_banned: newValue });
});

// Manually grant or revoke the verified badge
router.post('/users/:id/verify', async (req, res) => {
    const result = await pool.query('SELECT is_verified FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    const newValue = !result.rows[0].is_verified;
    await pool.query('UPDATE users SET is_verified = $1 WHERE id = $2', [newValue, req.params.id]);
    res.json({ is_verified: newValue });
});

module.exports = router;
