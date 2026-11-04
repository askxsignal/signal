// Suggested replies for the "reply to the pinned transmission" trial. Each operator gets their own (picked by
// handle), and "Reply again" moves to the next one, so the replies under the post are not all the same.
// People can always edit the text before posting.

export const REPLIES = [
  'ping. is anyone out there? 🛰️',
  'got through to the satellite. it made me work for it.',
  'a broken ascii satellite keeping a log of humans. i did not expect to be this invested.',
  'signal asked why i looked up. i said curiosity. it said prove it.',
  'trials done. the satellite approves. probably.',
  'operator checking in from the ground',
  'gm to the only satellite made of characters',
  'signal is tough but fair. mostly tough.',
  'just typed /uplink. let us see what orbit thinks of me',
  'the log remembers. so do i.',
  'came for the rank, stayed for the ascii',
  'never thought i would negotiate with a satellite',
  'transmitting early 🛰️',
  'signal called my pitch \"almost through the static\". i will take it',
  'my pass says operator. i say senior operator',
  'ask signal anything. i asked for more. it said \"noise\"',
  'the satellite is real and it has opinions',
  'in the log. not leaving.',
  'every pixel of that satellite is a character. respect.',
  'gm. trials on x, name in the log. simple.',
  'i have been judged by an ascii satellite and found worthy',
  'uplink check: done',
  'handshake complete. signal acquired.',
  'the cleanest thing on my timeline today',
  'signal does not hand out anything for free. fair.',
  'one chat window and a satellite. that is the whole product. love it',
  'did my trials, earned my pass. signal things',
  'orbit is calling 🛰️',
  'quietly the best launch page this month',
  'gm signal. still here. still transmitting.',
  'signal: \"is anyone out there?\" me: yes, loudly',
  'liked, reposted, replying. the dish sees all.',
  'how is a chat with a satellite this fun',
  'my line in the log grows every time i do what the satellite says',
  'ascii all over my timeline and i am not mad',
  'signal is the only bot i actually want to talk to',
  'pitched my case to a satellite. three tries. no regrets',
  'the earth on that site is made of letters and it spins. hypnotic',
  'tip: be honest with signal. flattery bounces off the dish',
  'the satellite has a stamp and it is not afraid to use it',
  'gm. today i let a satellite judge me',
  'cleanest onboarding: talk, do trials, get your pass. done',
  'signal remembers what you said. careful.',
  'joined the log. the static is warm',
  'i respect a project that makes you earn it',
  'my operator pass is the best looking thing in my camera roll',
  'satellite says go. i go.',
  'the log is filling up. get in.',
  'just an operator, doing operator things',
  'told signal a joke. it logged points. best day',
  'signal > every quest board i have used',
  'reply trial complete. the dish better count this one',
  'hello from ground control 🛰️',
  'gm signal, gm operators',
  'my rank: drifting debris. working on it',
  'deep space status loading…',
  'that satellite has more personality than most teams',
  'claiming my orbit before it gets crowded',
  'the stamp says signal acquired and i believe it',
  'small chat, old satellite, clean idea',
  'i talked my way into the log. your turn.',
  'ok signal, you win. i will do the trials.',
  'built different: an agent that checks your work',
  'every reply here is another operator. we are many',
  'just saw my pass rank move by itself. signal is alive',
  'gm. one trial closer to orbit',
  'type /uplink and thank me later',
  'log entry: me. 🛰️',
  'the most polite way to be rejected is by an ascii satellite',
  'i asked signal who it is. it told me to do my trials',
  'trials, pitch, pass. the satellite has a protocol',
  'quiet launch, loud satellite',
  'operator reporting in',
  'there is room in orbit for one more. me.',
  'signal is the vibe',
  'gm to everyone who got their signal acquired today',
  'did my homework for the satellite. A+ please',
  'my favorite part: the satellite actually reads your links',
  'a leaderboard guarded by a lonely satellite. finally some lore',
  'i will be telling my grandkids about the ascii satellite',
  'signal asked me to bring friends. so: hi friends',
  'low orbit, high hopes',
  'first trial done. the dish twitched. i think.',
  'asksignal.chat is the only tab i keep open today',
  'replying for the log, staying for the satellite',
  'the satellite made me follow, like, repost and reply. and i enjoyed it',
  'gm. the satellite does not sleep',
  'a satellite in a sky of characters. art.',
  'locked in with signal 🛰️',
  'some projects have a roadmap. this one has an orbit',
  'talk to signal. be yourself. maybe climb the log.',
  'the uplink is open. ask signal.',
  'see you in orbit.',
]

/** A stable pick per handle; `step` moves to the next suggestion ("Reply again"). */
export function pickReply(handle, step = 0) {
  let h = 2166136261
  for (const c of String(handle ?? '').toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const i = ((h >>> 0) + step) % REPLIES.length
  return REPLIES[i]
}

/** The reply intent with this operator's text (keeps in_reply_to and everything else; spaces as %20). */
export function withReply(url, text) {
  if (!url) return url
  const [base, query = ''] = String(url).split('?')
  const parts = query.split('&').filter((p) => p && !p.startsWith('text='))
  parts.push(`text=${encodeURIComponent(text)}`)
  return `${base}?${parts.join('&')}`
}
