const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const { processHashtags } = require('./hashtags');
const { processMentions } = require('./posts'); // eslint-disable-line no-unused-vars -- kept for future mention support in group posts

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: 'socialverified/groups' }, (err, result) => {
            if (err) return reject(err);
            resolve(result.secure_url);
        });
        stream.end(buffer);
    });
}

// List/search groups. If logged in, includes whether you're a member.
router.get('/', optionalAuth, async (req, res) => {
    const q = (req.query.q || '').trim();
    try {
        const result = await pool.query(`
            SELECT g.id, g.name, g.description, g.cover_image_url, g.is_private, g.created_at,
                   u.name AS creator_name,
                   (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
                   ${req.userId ? `, EXISTS(SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = $2) AS is_member
                   , EXISTS(SELECT 1 FROM group_join_requests gr WHERE gr.group_id = g.id AND gr.user_id = $2) AS has_requested` : ''}
            FROM groups g
            JOIN users u ON u.id = g.creator_id
            ${q ? 'WHERE g.name ILIKE $1' : ''}
            ORDER BY member_count DESC, g.created_at DESC
            LIMIT 30
        `, req.userId ? [q ? `%${q}%` : '%%', req.userId] : (q ? [`%${q}%`] : []));
        res.json({ groups: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load groups' });
    }
});

// Groups the current user belongs to
router.get('/mine', requireAuth, async (req, res) => {
    const result = await pool.query(`
        SELECT g.id, g.name, g.description, g.cover_image_url, g.is_private, gm.role
        FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = $1
        ORDER BY gm.joined_at DESC
    `, [req.userId]);
    res.json({ groups: result.rows });
});

// Create a group. Creator is automatically an admin member.
router.post('/', requireAuth, upload.single('cover'), async (req, res) => {
    const { name, description, is_private } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required' });
    try {
        let coverUrl = null;
        if (req.file) coverUrl = await uploadToCloudinary(req.file.buffer);
        const result = await pool.query(
            'INSERT INTO groups (name, description, cover_image_url, creator_id, is_private) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, description, cover_image_url, is_private',
            [name.trim(), description || null, coverUrl, req.userId, is_private === 'true']
        );
        const group = result.rows[0];
        await pool.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [group.id, req.userId, 'admin']);
        res.json({ group });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not create group' });
    }
});

// Group detail: info, membership status, member list, and its posts
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const groupResult = await pool.query(`
            SELECT g.id, g.name, g.description, g.cover_image_url, g.is_private, g.creator_id, g.created_at,
                   u.name AS creator_name
            FROM groups g JOIN users u ON u.id = g.creator_id
            WHERE g.id = $1
        `, [req.params.id]);
        const group = groupResult.rows[0];
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const memberCount = await pool.query('SELECT COUNT(*) FROM group_members WHERE group_id = $1', [req.params.id]);
        group.member_count = Number(memberCount.rows[0].count);

        let myRole = null, hasRequested = false;
        if (req.userId) {
            const membership = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
            myRole = membership.rows[0]?.role || null;
            const reqCheck = await pool.query('SELECT 1 FROM group_join_requests WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
            hasRequested = reqCheck.rows.length > 0;
        }
        group.my_role = myRole;
        group.has_requested = hasRequested;

        // Only members can see posts in a private group; public groups are visible to everyone
        let posts = [];
        if (!group.is_private || myRole) {
            const postsResult = await pool.query(`
                SELECT p.id, p.text, p.image_url, p.video_url, p.created_at,
                       u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar, u.is_verified,
                       (SELECT COUNT(*) FROM post_reactions r WHERE r.post_id = p.id) AS like_count
                FROM posts p JOIN users u ON u.id = p.user_id
                WHERE p.group_id = $1
                ORDER BY p.created_at DESC LIMIT 50
            `, [req.params.id]);
            posts = postsResult.rows;
            for (const post of posts) {
                const comments = await pool.query(`
                    SELECT c.id, c.text, u.name AS author_name FROM comments c
                    JOIN users u ON u.id = c.user_id WHERE c.post_id = $1 ORDER BY c.created_at ASC
                `, [post.id]);
                post.comments = comments.rows;
            }
        }

        res.json({ group, posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load group' });
    }
});

// Join (public groups: instant) or request to join (private groups)
router.post('/:id/join', requireAuth, async (req, res) => {
    try {
        const groupResult = await pool.query('SELECT is_private FROM groups WHERE id = $1', [req.params.id]);
        if (!groupResult.rows[0]) return res.status(404).json({ error: 'Group not found' });

        const existing = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.rows.length > 0) return res.json({ status: 'already_member' });

        if (groupResult.rows[0].is_private) {
            await pool.query('INSERT INTO group_join_requests (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.userId]);
            return res.json({ status: 'requested' });
        }
        await pool.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)', [req.params.id, req.userId, 'member']);
        res.json({ status: 'joined' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not join group' });
    }
});

router.post('/:id/leave', requireAuth, async (req, res) => {
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
});

// ---- Join request management (group admins only) ----
router.get('/:id/requests', requireAuth, async (req, res) => {
    const membership = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (membership.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Only group admins can view join requests' });
    const result = await pool.query(`
        SELECT u.id, u.name, u.avatar_url FROM group_join_requests gr
        JOIN users u ON u.id = gr.user_id WHERE gr.group_id = $1
    `, [req.params.id]);
    res.json({ requests: result.rows });
});

router.post('/:id/requests/:userId/accept', requireAuth, async (req, res) => {
    const membership = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (membership.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Only group admins can accept requests' });
    await pool.query('DELETE FROM group_join_requests WHERE group_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    await pool.query('INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [req.params.id, req.params.userId, 'member']);
    res.json({ ok: true });
});

router.post('/:id/requests/:userId/reject', requireAuth, async (req, res) => {
    const membership = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (membership.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Only group admins can reject requests' });
    await pool.query('DELETE FROM group_join_requests WHERE group_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.json({ ok: true });
});

// Remove a member (admins only, can't remove yourself this way - use leave instead)
router.delete('/:id/members/:userId', requireAuth, async (req, res) => {
    const membership = await pool.query('SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (membership.rows[0]?.role !== 'admin') return res.status(403).json({ error: 'Only group admins can remove members' });
    if (Number(req.params.userId) === req.userId) return res.status(400).json({ error: 'Use leave instead of removing yourself' });
    await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.params.userId]);
    res.json({ ok: true });
});

// Delete a group entirely (creator only)
router.delete('/:id', requireAuth, async (req, res) => {
    const group = await pool.query('SELECT creator_id FROM groups WHERE id = $1', [req.params.id]);
    if (!group.rows[0]) return res.status(404).json({ error: 'Group not found' });
    if (group.rows[0].creator_id !== req.userId) return res.status(403).json({ error: 'Only the creator can delete this group' });
    await pool.query('DELETE FROM groups WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
});

// Create a post inside a group - only members can post
router.post('/:id/posts', requireAuth, upload.single('media'), async (req, res) => {
    const { text } = req.body;
    if (!text && !req.file) return res.status(400).json({ error: 'Post needs text or media' });
    try {
        const membership = await pool.query('SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (membership.rows.length === 0) return res.status(403).json({ error: 'Only group members can post here' });

        let imageUrl = null, videoUrl = null;
        if (req.file) {
            const isVideo = req.file.mimetype.startsWith('video/');
            const url = await uploadToCloudinary(req.file.buffer);
            if (isVideo) videoUrl = url; else imageUrl = url;
        }
        const result = await pool.query(
            'INSERT INTO posts (user_id, text, image_url, video_url, group_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, text, image_url, video_url, created_at',
            [req.userId, text || null, imageUrl, videoUrl, req.params.id]
        );
        await processHashtags(result.rows[0].id, text);
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not post to group' });
    }
});

module.exports = router;
