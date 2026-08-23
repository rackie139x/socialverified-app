const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const token = header.split(' ')[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = payload.userId;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Sets req.userId if a valid token is present, but never blocks the request
// if it's missing or invalid - used for routes that adjust their response
// based on who's asking (e.g. birthday privacy) without requiring login.
function optionalAuth(req, res, next) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
        try {
            const payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
            req.userId = payload.userId;
        } catch { /* ignore invalid token, just proceed unauthenticated */ }
    }
    next();
}

module.exports = requireAuth;
module.exports.optionalAuth = optionalAuth;
