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
router.get('/', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.id, s.media_url, s.media_type, s.created_at, s.expires_at,
                   u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar
            FROM stories s
            JOIN users u ON u.id = s.user_id
            WHERE s.expires_at > NOW()
            ORDER BY s.created_at ASC
        `);
        res.json({ stories: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load stories' });
    }
});

// Post a new story - photo or short video, auto-expires after 24 hours
router.post('/', requireAuth, upload.single('media'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A photo or video is required for a story' });
    try {
        const isVideo = req.file.mimetype.startsWith('video/');
        const url = await uploadToCloudinary(req.file.buffer, isVideo ? 'video' : 'image');
        const result = await pool.query(
            'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1, $2, $3) RETURNING id, media_url, media_type, created_at, expires_at',
            [req.userId, url, isVideo ? 'video' : 'image']
        );
        res.json({ story: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not post story' });
    }
});

module.exports = router;
