const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /api/search?q=term
router.get('/', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ users: [], posts: [], hashtags: [] });

    try {
        const isHashtagSearch = q.startsWith('#');
        const cleanTag = q.replace(/^#/, '').toLowerCase();

        const users = await pool.query(
            `SELECT id, name, avatar_url, is_verified FROM users WHERE name ILIKE $1 LIMIT 15`,
            [`%${q}%`]
        );

        const posts = await pool.query(
            `SELECT p.id, p.text, p.image_url, p.video_url, p.created_at,
                    u.id AS author_id, u.name AS author_name
             FROM posts p JOIN users u ON u.id = p.user_id
             WHERE p.text ILIKE $1
             ORDER BY p.created_at DESC LIMIT 20`,
            [`%${q}%`]
        );

        const hashtags = await pool.query(
            `SELECT h.tag, COUNT(ph.post_id) AS post_count
             FROM hashtags h LEFT JOIN post_hashtags ph ON ph.hashtag_id = h.id
             WHERE h.tag ILIKE $1
             GROUP BY h.tag ORDER BY post_count DESC LIMIT 15`,
            [`%${cleanTag}%`]
        );

        res.json({
            users: users.rows,
            posts: posts.rows,
            hashtags: hashtags.rows,
            searched_hashtag: isHashtagSearch ? cleanTag : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Search failed' });
    }
});

// GET /api/search/hashtag/:tag - all posts under a specific hashtag (for tapping a tag)
router.get('/hashtag/:tag', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.id, p.text, p.image_url, p.video_url, p.created_at,
                   u.id AS author_id, u.name AS author_name, u.is_verified
            FROM posts p
            JOIN users u ON u.id = p.user_id
            JOIN post_hashtags ph ON ph.post_id = p.id
            JOIN hashtags h ON h.id = ph.hashtag_id
            WHERE h.tag = $1
            ORDER BY p.created_at DESC LIMIT 50
        `, [req.params.tag.toLowerCase()]);
        res.json({ posts: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load hashtag' });
    }
});

// GET /api/search/trending - top hashtags overall, for the Explore page default view
router.get('/trending', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT h.tag, COUNT(ph.post_id) AS post_count
            FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id = h.id
            GROUP BY h.tag ORDER BY post_count DESC LIMIT 10
        `);
        res.json({ trending: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load trending topics' });
    }
});

module.exports = router;
