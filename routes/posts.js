const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
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

// Notify anyone @mentioned in a post's text, and let the frontend linkify them.
// Looks up by the unique username, not the display name (which can repeat).
async function processMentions(postId, text, authorId) {
    if (!text) return;
    const matches = text.match(/@(\w+)/g);
    if (!matches) return;
    const usernames = [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
    for (const username of usernames) {
        const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (user.rows[0] && user.rows[0].id !== authorId) {
            await pool.query(
                'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, $3, $4)',
                [user.rows[0].id, authorId, 'mention', postId]
            );
        }
    }
}

const POST_SELECT = `
    SELECT p.id, p.text, p.image_url, p.video_url, p.quote_text, p.repost_of, p.is_reel,
           p.is_profile_update, p.profile_update_type, p.created_at,
           u.id AS author_id, u.name AS author_name, u.avatar_url AS author_avatar, u.is_verified,
           (SELECT COUNT(*) FROM post_reactions r WHERE r.post_id = p.id) AS like_count,
           (SELECT COUNT(*) FROM posts r2 WHERE r2.repost_of = p.id) AS share_count,
           (SELECT COUNT(*) FROM post_views v WHERE v.post_id = p.id) AS view_count
    FROM posts p
    JOIN users u ON u.id = p.user_id
`;

async function attachCommentsAndOriginal(posts, viewerId) {
    for (const post of posts) {
        const comments = await pool.query(`
            SELECT c.id, c.text, u.name AS author_name
            FROM comments c JOIN users u ON u.id = c.user_id
            WHERE c.post_id = $1 ORDER BY c.created_at ASC
        `, [post.id]);
        post.comments = comments.rows;

        const media = await pool.query(
            'SELECT media_url FROM post_media WHERE post_id = $1 ORDER BY position ASC',
            [post.id]
        );
        post.media = media.rows.map(r => r.media_url); // carousel images, if any (empty array otherwise)

        if (viewerId) {
            const reaction = await pool.query('SELECT reaction FROM post_reactions WHERE post_id = $1 AND user_id = $2', [post.id, viewerId]);
            post.my_reaction = reaction.rows[0] ? reaction.rows[0].reaction : null;
            const saved = await pool.query('SELECT 1 FROM saved_posts WHERE post_id = $1 AND user_id = $2', [post.id, viewerId]);
            post.is_saved = saved.rows.length > 0;
        } else {
            post.my_reaction = null;
            post.is_saved = false;
        }

        if (post.repost_of) {
            const original = await pool.query(POST_SELECT + ' WHERE p.id = $1', [post.repost_of]);
            post.original_post = original.rows[0] || null;
            if (post.original_post) {
                const originalMedia = await pool.query(
                    'SELECT media_url FROM post_media WHERE post_id = $1 ORDER BY position ASC',
                    [post.original_post.id]
                );
                post.original_post.media = originalMedia.rows.map(r => r.media_url);
            }
        }
    }
}

// Feed - excludes reels, which live in their own feed below.
// optionalAuth means this works for anonymous visitors too - they just won't
// get personalized my_reaction/is_saved fields.
router.get('/', optionalAuth, async (req, res) => {
    try {
        const postsResult = await pool.query(POST_SELECT + ' WHERE p.is_reel = FALSE ORDER BY p.created_at DESC LIMIT 50');
        const posts = postsResult.rows;
        await attachCommentsAndOriginal(posts, req.userId);
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load feed' });
    }
});

// Reels feed - only videos marked as reels, most recent first
router.get('/reels', optionalAuth, async (req, res) => {
    try {
        const postsResult = await pool.query(POST_SELECT + ' WHERE p.is_reel = TRUE ORDER BY p.created_at DESC LIMIT 50');
        const posts = postsResult.rows;
        await attachCommentsAndOriginal(posts, req.userId);
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load reels' });
    }
});

// Posts you've saved/bookmarked, most recently saved first
router.get('/saved', requireAuth, async (req, res) => {
    try {
        const postsResult = await pool.query(
            POST_SELECT + ' JOIN saved_posts sp ON sp.post_id = p.id WHERE sp.user_id = $1 ORDER BY sp.created_at DESC',
            [req.userId]
        );
        const posts = postsResult.rows;
        await attachCommentsAndOriginal(posts, req.userId);
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load saved posts' });
    }
});

// Create post - text, one video, or up to 5 photos (carousel).
// 'media' field accepts multiple files. If any file is a video, only the
// first one is used (videos don't carousel). Multiple images create a
// swipeable carousel via the post_media table.
// Set is_reel=true (form field, string "true") to publish a single video to Reels instead of the main feed.
router.post('/', requireAuth, upload.array('media', 5), async (req, res) => {
    try {
        const { text } = req.body;
        const wantsReel = req.body.is_reel === 'true';
        const files = req.files || [];
        if (!text && files.length === 0) {
            return res.status(400).json({ error: 'Post needs text or media' });
        }
        const videoFile = files.find(f => f.mimetype.startsWith('video/'));
        if (wantsReel && !videoFile) {
            return res.status(400).json({ error: 'Reels require a video file' });
        }

        let imageUrl = null, videoUrl = null, carouselUrls = [];
        if (videoFile) {
            videoUrl = await uploadToCloudinary(videoFile.buffer, 'video');
        } else if (files.length > 0) {
            carouselUrls = await Promise.all(files.map(f => uploadToCloudinary(f.buffer, 'image')));
            imageUrl = carouselUrls[0]; // first image also stored on the post row for backward compatibility
        }

        const result = await pool.query(
            'INSERT INTO posts (user_id, text, image_url, video_url, is_reel) VALUES ($1, $2, $3, $4, $5) RETURNING id, text, image_url, video_url, is_reel, created_at',
            [req.userId, text || null, imageUrl, videoUrl, wantsReel]
        );
        const postId = result.rows[0].id;

        if (carouselUrls.length > 1) {
            await Promise.all(carouselUrls.map((url, i) =>
                pool.query('INSERT INTO post_media (post_id, media_url, media_type, position) VALUES ($1, $2, $3, $4)', [postId, url, 'image', i])
            ));
        }

        await processHashtags(postId, text);
        await processMentions(postId, text, req.userId);
        res.json({ post: { ...result.rows[0], media: carouselUrls } });
    } catch (err) {
        console.error(err);
        // Surface the real error (e.g. Cloudinary auth failure) instead of a generic message,
        // since a vague error makes it impossible to tell what actually went wrong.
        res.status(500).json({ error: err.message || 'Could not create post' });
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
        if (quote_text) {
            await processHashtags(result.rows[0].id, quote_text);
            await processMentions(result.rows[0].id, quote_text, req.userId);
        }
        res.json({ post: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not share post' });
    }
});

// React to a post: like, love, haha, sad, angry, wow. One reaction per person -
// reacting again with the same type removes it, a different type replaces it.
router.post('/:id/react', requireAuth, async (req, res) => {
    const postId = req.params.id;
    const reaction = req.body.reaction || 'like';
    try {
        const existing = await pool.query('SELECT reaction FROM post_reactions WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
        if (existing.rows[0] && existing.rows[0].reaction === reaction) {
            await pool.query('DELETE FROM post_reactions WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
            return res.json({ my_reaction: null });
        }
        await pool.query(
            `INSERT INTO post_reactions (post_id, user_id, reaction) VALUES ($1, $2, $3)
             ON CONFLICT (post_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = NOW()`,
            [postId, req.userId, reaction]
        );
        if (!existing.rows[0]) {
            const postOwner = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
            if (postOwner.rows[0] && postOwner.rows[0].user_id !== req.userId) {
                await pool.query(
                    'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1, $2, $3, $4)',
                    [postOwner.rows[0].user_id, req.userId, 'like', postId]
                );
            }
        }
        res.json({ my_reaction: reaction });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update reaction' });
    }
});

// Save or unsave (bookmark) a post
router.post('/:id/save', requireAuth, async (req, res) => {
    const postId = req.params.id;
    try {
        const existing = await pool.query('SELECT 1 FROM saved_posts WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
        if (existing.rows.length > 0) {
            await pool.query('DELETE FROM saved_posts WHERE post_id = $1 AND user_id = $2', [postId, req.userId]);
            return res.json({ saved: false });
        }
        await pool.query('INSERT INTO saved_posts (user_id, post_id) VALUES ($1, $2)', [req.userId, postId]);
        res.json({ saved: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update saved post' });
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
        await processMentions(req.params.id, text, req.userId);
        res.json({ comment: { ...result.rows[0], author_name: user.rows[0].name } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not add comment' });
    }
});

// Record a view once per user per post (ignored if already viewed)
router.post('/:id/view', requireAuth, async (req, res) => {
    await pool.query(
        'INSERT INTO post_views (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.params.id, req.userId]
    );
    res.json({ ok: true });
});

// Explore feed: recent posts that have media, ordered by popularity, for browsing
router.get('/explore', async (req, res) => {
    try {
        const postsResult = await pool.query(
            POST_SELECT + `
            WHERE p.is_reel = FALSE AND (p.image_url IS NOT NULL OR p.video_url IS NOT NULL)
            ORDER BY like_count DESC, p.created_at DESC
            LIMIT 30
        `);
        const posts = postsResult.rows;
        await attachCommentsAndOriginal(posts);
        res.json({ posts });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load explore feed' });
    }
});

module.exports = router;
