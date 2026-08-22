CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT,
    avatar_url TEXT,
    cover_photo_url TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    is_private BOOLEAN DEFAULT FALSE,
    stripe_customer_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT,
    image_url TEXT,
    video_url TEXT,
    repost_of INTEGER REFERENCES posts(id) ON DELETE SET NULL, -- set for reposts/quote posts
    quote_text TEXT,                                            -- extra commentary on a quote post
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hashtags (
    id SERIAL PRIMARY KEY,
    tag TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS post_hashtags (
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id INTEGER REFERENCES hashtags(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, hashtag_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follows (
    follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id),
    CHECK (follower_id != following_id)
);

CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- who receives it
    actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- who caused it
    type TEXT NOT NULL,                                      -- 'like' | 'comment' | 'follow' | 'follow_request'
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follow_requests (
    requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    target_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (requester_id, target_id),
    CHECK (requester_id != target_id)
);

CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);

CREATE TABLE IF NOT EXISTS mutes (
    muter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    muted_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (muter_id, muted_id),
    CHECK (muter_id != muted_id)
);

-- These ALTERs exist because CREATE TABLE IF NOT EXISTS above does nothing
-- if the table already exists from an earlier deploy - it does NOT add new
-- columns to an existing table. This keeps the schema in sync without
-- ever dropping or losing existing data.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS repost_of INTEGER REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_text TEXT;

-- End-to-end encryption support: server only ever stores ciphertext + the IV
-- needed to decrypt it. It never sees a public/private key pairing that
-- would let it decrypt messages itself - only the two participants can.
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS iv TEXT;
