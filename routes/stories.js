const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

function uploadToCloudinary(buffer, resourceType) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: 'socialverified/stories', resource_type: resourceType },
            (err, result) => err ? reject(err) : resolve(result.secure_url)
        );
        stream.end(buffer);
    });
}

// Get all active (not yet expired) stories, grouped by author on the frontend
router.get('/', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.media_url, s.media_type, s.caption, s.text_content, s.background_color,
                   s.shared_from_user_id, sfu.name AS shared_from_name,
                   s.created_at, s.expires_at,
                   u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar,
                   (SELECT emoji FROM story_reactions WHERE story_id = s.id AND user_id = $1) AS my_reaction,
                   (SELECT COUNT(*) FROM story_reactions WHERE story_id = s.id) AS reaction_count
            FROM stories s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN users sfu ON sfu.id = s.shared_from_user_id
            WHERE s.expires_at > NOW()
            ORDER BY s.created_at ASC
        `, [req.userId]);
        res.json({ stories: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load stories' });
    }
});

// React to a story with an emoji (like/laugh/love/sad/wow etc). One reaction per person - posting again replaces it.
router.post('/:id/react', requireAuth, async (req, res) => {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji is required' });
    try {
        await pool.query(
            `INSERT INTO story_reactions (story_id, user_id, emoji) VALUES ($1, $2, $3)
             ON CONFLICT (story_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = NOW()`,
            [req.params.id, req.userId, emoji]
        );
        const storyOwner = await pool.query('SELECT user_id FROM stories WHERE id = $1', [req.params.id]);
        if (storyOwner.rows[0] && storyOwner.rows[0].user_id !== req.userId) {
            await pool.query(
                'INSERT INTO notifications (user_id, actor_id, type) VALUES ($1, $2, $3)',
                [storyOwner.rows[0].user_id, req.userId, 'story_reaction']
            );
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not react to story' });
    }
});

// Reshare someone's story to your own story - copies the media/caption, resets the 24h timer
router.post('/:id/reshare', requireAuth, async (req, res) => {
    try {
        const original = await pool.query('SELECT * FROM stories WHERE id = $1', [req.params.id]);
        if (!original.rows[0]) return res.status(404).json({ error: 'Story not found' });
        const s = original.rows[0];
        const result = await pool.query(
            `INSERT INTO stories (user_id, media_url, media_type, caption, text_content, background_color, shared_from_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at, expires_at`,
            [req.userId, s.media_url, s.media_type, s.caption, s.text_content, s.background_color, s.user_id]
        );
        res.json({ story: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not reshare story' });
    }
});

// Post a new story. Either:
//  - a photo/video file (field 'media'), optionally with a 'caption', or
//  - a text-only story: 'text_content' + optional 'background_color', no file
// Auto-expires after 24 hours either way.
router.post('/', requireAuth, upload.single('media'), async (req, res) => {
    const { caption, text_content, background_color } = req.body;
    try {
        if (req.file) {
            const isVideo = req.file.mimetype.startsWith('video/');
            const url = await uploadToCloudinary(req.file.buffer, isVideo ? 'video' : 'image');
            const result = await pool.query(
                'INSERT INTO stories (user_id, media_url, media_type, caption) VALUES ($1, $2, $3, $4) RETURNING id, media_url, media_type, caption, created_at, expires_at',
                [req.userId, url, isVideo ? 'video' : 'image', caption || null]
            );
            return res.json({ story: result.rows[0] });
        }
        if (text_content && text_content.trim()) {
            const result = await pool.query(
                'INSERT INTO stories (user_id, media_type, text_content, background_color) VALUES ($1, $2, $3, $4) RETURNING id, media_type, text_content, background_color, created_at, expires_at',
                [req.userId, 'text', text_content.trim().slice(0, 200), background_color || '#4F46E5']
            );
            return res.json({ story: result.rows[0] });
        }
        return res.status(400).json({ error: 'A photo, video, or text is required for a story' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not post story' });
    }
});

module.exports = router;
