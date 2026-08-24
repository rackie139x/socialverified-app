const express = require('express');
const jwt = require('jsonwebtoken');
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

// Reads a JWT if present but never rejects the request if it's missing/invalid -
// used on public profile routes that still need to know who's asking, so
// privacy settings (followers-only, only-me) can be applied correctly.
function optionalAuth(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    try {
        const payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
        return payload.userId;
    } catch {
        return null;
    }
}

// Upload avatar or cover photo. field name 'photo', query ?type=avatar|cover
// Also posts an automatic "updated their profile/cover photo" entry to the
// timeline, the same way Facebook does.
router.post('/me/photo', requireAuth, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No photo provided' });
    const type = req.query.type === 'cover' ? 'cover' : 'avatar';
    try {
        const url = await uploadToCloudinary(req.file.buffer);
        const column = type === 'cover' ? 'cover_photo_url' : 'avatar_url';
        await pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [url, req.userId]);
        await pool.query(
            'INSERT INTO posts (user_id, image_url, is_profile_update, profile_update_type) VALUES ($1, $2, TRUE, $3)',
            [req.userId, url, type]
        );
        res.json({ url, type });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not upload photo' });
    }
});

function checkFieldVisibility(privacy, viewerId, ownerId, isFollowing) {
    if (viewerId === ownerId) return true;
    if (privacy === 'public') return true;
    if (privacy === 'followers') return isFollowing;
    return false; // 'private'
}

// ---- Profile ----
router.get('/:id', async (req, res) => {
    const targetId = req.params.id;
    const viewerId = optionalAuth(req);
    try {
        const userResult = await pool.query(
            `SELECT id, name, username, bio, avatar_url, cover_photo_url, is_verified, is_private, location, website,
                    gender, gender_privacy, birthday, birthday_privacy, created_at
             FROM users WHERE id = $1`,
            [targetId]
        );
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });

        let isFollowing = false;
        if (viewerId) {
            const f = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [viewerId, targetId]);
            isFollowing = f.rows.length > 0;
        }

        if (!checkFieldVisibility(user.gender_privacy, viewerId, Number(targetId), isFollowing)) {
            user.gender = null;
        }
        if (!checkFieldVisibility(user.birthday_privacy, viewerId, Number(targetId), isFollowing)) {
            user.birthday = null;
        }

        const followerCount = await pool.query('SELECT COUNT(*) FROM follows WHERE following_id = $1', [targetId]);
        const followingCount = await pool.query('SELECT COUNT(*) FROM follows WHERE follower_id = $1', [targetId]);

        const postsResult = await pool.query(`
            SELECT p.id, p.text, p.image_url, p.video_url, p.is_profile_update, p.profile_update_type, p.created_at,
                   (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
            FROM posts p WHERE p.user_id = $1
            ORDER BY p.created_at DESC LIMIT 30
        `, [targetId]);
        for (const post of postsResult.rows) {
            const media = await pool.query('SELECT media_url FROM post_media WHERE post_id = $1 ORDER BY position ASC', [post.id]);
            post.media = media.rows.map(r => r.media_url);
        }

        res.json({
            user,
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
    const { name, username, bio, avatar_url, cover_photo_url, location, website, gender, gender_privacy, birthday, birthday_privacy } = req.body;
    const validPrivacy = v => ['public', 'followers', 'private'].includes(v);
    try {
        let cleanUsername = null;
        if (username) {
            cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
            if (cleanUsername.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
            const taken = await pool.query('SELECT 1 FROM users WHERE username = $1 AND id != $2', [cleanUsername, req.userId]);
            if (taken.rows.length > 0) return res.status(409).json({ error: 'That username is already taken' });
        }
        const result = await pool.query(
            `UPDATE users SET
                name = COALESCE($1, name),
                username = COALESCE($2, username),
                bio = COALESCE($3, bio),
                avatar_url = COALESCE($4, avatar_url),
                cover_photo_url = COALESCE($5, cover_photo_url),
                location = COALESCE($6, location),
                website = COALESCE($7, website),
                gender = COALESCE($8, gender),
                gender_privacy = COALESCE($9, gender_privacy),
                birthday = COALESCE($10, birthday),
                birthday_privacy = COALESCE($11, birthday_privacy)
             WHERE id = $12
             RETURNING id, name, username, bio, avatar_url, cover_photo_url, location, website, gender, gender_privacy, birthday, birthday_privacy`,
            [
                name, cleanUsername, bio, avatar_url, cover_photo_url, location, website,
                gender, validPrivacy(gender_privacy) ? gender_privacy : null,
                birthday, validPrivacy(birthday_privacy) ? birthday_privacy : null,
                req.userId
            ]
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
    const blocked = await pool.query('SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, targetId]);
    const muted = await pool.query('SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2', [req.userId, targetId]);
    const extra = { is_blocked: blocked.rows.length > 0, is_muted: muted.rows.length > 0 };
    const following = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [req.userId, targetId]);
    if (following.rows.length > 0) return res.json({ status: 'following', ...extra });
    const requested = await pool.query('SELECT 1 FROM follow_requests WHERE requester_id = $1 AND target_id = $2', [req.userId, targetId]);
    if (requested.rows.length > 0) return res.json({ status: 'requested', ...extra });
    res.json({ status: 'none', ...extra });
});

// Look up a user by their unique @username (used to resolve @mentions to a profile)
router.get('/by-username/:username', async (req, res) => {
    const result = await pool.query('SELECT id, name, avatar_url FROM users WHERE username = $1', [req.params.username.toLowerCase()]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
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

// ---- Profile tabs: Reels / Reposts / Mentions ----
router.get('/:id/reels', async (req, res) => {
    const result = await pool.query(`
        SELECT p.id, p.text, p.video_url, p.created_at,
               (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
        FROM posts p WHERE p.user_id = $1 AND p.is_reel = TRUE
        ORDER BY p.created_at DESC LIMIT 30
    `, [req.params.id]);
    res.json({ reels: result.rows });
});

router.get('/:id/reposts', async (req, res) => {
    const result = await pool.query(`
        SELECT p.id, p.quote_text, p.repost_of, p.created_at
        FROM posts p WHERE p.user_id = $1 AND p.repost_of IS NOT NULL
        ORDER BY p.created_at DESC LIMIT 30
    `, [req.params.id]);
    res.json({ reposts: result.rows });
});

// Posts anywhere on the platform that @mention this user's username
router.get('/:id/mentions', async (req, res) => {
    try {
        const userResult = await pool.query('SELECT username FROM users WHERE id = $1', [req.params.id]);
        if (!userResult.rows[0] || !userResult.rows[0].username) return res.json({ mentions: [] });
        const username = userResult.rows[0].username;
        const result = await pool.query(`
            SELECT p.id, p.text, p.created_at, u.id AS author_id, u.name AS author_name
            FROM posts p JOIN users u ON u.id = p.user_id
            WHERE p.text ILIKE $1
            ORDER BY p.created_at DESC LIMIT 30
        `, [`%@${username}%`]);
        res.json({ mentions: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load mentions' });
    }
});

module.exports = router;
