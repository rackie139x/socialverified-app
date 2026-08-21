const pool = require('../db');

// Pull #tags out of text, store any new ones, and link them to a post.
// Safe to call with no hashtags present - it just does nothing.
async function processHashtags(postId, text) {
    if (!text) return;
    const matches = text.match(/#(\w+)/g);
    if (!matches) return;
    const uniqueTags = [...new Set(matches.map(t => t.slice(1).toLowerCase()))];

    for (const tag of uniqueTags) {
        const result = await pool.query(
            'INSERT INTO hashtags (tag) VALUES ($1) ON CONFLICT (tag) DO UPDATE SET tag = EXCLUDED.tag RETURNING id',
            [tag]
        );
        const hashtagId = result.rows[0].id;
        await pool.query(
            'INSERT INTO post_hashtags (post_id, hashtag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [postId, hashtagId]
        );
    }
}

module.exports = { processHashtags };
