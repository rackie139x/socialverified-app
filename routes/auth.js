const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const requireAuth = require('../middleware/auth');
const { sendEmail, generateCode } = require('../utils/email');

const router = express.Router();

// Turns a display name into a unique @username by stripping to alphanumerics
// and appending digits if that base is already taken.
async function generateUniqueUsername(name) {
    const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    let candidate = base;
    let attempt = 0;
    while (true) {
        const existing = await pool.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
        if (existing.rows.length === 0) return candidate;
        attempt++;
        candidate = base + Math.floor(Math.random() * 10000);
        if (attempt > 20) candidate = base + Date.now(); // extremely unlikely fallback
    }
}

router.post('/signup', async (req, res) => {
    const { name, username, email, password } = req.body;
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'An account with that email already exists' });
        }

        let finalUsername;
        if (username && username.trim()) {
            const cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
            if (cleanUsername.length < 3) {
                return res.status(400).json({ error: 'Username must be at least 3 characters (letters, numbers, underscores only)' });
            }
            const taken = await pool.query('SELECT 1 FROM users WHERE username = $1', [cleanUsername]);
            if (taken.rows.length > 0) {
                return res.status(409).json({ error: 'That username is already taken' });
            }
            finalUsername = cleanUsername;
        } else {
            finalUsername = await generateUniqueUsername(name);
        }

        const hash = await bcrypt.hash(password, 12);
        const code = generateCode();
        const result = await pool.query(
            `INSERT INTO users (name, username, email, password_hash, verification_code, verification_expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '15 minutes')
             RETURNING id, name, username, email, is_verified, email_verified`,
            [name, finalUsername, email.toLowerCase(), hash, code]
        );
        const user = result.rows[0];
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        try {
            await sendEmail(user.email, 'Verify your SocialVerified account',
                `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`);
        } catch (emailErr) {
            // Don't block signup if email fails to send - account still works,
            // the person just won't have gotten a verification code yet.
            console.error('Verification email failed to send:', emailErr.message);
        }

        res.json({ token, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Signup failed' });
    }
});

router.post('/verify-email', requireAuth, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code is required' });
    try {
        const result = await pool.query(
            'SELECT verification_code, verification_expires_at FROM users WHERE id = $1',
            [req.userId]
        );
        const user = result.rows[0];
        if (!user || !user.verification_code) return res.status(400).json({ error: 'No pending verification' });
        if (new Date() > new Date(user.verification_expires_at)) {
            return res.status(400).json({ error: 'Code expired - request a new one' });
        }
        if (user.verification_code !== code.trim()) {
            return res.status(400).json({ error: 'Incorrect code' });
        }
        await pool.query(
            'UPDATE users SET email_verified = TRUE, verification_code = NULL, verification_expires_at = NULL WHERE id = $1',
            [req.userId]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not verify email' });
    }
});

router.post('/resend-verification', requireAuth, async (req, res) => {
    try {
        const userResult = await pool.query('SELECT email, email_verified FROM users WHERE id = $1', [req.userId]);
        const user = userResult.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });

        const code = generateCode();
        await pool.query(
            "UPDATE users SET verification_code = $1, verification_expires_at = NOW() + INTERVAL '15 minutes' WHERE id = $2",
            [code, req.userId]
        );
        await sendEmail(user.email, 'Your new SocialVerified verification code',
            `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not resend code' });
    }
});

// Always responds the same way whether or not the email exists, to avoid
// leaking which emails have accounts.
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    try {
        const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = userResult.rows[0];
        if (user) {
            const code = generateCode();
            await pool.query(
                "UPDATE users SET reset_code = $1, reset_expires_at = NOW() + INTERVAL '15 minutes' WHERE id = $2",
                [code, user.id]
            );
            try {
                await sendEmail(email.toLowerCase(), 'Reset your SocialVerified password',
                    `Your password reset code is: ${code}\n\nThis code expires in 15 minutes. If you didn't request this, you can ignore this email.`);
            } catch (emailErr) {
                console.error('Reset email failed to send:', emailErr.message);
            }
        }
        res.json({ ok: true, message: 'If that email has an account, a reset code has been sent.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not process request' });
    }
});

router.post('/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
        return res.status(400).json({ error: 'Email, code, and new password are all required' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    try {
        const result = await pool.query(
            'SELECT id, reset_code, reset_expires_at FROM users WHERE email = $1',
            [email.toLowerCase()]
        );
        const user = result.rows[0];
        if (!user || !user.reset_code) return res.status(400).json({ error: 'Invalid or expired code' });
        if (new Date() > new Date(user.reset_expires_at)) {
            return res.status(400).json({ error: 'Code expired - request a new one' });
        }
        if (user.reset_code !== code.trim()) {
            return res.status(400).json({ error: 'Incorrect code' });
        }
        const hash = await bcrypt.hash(newPassword, 12);
        await pool.query(
            'UPDATE users SET password_hash = $1, reset_code = NULL, reset_expires_at = NULL WHERE id = $2',
            [hash, user.id]
        );
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not reset password' });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid email or password' });
        const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, name: user.name, username: user.username, email: user.email, is_verified: user.is_verified, email_verified: user.email_verified } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed' });
    }
});

router.get('/me', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT id, name, username, email, is_verified, email_verified, is_admin FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
});

// Permanently deletes the account and everything tied to it (posts, messages,
// follows, etc. all cascade via foreign keys). Requires the current password
// as confirmation so a stolen session token alone can't nuke an account.
router.delete('/me', requireAuth, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });
    try {
        const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: 'User not found' });
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Incorrect password' });
        await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not delete account' });
    }
});

module.exports = router;
