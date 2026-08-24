const jwt = require('jsonwebtoken');

// Like requireAuth, but doesn't reject the request if there's no token or it's
// invalid - just leaves req.userId unset. Used on public endpoints (like the
// feed) that still want to personalize the response (e.g. "did I react to this?")
// for whoever happens to be logged in, without requiring login to view at all.
function optionalAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return next();
    const token = header.split(' ')[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = payload.userId;
    } catch (err) {
        // invalid/expired token on a public route - just proceed as anonymous
    }
    next();
}

module.exports = optionalAuth;
