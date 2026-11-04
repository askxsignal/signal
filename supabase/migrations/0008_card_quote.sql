-- glyph — the card is now posted as a quote of the pinned post (shared/brand.mjs → postId). Run after 0007.
-- Safe to run more than once. The old card task is switched off (rewards already earned stay); everyone,
-- including people who posted the card before, gets the quote task as a new trial.
-- The server checks through X's oEmbed that the post is theirs, carries an image and names @askglyph
-- (the quoted link shows as x.com/askglyph/…). oEmbed cannot prove it is a native quote: review before a drop.
insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('card-2', 'card', 'Quote the pinned post with your glyph card, then paste the link here',
     'https://x.com/{handle}/status/{post}',
     750, 'reply_url', 0, '{}', true, 5)
on conflict (id) do update set active = true, type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, params = excluded.params,
  required = excluded.required, sort = excluded.sort;
update tasks set active = false where id = 'card-1';
