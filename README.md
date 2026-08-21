# SocialVerified — Deployment Guide

A real, deployable version of SocialVerified: Node/Express backend, PostgreSQL database,
real accounts (bcrypt + JWT), image uploads (Cloudinary), and real-time chat (Socket.IO).

Payments/verification badges have been removed for now — the `is_verified` column
still exists in the database for later, but there's currently no way to set it to true.
Add that back whenever you're ready (Stripe Checkout is the standard approach, same as
before, or you could grant it manually as an admin action instead of charging for it).

## 1. Create accounts you'll need (all have free tiers)

- **Render** (hosting + Postgres): https://render.com
- **Cloudinary** (image storage): https://cloudinary.com

## 2. Set up the database

On Render: **New → PostgreSQL** (free tier). Once created, copy the "External Database URL"
into `DATABASE_URL`.

## 3. Deploy the web service

1. Push this project to a GitHub repo.
2. On Render: **New → Web Service**, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all the environment variables from `.env.example` in Render's Environment tab
   (use your real Stripe/Cloudinary/Postgres values, not the placeholders).
6. Deploy. Render gives you a URL like `https://socialverified.onrender.com` — put that
   in `CLIENT_URL` and redeploy so Stripe redirects work correctly.
7. Run the database migration once, using Render's Shell tab (or run locally against
   the same DATABASE_URL): `npm run migrate`

## 4. Test end to end

1. Visit your deployed URL, sign up for an account.
2. Create a post, like it, comment on it — should all work and persist across reloads.
3. Open the chat widget and send a message.

## Local development

```bash
npm install
cp .env.example .env   # fill in real values, or point DATABASE_URL at a local Postgres
npm run migrate
npm start
```

Then visit http://localhost:3000

For testing Stripe webhooks locally, use the Stripe CLI:
```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

## Before opening this up to real users

- Add a visible Terms of Service and Privacy Policy.
- Consider what data you're storing (emails, messages) and how you'll handle deletion
  requests — this matters for GDPR/Kenya's Data Protection Act compliance if you have
  users there.
