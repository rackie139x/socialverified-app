const pool = require('../db');

// Must run AFTER requireAuth, since it needs req.userId already set.
// Checks the database each time rather than trusting a JWT claim, so
// revoking admin access takes effect immediately without users needing
// to log out and back in.
async function requireAdmin(req, res, next) {
    try {
        const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.userId]);
        if (!result.rows[0] || !result.rows[0].is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not verify admin access' });
    }
}

module.exports = requireAdmin;
