-- signal — a new pinned post: everyone likes, reposts and replies again. Run after 0006. Safe to run more than once.
-- The old like / repost / reply tasks are switched off (rewards already earned stay). New tasks with new ids
-- point at the post in shared/brand.mjs → postId, so people who did the old ones see them as new trials.
insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('like-2',   'like',   'Like the pinned post',   'https://x.com/intent/like?tweet_id={post}',    250, 'timer', 5, '{}', true, 2),
  ('repost-2', 'repost', 'Repost the pinned post', 'https://x.com/intent/retweet?tweet_id={post}', 350, 'timer', 5, '{}', true, 3),
  ('reply-2',  'reply',  'Reply to the pinned post, then paste your reply link here', 'https://x.com/intent/tweet?in_reply_to={post}&text=gm%20signal.%20talking%20my%20way%20into%20the%20%24SIG%20reserve%20%F0%9F%9B%B0', 400, 'reply_url', 0, '{}', true, 4)
on conflict (id) do update set active = true, type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, min_wait_sec = excluded.min_wait_sec,
  required = excluded.required, sort = excluded.sort;
update tasks set active = false where id in ('like-1', 'repost-1', 'reply-1');
