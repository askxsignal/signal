-- signal — the trials and the NFT quote in signal's words. Run after 0001 → 0012. Safe to run more than once.
-- Mechanics are unchanged: same task ids, rewards, mint trials (params.mint) and NFT tables.
-- Same ids, so anyone who already did a trial keeps it done.

update tasks set title = 'Follow @{handle} on X' where id = 'follow';
update tasks set title = 'Like the pinned transmission' where id = 'like-3';
update tasks set title = 'Repost the pinned transmission' where id = 'repost-3';
update tasks set
  title = 'Reply to the pinned transmission, then paste your reply link here',
  action_url = 'https://x.com/intent/tweet?in_reply_to={post}&text=ping.%20claiming%20my%20%24SIG%20allocation%20%F0%9F%9B%B0%EF%B8%8F'
where id = 'reply-3';
update tasks set title = 'Quote the pinned transmission with your operator pass, then paste the link here' where id = 'card-2';
update tasks set
  title = 'Post about signal with your invite link, then paste the link here',
  action_url = 'https://x.com/intent/tweet?text=talked%20my%20way%20into%20the%20%24SIG%20reserve.%20your%20turn%3A&url={ref}'
where id = 'quote-1';
update tasks set title = 'Quote the pinned transmission with your NFT, then paste the link here' where id = 'nft-quote';
