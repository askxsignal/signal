// Task list used by DEMO mode. Production reads the same rows from the `tasks` table
// (seeded by supabase/migrations, last updated in 0014_timer_tasks.sql) — keep the two in sync.
// action_url placeholders: {handle} {post} {ref} — see shared/brand.mjs → taskUrl().

export const DEMO_TASKS = [
  { id: 'follow', type: 'follow', title: 'Follow @{handle} on X', reward: 500, verification: 'timer', waitSec: 5, required: true,
    actionUrl: 'https://x.com/intent/follow?screen_name={handle}', params: { mint: true } },
  { id: 'like-3', type: 'like', title: 'Like the pinned transmission', reward: 250, verification: 'timer', waitSec: 5, required: true,
    actionUrl: 'https://x.com/intent/like?tweet_id={post}', params: { mint: true } },
  { id: 'repost-3', type: 'repost', title: 'Repost the pinned transmission', reward: 350, verification: 'timer', waitSec: 5, required: true,
    actionUrl: 'https://x.com/intent/retweet?tweet_id={post}', params: { mint: true } },
  { id: 'reply-3', type: 'reply', title: 'Reply to the pinned transmission', reward: 400, verification: 'timer', waitSec: 5, required: true,
    actionUrl: 'https://x.com/intent/tweet?in_reply_to={post}&text=ping.%20claiming%20my%20%24SIG%20allocation%20%F0%9F%9B%B0%EF%B8%8F', params: { mint: true } },
  { id: 'card-2', type: 'card', title: 'Quote the pinned transmission with your operator pass', reward: 750, verification: 'timer', waitSec: 5, required: true,
    actionUrl: 'https://x.com/{handle}/status/{post}', params: { mint: true } },
  { id: 'quote-1', type: 'post', title: 'Post about signal with your invite link', reward: 500, verification: 'timer', waitSec: 5, required: false,
    actionUrl: 'https://x.com/intent/tweet?text=talked%20my%20way%20into%20the%20%24SIG%20reserve.%20your%20turn%3A&url={ref}' },
  { id: 'invite-2', type: 'invite', title: 'Bring 2 friends who finish a task', reward: 1000, verification: 'referral', waitSec: 0, required: false,
    actionUrl: null, params: { need: 2 } },
]

// Persuasion bonus tiers (cumulative). Mirrors app_config rows pitch_t1..pitch_t3 / pitch_attempts.
export const PITCH = { tiers: [300, 700, 1500], attempts: 3 }
export const WELCOME_BONUS = 100
