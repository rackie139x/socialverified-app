const nodemailer = require('nodemailer');

// Uses Gmail SMTP. Gmail requires an "App Password" (not the regular account
// password) for this to work - generate one at myaccount.google.com/apppasswords,
// which requires 2-Step Verification to be turned on for the sending account first.
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

async function sendEmail(to, subject, text) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
        console.error('Email not configured - EMAIL_USER/EMAIL_APP_PASSWORD missing from environment');
        throw new Error('Email sending is not configured on the server');
    }
    await transporter.sendMail({
        from: `"SocialVerified" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        text
    });
}

function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
}

module.exports = { sendEmail, generateCode };
