const express = require('express');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function uploadToCloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: 'socialverified/profiles' }, (err, result) => {
            if (err) return reject(err);
            resolve(result.secure_url);
        });
        stream.end(buffer);
    });
}

// Upload avatar or cover photo. field name 'photo', query ?type=avatar|cover
router.post('/me/photo', requireAuth, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });
    const type = req.query.type === 'cover' ? 'cover' : 'avatar';
    try {
        const url = await uploadToCloudinary(req.file.buffer);
        const column = type === 'cover' ? 'cover_photo_url' : 'avatar_url';
        await pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [url, req.userId]);
        res.json({ url, type });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not upload photo' });
    }
});

// ---- Profile ----
router.get('/:id', async (req, res) => {
    const targetId = req.params.id;
    try {
        const userResult = await pool.query(
            'SELECT id, name, bio, avatar_url, is_verified, is_private, created_at FROM users WHERE id = $1',
            [targetId]
        );
        if (!userResult.rows[0]) return res.status(404).json({ error: 'User not found' });

        const followerCount = await pool.query('SELECT COUNT(*) FROM follows WHERE following_id = $1', [targetId]);
        const followingCount = await pool.query('SELECT COUNT(*) FROM follows WHERE follower_id = $1', [targetId]);

        const postsResult = await pool.query(`
            SELECT p.id, p.text, p.image_url, p.created_at,
                   (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
            FROM posts p WHERE p.user_id = $1
            ORDER BY p.created_at DESC LIMIT 30
        `, [targetId]);

        res.json({
            user: userResult.rows[0],
            follower_count: Number(followerCount.rows[0].count),
            following_count: Number(followingCount.rows[0].count),
            posts: postsResult.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load profile' });
    }
});

router.put('/me', requireAuth, async (req, res) => {
    const { name, bio, avatar_url, cover_photo_url } = req.body;
    try {
        const result = await pool.query(
            'UPDATE users SET name = COALESCE($1, name), bio = COALESCE($2, bio), avatar_url = COALESCE($3, avatar_url), cover_photo_url = COALESCE($4, cover_photo_url) WHERE id = $5 RETURNING id, name, bio, avatar_url, cover_photo_url',
            [name, bio, avatar_url, cover_photo_url, req.userId]
        );
        res.json({ user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update profile' });
    }
});

router.put('/me/privacy', requireAuth, async (req, res) => {
    const { is_private } = req.body;
    await pool.query('UPDATE users SET is_private = $1 WHERE id = $2', [!!is_private, req.userId]);
    res.json({ is_private: !!is_private });
});

// ---- End-to-end encryption key exchange ----
// The server stores each user's PUBLIC key only. Private keys never leave
// the browser they were generated on, so the server can relay messages
// without ever being able to read them.
router.put('/me/public-key', requireAuth, async (req, res) => {
    const { public_key } = req.body;
    if (!public_key) return res.status(400).json({ error: 'public_key is required' });
    await pool.query('UPDATE users SET public_key = $1 WHERE id = $2', [public_key, req.userId]);
    res.json({ ok: true });
});

router.get('/:id/public-key', async (req, res) => {
    const result = await pool.query('SELECT public_key FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ public_key: result.rows[0].public_key });
});

// ---- Follow / Follow requests ----
router.post('/:id/follow', requireAuth, async (req, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself" });

    try {
        const blocked = await pool.query(
            'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
            [req.userId, targetId]
        );
        if (blocked.rows.length > 0) return res.status(403).json({ error: 'Cannot follow this user' });

        const alreadyFollowing = await pool.query(
            'SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2',
            [req.userId, targetId]
        );
        if (alreadyFollowing.rows.length > 0) {
            await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.userId, targetId]);
            return res.json({ status: 'unfollowed' });
        }

        const pendingRequest = await pool.query(
            'SELECT 1 FROM follow_requests WHERE requester_id = $1 AND target_id = $2',
            [req.userId, targetId]
        );
        if (pendingRequest.rows.length > 0) {
            await pool.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [req.userId, targetId]);
            return res.json({ status: 'request_cancelled' });
        }

        const targetUser = await pool.query('SELECT is_private FROM users WHERE id = $1', [targetId]);
        if (!targetUser.rows[0]) return res.status(404).json({ error: 'User not found' });

        if (targetUser.rows[0].is_private) {
            await pool.query('INSERT INTO follow_requests (requester_id, target_id) VALUES ($1, $2)', [req.userId, targetId]);
            await pool.query(
                'INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, $3)',
                [targetId, req.userId, 'follow_request']
            );
            return res.json({ status: 'requested' });
        }

        await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)', [req.userId, targetId]);
        await pool.query(
            'INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, $3)',
            [targetId, req.userId, 'follow']
        );
        res.json({ status: 'followed' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update follow status' });
    }
});

router.get('/:id/follow-status', requireAuth, async (req, res) => {
    const targetId = req.params.id;
    const following = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [req.userId, targetId]);
    if (following.rows.length > 0) return res.json({ status: 'following' });
    const requested = await pool.query('SELECT 1 FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [req.userId, targetId]);
    if (requested.rows.length > 0) return res.json({ status: 'requested' });
    res.json({ status: 'none' });
});

router.get('/me/follow-requests', requireAuth, async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url FROM follow_requests fr
        JOIN users u ON u.id = fr.requester_id
        WHERE fr.target_id = $1 ORDER BY fr.created_at DESC
    `, [req.userId]);
    res.json({ requests: result.rows });
});

router.post('/follow-requests/:requesterId/accept', requireAuth, async (req, res) => {
    const requesterId = req.params.requesterId;
    await pool.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [requesterId, req.userId]);
    await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [requesterId, req.userId]);
    res.json({ ok: true });
});

router.post('/follow-requests/:requesterId/reject', requireAuth, async (req, res) => {
    await pool.query('DELETE FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [req.params.requesterId, req.userId]);
    res.json({ ok: true });
});

// ---- Followers / Following lists ----
router.get('/:id/followers', async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url, u.is_verified FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.following_id = $1 ORDER BY f.created_at DESC
    `, [req.params.id]);
    res.json({ followers: result.rows });
});

router.get('/:id/following', async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url, u.is_verified FROM follows f
        JOIN users u ON u.id = f.following_id
        WHERE f.follower_id = $1 ORDER BY f.created_at DESC
    `, [req.params.id]);
    res.json({ following: result.rows });
});

// ---- Block / Mute ----
router.post('/:id/block', requireAuth, async (req, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) return res.status(400).json({ error: "You can't block yourself" });
    const existing = await pool.query('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, targetId]);
    if (existing.rows.length > 0) {
        await pool.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, targetId]);
        return res.json({ blocked: false });
    }
    await pool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [req.userId, targetId]);
    await pool.query('DELETE FROM follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)', [req.userId, targetId]);
    res.json({ blocked: true });
});

router.post('/:id/mute', requireAuth, async (req, res) => {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) return res.status(400).json({ error: "You can't mute yourself" });
    const existing = await pool.query('SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2', [req.userId, targetId]);
    if (existing.rows.length > 0) {
        await pool.query('DELETE FROM mutes WHERE muter_id = $1 AND muted_id = $2', [req.userId, targetId]);
        return res.json({ muted: false });
    }
    await pool.query('INSERT INTO mutes (muter_id, muted_id) VALUES ($1, $2)', [req.userId, targetId]);
    res.json({ muted: true });
});

router.get('/me/blocked', requireAuth, async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url FROM blocks b
        JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1
    `, [req.userId]);
    res.json({ blocked: result.rows });
});

// ---- Suggested users ----
router.get('/suggestions/for-me', requireAuth, async (req, res) => {
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url, u.is_verified
        FROM users u
        WHERE u.id != $1
          AND u.id NOT IN (SELECT following_id FROM follows WHERE follower_id = $1)
          AND u.id NOT IN (SELECT target_id FROM follow_requests WHERE requester_id = $1)
          AND u.id NOT IN (
              SELECT blocked_id FROM blocks WHERE blocker_id = $1
              UNION
              SELECT blocker_id FROM blocks WHERE blocked_id = $1
          )
        ORDER BY RANDOM()
        LIMIT 10
    `, [req.userId]);
    res.json({ suggestions: result.rows });
});

module.exports = router;
