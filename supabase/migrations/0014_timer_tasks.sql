-- X is used for sign-in only: no task is checked against X any more.
-- Every task on X is a 5-second timer after "Open on X"; no links to paste.
update tasks set verification = 'timer', min_wait_sec = 5
 where verification in ('reply_url', 'timer');

update tasks set title = 'Reply to the pinned transmission'              where id = 'reply-3';
update tasks set title = 'Quote the pinned transmission with your operator pass' where id = 'card-2';
update tasks set title = 'Post about signal with your invite link'       where id = 'quote-1';
update tasks set title = 'Quote the pinned transmission with your NFT'   where id = 'nft-quote';
