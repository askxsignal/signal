-- glyph — the reply task opens X's reply box for the pinned post straight away, with a prefilled comment.
update tasks set
  title = 'Reply to the pinned post, then paste your reply link here',
  action_url = 'https://x.com/intent/tweet?in_reply_to={post}&text=gm%20glyph.%20talking%20my%20way%20into%20the%20%24GLYPH%20reserve%20%F0%9F%8C%8A'
where id = 'reply-2';
