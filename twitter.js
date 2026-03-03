const express = require("express");
const router = express.Router();
const axios = require("axios");
const OAuth = require("oauth-1.0a");
const crypto = require("crypto");

// OAuth Client (User Context) 
// Provides access to organic_metrics (impression_count, etc.) for owned tweets
const oauth = OAuth({
  consumer: {
    key: process.env.X_CONSUMER_KEY,
    secret: process.env.X_CONSUMER_SECRET,
  },
  signature_method: "HMAC-SHA1",
  hash_function(baseString, key) {
    return crypto.createHmac("sha1", key).update(baseString).digest("base64");
  },
});

const userTokens = {
  key: process.env.X_ACCESS_TOKEN,
  secret: process.env.X_ACCESS_TOKEN_SECRET,
};

const USERNAME = "DailyCollegian";

// Cache
const cachedUserId   = { value: null };
const cachedAccount  = { date: new Date(0), data: {} };
const cachedVisits   = { date: new Date(0), data: {} };
const cachedTopPosts = { date: new Date(0), data: [] };

// Per-tweet stats cache with 15-minute rate-limit window (keep existing behavior)
let lastStatsRequest = {
  time: 0,
  ids: {},
};

function isCacheValid(cache) {
  const expiry = new Date(cache.date);
  expiry.setDate(expiry.getDate() + 1);
  return new Date() < expiry;
}

// Sign and execute a GET request with OAuth 1.0a */
function oauthGet(url, params = {}) {
  const urlWithParams =
    Object.keys(params).length > 0
      ? `${url}?${new URLSearchParams(params).toString()}`
      : url;

  const requestData = { url: urlWithParams, method: "GET" };
  const authHeader = oauth.toHeader(oauth.authorize(requestData, userTokens));

  return axios.get(urlWithParams, {
    headers: { ...authHeader, "Content-Type": "application/json" },
  });
}

// Get (and cache) the numeric user ID for @DailyCollegian */
async function getUserId() {
  if (cachedUserId.value) return cachedUserId.value;
  const res = await oauthGet(`https://api.x.com/2/users/by/username/${USERNAME}`);
  cachedUserId.value = res.data.data.id;
  return cachedUserId.value;
}

/**
 * Fetch all tweets in the given time window with organic_metrics.
 * Paginates automatically via next_token.
 */
async function fetchTweets(userId, startTime) {
  const tweets = [];
  let nextToken;

  do {
    const params = {
      start_time:      startTime.toISOString(),
      max_results:     100,
      "tweet.fields":  "created_at,organic_metrics,attachments,text",
      expansions:      "attachments.media_keys",
      "media.fields":  "url,preview_image_url,type",
      ...(nextToken ? { pagination_token: nextToken } : {}),
    };

    const res = await oauthGet(
      `https://api.x.com/2/users/${userId}/tweets`,
      params
    );

    const page = res.data;
    if (!page.data?.length) break;

    tweets.push(...page.data);

    const oldest = new Date(page.data[page.data.length - 1].created_at);
    if (oldest < startTime) break;

    nextToken = page.meta?.next_token;
  } while (nextToken);

  return tweets;
}
/**
 * GET /account
 * 7-day summary. Mirrors Facebook /account shape:
 * {
 *   posts_count,
 *   monthly_followers,    // always 0 — X API does not expose follower gain delta
 *   monthly_engagements,
 *   monthly_reach,        // impression_count via organic_metrics
 *   total_followers
 * }
 */
router.get("/account", async (_, res) => {
  if (isCacheValid(cachedAccount)) return res.json(cachedAccount.data);

  try {
    const userId    = await getUserId();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 7);

    const [userRes, tweets] = await Promise.all([
      oauthGet(`https://api.x.com/2/users/${userId}`, {
        "user.fields": "public_metrics",
      }),
      fetchTweets(userId, startTime),
    ]);

    const totalFollowers = userRes.data.data.public_metrics.followers_count;

    let monthly_engagements = 0;
    let monthly_reach = 0;

    tweets.forEach(({ organic_metrics: m }) => {
      monthly_reach       += m.impression_count || 0;
      monthly_engagements +=
        (m.like_count    || 0) +
        (m.retweet_count || 0) +
        (m.reply_count   || 0) +
        (m.quote_count   || 0);
    });

    const result = {
      posts_count:         tweets.length,
      monthly_followers:   0,
      monthly_engagements,
      monthly_reach,
      total_followers:     totalFollowers,
    };

    cachedAccount.date = new Date();
    cachedAccount.data = result;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /visits
 * Daily impression totals for the last 7 days.
 * Mirrors Facebook /visits shape: { "YYYY-MM-DD": <impressions>, ... }
 */
router.get("/visits", async (_, res) => {
  if (isCacheValid(cachedVisits)) return res.json(cachedVisits.data);

  try {
    const userId    = await getUserId();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 7);

    const tweets = await fetchTweets(userId, startTime);

    const dailyImpressions = {};
    tweets.forEach(({ created_at, organic_metrics }) => {
      const day = created_at.slice(0, 10); // "YYYY-MM-DD"
      dailyImpressions[day] =
        (dailyImpressions[day] || 0) + (organic_metrics.impression_count || 0);
    });

    cachedVisits.date = new Date();
    cachedVisits.data = dailyImpressions;
    res.json(dailyImpressions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /top-posts
 * Top 5 tweets from the last 7 days by impression_count.
 * Mirrors Facebook /top-posts shape:
 * [{ title, image, reach, date, link }, ...]
 */
router.get("/top-posts", async (_, res) => {
  if (isCacheValid(cachedTopPosts)) return res.json(cachedTopPosts.data);

  try {
    const userId    = await getUserId();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 7);

    // Single page fetch (100 tweets covers any 7-day window comfortably)
    const rawRes = await oauthGet(
      `https://api.x.com/2/users/${userId}/tweets`,
      {
        start_time:      startTime.toISOString(),
        max_results:     100,
        "tweet.fields":  "created_at,organic_metrics,attachments,text",
        expansions:      "attachments.media_keys",
        "media.fields":  "url,preview_image_url,type",
      }
    );
    // Build mediaKey → URL lookup from includes
    const mediaMap = {};
    (rawRes.data.includes?.media || []).forEach((m) => {
      mediaMap[m.media_key] = m.url || m.preview_image_url || null;
    });

    const result = (rawRes.data.data || [])
      .map((tweet) => {
        const mediaKey = tweet.attachments?.media_keys?.[0] || null;
        return {
          title: tweet.text,
          image: mediaKey ? (mediaMap[mediaKey] || null) : null,
          reach: tweet.organic_metrics.impression_count || 0,
          date:  new Date(tweet.created_at).toLocaleDateString("en-US"),
          link:  `https://x.com/${USERNAME}/status/${tweet.id}`,
        };
      })
      .sort((a, b) => b.reach - a.reach)
      .slice(0, 5);

    cachedTopPosts.date = new Date();
    cachedTopPosts.data = result;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stats/:tweetId
 * Raw organic_metrics + non_public_metrics for a single tweet.
 * Rate-limited: one fresh API call per 15-minute window.
 * Cached tweet IDs are served instantly within the window.
 *
 * TODO: Validate tweet is < 30 days old and authored by @DailyCollegian
 */
router.get("/stats/:tweetId", (req, res) => {
  const { tweetId } = req.params;
  const RATE_LIMIT_MS = 60 * 1000 * 15;

  if (Date.now() - lastStatsRequest.time < RATE_LIMIT_MS) {
    if (lastStatsRequest.ids[tweetId])
      return res.json(lastStatsRequest.ids[tweetId]);

    return res.status(429).json({
      wait: RATE_LIMIT_MS - (Date.now() - lastStatsRequest.time),
    });
  }

  lastStatsRequest.time = Date.now();

  oauthGet(`https://api.x.com/2/tweets/${tweetId}`, {
    "tweet.fields": "non_public_metrics,organic_metrics",
  })
    .then((response) => {
      lastStatsRequest.ids[tweetId] = response.data.data;
      res.json(response.data.data);
    })
    .catch((err) => res.status(500).json({ error: err.message }));
});

module.exports = router;