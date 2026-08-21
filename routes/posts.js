const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: 'socialverified' }, (err, result) => {
            if (err) return reject(err);
            resolve(result.secure_url);
        });
        stream.end(buffer);
    });
}

// Get feed (most recent first) with author info, like count, and comments
router.get('/', async (req, res) => {
    try {
        const postsResult = await pool.query(`
            SELECT p.id, p.text, p.image_url, p.created_at,
                   u.id AS author_id, u.name AS author_name, u.is_verified,
                   (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
            FROM posts p
            JOIN users u ON u.id = p.user_id
            ORDER BY p.created_at DESC
            LIMIT 50
        `);
        const posts = postsResult.rows;
        for (const post of posts) {
            const comments = await pool.query(`
                SELECT c.id, c.text, u.name AS author_name
                FROM comments c JOIN users u ON u.id = c.user_id
                WHERE c.post_id = $1 ORDER BY c.created_at ASC
            `, [post.id]);
            post.comments = comments.rows;
        }
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load feed' });
    }
});

// Create post (text and/or image)
router.post('/', requireAuth, upload.single('image'), async (req, res) => {
    try {
        const { text } = req.body;
        if (!text && !req.file) {
            return res.status(400).json({ error: 'Post needs text or an image' });
        }
        let imageUrl = null;
        if (req.file) imageUrl = await uploadToCloudinary(req.file.buffer);
        const result = await pool.query(
            'INSERT INTO posts (user_id, text, image_url) VALUES ($1, $2, $3) RETURNING id, text, image_url, created_at',
            [req.userId, text || null, imageUrl]
        );
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create post' });
    }
});

// Toggle like
router.post('/:id/like', requireAuth, async (req, res) => {
    const postId = req.params.id;
    try {
        const existing = await pool.query('SELECT 1 FROM likes WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM likes WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
            res.json({ liked: false });
        } else {
            await pool.query('INSERT INTO likes (post_id, user_id) VALUES ($1, $2)', [postId, req.userId]);
            res.json({ liked: true });
        }
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
        res.json({ comment: { ...result.rows[0], author_name: user.rows[0].name } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not add comment' });
    }
});

module.exports = router;
