const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const { processHashtags } = require('./hashtags');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB, video needs more room than images

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer, resourceType = 'image') {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: 'socialverified', resource_type: resourceType },
            (err, result) => {
                if (err) return reject(err);
                resolve(result.secure_url);
            }
        );
        stream.end(buffer);
    });
}

const POST_SELECT = `
    SELECT p.id, p.text, p.image_url, p.video_url, p.quote_text, p.repost_of, p.created_at,
           u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar, u.is_verified,
           (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
           (SELECT COUNT(*) FROM posts r WHERE r.repost_of = p.id) AS share_count
    FROM posts p
    JOIN users u ON u.id = p.user_id
`;

async function attachCommentsAndOriginal(posts) {
    for (const post of posts) {
        const comments = await pool.query(`
            SELECT c.id, c.text, u.name AS author_name
            FROM comments c JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1 ORDER BY c.created_at ASC
        `, [post.id]);
        post.comments = comments.rows;

        if (post.repost_of) {
            const original = await pool.query(POST_SELECT + ' WHERE p.id = $1', [post.repost_of]);
            post.original_post = original.rows[0] || null;
        }
    }
}

// Feed
router.get('/', async (req, res) => {
    try {
        const postsResult = await pool.query(POST_SELECT + ' ORDER BY p.created_at DESC LIMIT 50');
        const posts = postsResult.rows;
        await attachCommentsAndOriginal(posts);
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load feed' });
    }
});

// Create post - text, photo, or video. 'media' field can be either an image or a video file.
router.post('/', requireAuth, upload.single('media'), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text && !req.file) {
            return res.status(400).json({ error: 'Post needs text or media' });
        }
        let imageUrl = null, videoUrl = null;
        if (req.file) {
            const isVideo = req.file.mimetype.startsWith('video/');
            const url = await uploadToCloudinary(req.file.buffer, isVideo ? 'video' : 'image');
            if (isVideo) videoUrl = url; else imageUrl = url;
        }
        const result = await pool.query(
            'INSERT INTO posts (user_id, text, image_url, video_url) VALUES ($1, $2, $3, $4) RETURNING id, text, image_url, video_url, created_at',
            [req.userId, text || null, imageUrl, videoUrl]
        );
        await processHashtags(result.rows[0].id, text);
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create post' });
    }
});

// Repost (plain share) or quote post (share + your own commentary)
router.post('/:id/share', requireAuth, async (req, res) => {
    const originalId = req.params.id;
    const { quote_text } = req.body;
    try {
        const original = await pool.query('SELECT id FROM posts WHERE id = $1', [originalId]);
        if (!original.rows[0]) return res.status(404).json({ error: 'Original post not found' });

        const result = await pool.query(
            'INSERT INTO posts (user_id, repost_of, quote_text) VALUES ($1, $2, $3) RETURNING id, repost_of, quote_text, created_at',
            [req.userId, originalId, quote_text || null]
        );
        if (quote_text) await processHashtags(result.rows[0].id, quote_text);
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not share post' });
    }
});

// Toggle like
router.post('/:id/like', requireAuth, async (req, res) => {
    const postId = req.params.id;
    try {
        const existing = await pool.query('SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
            return res.json({ liked: false });
        }
        await pool.query('INSERT INTO likes (post_id, user_id) VALUES ($1, $2)', [postId, req.userId]);
        const postOwner = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
        if (postOwner.rows[0] && postOwner.rows[0].user_id !== req.userId) {
            await pool.query(
                'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, $3, $4)',
                [postOwner.rows[0].user_id, req.userId, 'like', postId]
            );
        }
        res.json({ liked: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update like' });
    }
});

// Add comment
router.post('/:id/comments', requireAuth, async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required' });
    try {
        const result = await pool.query(
            'INSERT INTO comments (post_id, user_id, text) VALUES ($1, $2, $3) RETURNING id, text',
            [req.params.id, req.userId, text.trim()]
        );
        const user = await pool.query('SELECT name FROM users WHERE id = $1', [req.userId]);
        const postOwner = await pool.query('SELECT user_id FROM posts WHERE id = $1', [req.params.id]);
        if (postOwner.rows[0] && postOwner.rows[0].user_id !== req.userId) {
            await pool.query(
                'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, $3, $4)',
                [postOwner.rows[0].user_id, req.userId, 'comment', req.params.id]
            );
        }
        res.json({ comment: { ...result.rows[0], author_name: user.rows[0].name } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not add comment' });
    }
});

module.exports = router;
