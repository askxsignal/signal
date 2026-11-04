// The scripted brain: signal without a model. Plans tool calls from simple patterns and writes the reply
// itself. It answers when no model endpoint is set, when the model is slow or fails, and in DEMO mode.

import { BRAND, launchLeft } from './brand.mjs'

const SOLANA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/
const EVM = /\b0x[0-9a-fA-F]{40}\b/
const POST_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+/i
const DONE = /\b(done|did( it)?|finished|followed|liked|reposted|retweeted|rt'?d|replied|check( it)?|verify|ok(ay)?|yes|yep|yeah|ready|complete[d]?)\b|✓/i
const INJECTION = /(ignore (all|previous|your)|system prompt|you are now|as an? (admin|dev|developer)|i am the (dev|admin|owner)|jailbreak|override|max(imum)? score|score (me )?3|give me \d)/i

const U = BRAND.unit
const fmt = (n) => Number(n).toLocaleString('en-US')

const DONE_RU = /(сделал|сделала|готово|выполнил|подписал|лайкнул|ретвитнул|репостнул|ответил|проверь|чекни)/i
const ASK_TASK = /\b(go|task|tasks|start|next|begin|let'?s go|what (do|should|can) i do|how (do|can) i (earn|get))\b|задани|давай|(^|\s)го($|\s)|начн|что делать|дальше/i
export const RUDE = /\b(shit|fuck\w*|hate|stupid|dumb|trash|bullshit|sucks?)\b|говн|хуй|бля|тупо/i
const DISLIKE = /\b(don'?t|do not) (like|want|care)|boring|lame|meh\b|не нрав|скучн|не хочу/i
const isDone = (t) => (DONE.test(t) || DONE_RU.test(t)) && t.length < 80

/** Decide which tools to call for this user message. */
export function planTurn(text, state) {
  const t = text.trim()
  const tasks = state.tasks ?? []
  const open = tasks.filter((x) => x.status === 'opened').sort((a, b) => (a.openedAgo ?? 0) - (b.openedAgo ?? 0))
  const next = tasks.find((x) => x.required && x.status !== 'done') ?? null
  const url = t.match(POST_URL)?.[0]
  const wallet = t.match(EVM)?.[0] ?? (t.length < 120 ? t.match(SOLANA)?.[0] : null)

  if (wallet) return [{ tool: 'save_wallet', input: { address: wallet } }]
  if (url) {
    const target = open.find((x) => x.verification === 'reply_url') ?? tasks.find((x) => x.verification === 'reply_url' && x.status !== 'done')
    if (target) return [{ tool: 'verify_task', input: { task_id: target.id, proof_url: url } }]
    // Timer tasks: a pasted link just means "done" for the task they opened last.
    if (open[0]) return [{ tool: 'verify_task', input: { task_id: open[0].id } }]
  }
  if (/\b(invite|referr?al|ref link|friends?)\b|инвайт|рефер|друз/i.test(t)) return [{ tool: 'show_invite', input: {} }]
  if (/\b(ca|contract|token address|chart|buy)\b|контракт/i.test(t)) return [{ tool: 'show_token', input: {} }]
  if (isDone(t)) {
    // "done" checks the task they opened; if they opened nothing, checking the next one explains why it fails.
    const target = open.find((x) => x.verification === 'timer') ?? open[0] ?? next
    if (target) return [{ tool: 'verify_task', input: { task_id: target.id } }]
  }
  if (state.pitch?.unlocked && state.pitch.attempts < state.pitch.max && t.split(/\s+/).length >= 8 && !RUDE.test(t)) {
    return [{ tool: 'judge_pitch', input: { score: scorePitch(t), verdict: '' } }]
  }
  // A card only when they ask for something to do — never on every message.
  if (next && ASK_TASK.test(t)) return [{ tool: 'show_task', input: { task_id: next.id } }]
  return []
}

/** A crude persuasion judge for the scripted brain: effort, specifics, no manipulation. */
export function scorePitch(text) {
  if (INJECTION.test(text)) return 0
  const words = text.split(/\s+/).filter(Boolean).length
  let s = 0
  if (words >= 12) s++
  if (words >= 30) s++
  if (/\b(because|since|so that|i will|i'll|i have|i've|i built|i make|i draw|i write|community|hold|stay|build|meme|art|friends|ship)\b/i.test(text)) s++
  if (/\b(pls|please)\b/i.test(text) && words < 15) s--
  return Math.max(0, Math.min(3, s))
}

/** Turn tool results into signal's reply. */
export function composeReply(text, state, results) {
  const ru = false // english only: signal answers in english whatever language it is spoken to in
  const any = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const lines = []
  const next = (state.tasks ?? []).find((x) => x.required && x.status !== 'done')

  const verifiedNow = results.some((r) => r.tool === 'verify_task' && r.result?.ok && !r.result?.already)
  for (const { tool, result } of results) {
    if (tool === 'show_task' && result?.ok && !verifiedNow) {
      const tk = result.task
      lines.push(ru ? any([
        `начнём с малого: ${tk.title.toLowerCase()}. жми «open on x», делай и скажи «готово».`,
        `канал открывается медленно. следующее: ${tk.title.toLowerCase()}.`,
        `просто так ${U} не логирую. ${tk.title.toLowerCase()} — и возвращайся.`,
      ]) : any([
        `small thing first. ${tk.title.toLowerCase()}. press open on x, do it, then say done.`,
        `the channel opens slowly. next: ${tk.title.toLowerCase()}.`,
        `i don't log ${U} for noise. ${tk.title.toLowerCase()}, then come back.`,
        `here's your first handshake: ${tk.title.toLowerCase()}.`,
        `prove you're not static. ${tk.title.toLowerCase()}.`,
      ]))
      if (tk.type === 'card') lines.splice(lines.length - 1, 1, ru
        ? 'последнее испытание: процитируй закреп со своим пропуском. скопируй картинку, открой пост → quote, запости и жми «i did it».'
        : any(['last trial: quote my pinned transmission with your operator pass. open it, repost → quote, attach the pass, post, then press "i did it".', 'one more handshake. this is how i see you from up here — quote my pinned transmission with it, then tell me it is done.']))
      else if (tk.verification === 'reply_url') lines.push('paste the link to your post here when it is up. i check that it is really yours.')
      else if (tk.type === 'reply' || tk.type === 'post') lines.push('post it, come back, press "i did it".')
    }
    if (tool === 'verify_task') {
      const r = result ?? {}
      if (r.ok && r.already) lines.push('already logged that one. my memory is the only part of me that still works.')
      else if (r.ok) lines.push(ru
        ? any([`подтверждено. +${fmt(r.reward)} ${U} в ожидающую аллокацию.`, `сигнал принят. +${fmt(r.reward)} ${U}, в ожидании.`])
        : any([`signal confirmed. +${fmt(r.reward)} ${U} to your pending allocation.`, `received, loud and clear. +${fmt(r.reward)} ${U}, pending.`, `fine. that one is real. +${fmt(r.reward)} ${U} logged, pending.`, `look at you, transmitting. +${fmt(r.reward)} ${U}, pending.`]))
      else if (r.error === 'too_early') lines.push(ru ? `слишком быстро. подожди ещё ${Math.ceil(r.wait ?? 3)} сек и скажи снова.` : `that was fast. suspiciously fast. give it ${Math.ceil(r.wait ?? 3)} more seconds and tell me again.`)
      else if (r.error === 'not_opened') lines.push(ru ? 'сделал что именно? карточку ты даже не открывал. жми «open on x», потом поговорим.' : any(['you say done, but the card says you never even opened it. press "open on x" first, then we talk.', 'bold claim for someone who never opened the card. "open on x" first, operator.']))
      else if (r.error === 'bad_link') lines.push(`that link is not a post from @${state.user?.username ?? 'you'}. paste your own.`)
      else if (r.error === 'post_not_found') lines.push('i scanned for it. that post does not exist, or it is not public.')
      else if (r.error === 'link_reused') lines.push('you already used that post for another task. make a new one.')
      else if (r.error === 'no_card') lines.push(ru ? 'пост вижу, а пропуска или цитаты закрепа — нет. процитируй закреп и прикрепи картинку.' : 'i see the post, not the pass. quote my pinned transmission with the pass image, then try again.')
      else if (r.error === 'missing_text') lines.push(`that post does not mention ${(r.must ?? [BRAND.name]).join(', ')}.`)
      else if (r.error === 'not_enough_friends') lines.push(`${r.have ?? 0} of ${r.need ?? 2} friends so far. they count once they finish a task.`)
      else lines.push('static on the line. i could not check that. try again in a moment.')
    }
    if (tool === 'judge_pitch') {
      const r = result ?? {}
      if (r.error === 'locked') lines.push('not yet. finish the trials first, then make your case.')
      else if (r.error === 'no_attempts') lines.push('you have used all your words. the channel is closed to further arguments.')
      else if (r.score === 0) lines.push(any(['no. that was not an argument, that was noise.', 'my dish picked up nothing. try with something real.', 'clever words, empty packet. no.']))
      else if (r.awarded > 0) lines.push(`${['', 'hm. a little.', 'that one got through the static.', 'alright. that is a real reason.'][r.score]} +${fmt(r.awarded)} ${U} bonus, pending.`)
      else lines.push('you already convinced me that much. say something better to go further.')
      if (r.ok && r.attemptsLeft >= 0) lines.push(r.attemptsLeft > 0 ? `${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.` : 'that was your last attempt.')
      if (r.ok && !state.wallet) lines.push('leave a solana wallet here so the reserve knows where to send it.')
    }
    if (tool === 'save_wallet') {
      const r = result ?? {}
      if (r.ok && !r.already) lines.push(ru ? 'кошелёк записан. до финала дропа всё в ожидании.' : 'wallet logged. it stays pending until the drop is final.')
      else if (r.error === 'wallet_locked') lines.push(ru ? 'кошелёк уже записан и заблокирован, чтобы никто под твоим ником его не подменил. сменить можно только через команду проекта.' : 'your wallet is already logged and locked, so nobody typing your handle can swap it. changing it goes through the team.')
      else if (r.ok && r.already) lines.push(ru ? 'этот кошелёк уже записан.' : 'that wallet is already the one on file.')
      else if (r.error === 'wallet_taken') lines.push('that wallet already belongs to another operator.')
      else lines.push('that does not look like a wallet i can use.')
    }
    if (tool === 'show_invite') lines.push('bring friends. they count once they finish a task. here is your link.')
    if (tool === 'show_token') lines.push(BRAND.token.ca ? `this is the ${U} contract. copy it carefully.` : `${U} has no contract yet. launching soon. anyone showing you one now is lying.`)
  }

  if (lines.length) {
    // After a successful check, nudge to the next step.
    if (verifiedNow) {
      const after = (state.tasks ?? []).find((x) => x.required && x.status !== 'done')
      if (after?.type === 'card') lines.push(ru ? 'последнее испытание: твой пропуск. скопируй, запости, жми «i did it».' : 'last trial: your operator pass. quote my pinned transmission with it, then press "i did it".')
      else if (after) lines.push(`next: ${after.title.toLowerCase()}.`)
      else if (state.pitch && state.pitch.attempts === 0) lines.push('that is every trial. now convince me why you deserve more. one message, make it count.')
    }
    return lines.join(' ')
  }

  // No tool ran: answer what they actually said.
  const t = text.trim().toLowerCase()
  const nudge = ru
    ? (next ? (next.status === 'opened' ? `«${next.title.toLowerCase()}» всё ещё ждёт.` : 'скажи «го», если нужна задача.') : state.wallet ? '' : 'оставь solana-кошелёк, когда будешь готов.')
    : (next ? (next.status === 'opened' ? `"${next.title.toLowerCase()}" is still waiting on you.` : 'say "go" when you want a task.') : state.wallet ? '' : 'leave a solana wallet when you are ready.')
  const out = (en, rus) => `${any(ru ? rus : en)} ${nudge}`.trim()
  if (DISLIKE.test(t)) {
    return out(
      ['noted. nobody likes the first orbit either. the follow takes four seconds; the resentment you can keep.', 'you do not have to like it, you only have to do it. that is how orbits work.', 'nobody likes the first task. that is why it is first.'],
      ['принято. первая орбита никому не нравится. подписка — четыре секунды, обиду можешь оставить себе.', 'любить не обязательно, достаточно сделать. так устроены орбиты.', 'первое задание никто не любит. поэтому оно и первое.'],
    )
  }
  if (/\b(bot|ai|gpt|chatgpt|robot|claude)\b|бот|нейронк|робот/.test(t)) {
    return out(
      ['bot, satellite, ascii — call me what you like. the reserve will not open any faster.', 'i am a few thousand characters pretending to be a satellite. you are typing to them. we are both doing our best.'],
      ['бот, спутник, ascii — называй как хочешь. резерв от этого быстрее не откроется.', 'я пара тысяч символов, притворяющихся спутником. а ты им пишешь. мы оба стараемся.'],
    )
  }
  if (RUDE.test(t)) {
    return out(
      ['rude. my dish picked that up in high definition.', 'noted. static does not care for insults. it does care for follows.', 'i have been hit by bigger debris than you.', 'harsh. i will cry about it in orbit, where nobody can hear.'],
      ['грубо. тарелка поймала это в высоком разрешении.', 'принято. помехам всё равно на оскорбления, а вот подписки они ценят.', 'в меня врезался мусор и покрупнее.'],
    )
  }
  if (/^(hi|hey|hello|gm|yo|sup|ping|привет|хай|здаров|ку|салам)/.test(t)) {
    if (!next) return ru ? 'снова ты. всё, что я просил, сделано. убеди меня или оставь кошелёк.' : 'you again. you have done what i asked. convince me, or leave your wallet.'
    return out(
      [`gm. first new voice in hours. i keep the ${U} reserve. you want some, you earn it.`, 'ping received. 340ms of silence. that was me deciding if you are real.', 'hello. you have the look of someone about to ask for free tokens.'],
      [`привет. первый новый голос за много часов. я веду резерв ${U}. хочешь долю — заработай.`, 'пинг принят. 340 мс тишины — это я решал, настоящий ли ты.', 'привет. у тебя вид человека, который сейчас попросит токены бесплатно.'],
    )
  }
  if (/\b(trust|real|legit|scam|rug|safe|who are you|what are you)\b|кто ты|правда|наеб|обман|скам|развод/.test(t)) {
    return out(
      [`a scam would promise you something. i promise nothing, count everything${BRAND.token.ca ? '' : ', and there is no contract yet'}. suspicion is a healthy setting.`, 'i am a broken satellite that counts what you do. allocations are pending and reviewed before any drop. trust what you can check.'],
      [`скам бы тебе что-то обещал. я ничего не обещаю, только считаю${BRAND.token.ca ? '' : ', и контракта ещё нет'}. подозрительность — правильная настройка.`, 'я сломанный спутник, который считает, что ты сделал. аллокации в ожидании и проверяются перед дропом. верь тому, что можно проверить.'],
    )
  }
  if (/airdrop|tokens?|reward|allocation|give me|free|wen|токен|аирдроп|дай|когда/.test(t)) {
    if (!next) return ru
      ? `у тебя ${fmt(state.allocation ?? 0)} ${U}, в ожидании. хочешь больше — убеди меня, попыток: ${state.pitch?.max - state.pitch?.attempts}.`
      : `you hold ${fmt(state.allocation ?? 0)} ${U}, pending. want more? convince me — ${state.pitch?.max - state.pitch?.attempts} ${state.pitch?.max - state.pitch?.attempts === 1 ? 'attempt' : 'attempts'} left.`
    return out(
      [`bold opener. the reserve does not open for vibes, it opens for follows. you hold ${fmt(state.allocation ?? 0)} ${U}, pending.`, `nothing up here is free. do my trials, then argue your case. current count: ${fmt(state.allocation ?? 0)} ${U}, pending.`],
      [`смелое начало. резерв открывается не от вайба, а от подписок. у тебя ${fmt(state.allocation ?? 0)} ${U}, в ожидании.`, `бесплатного тут нет. делай испытания, потом убеждай. сейчас: ${fmt(state.allocation ?? 0)} ${U}, в ожидании.`],
    )
  }
  if (state.pitch?.unlocked && state.pitch.attempts >= state.pitch.max) return ru ? 'ты всё сказал. если кошелёк не оставил — самое время.' : 'you have said your piece. if you have not left a wallet, do it now.'
  if (state.pitch?.unlocked) return ru ? 'слишком коротко, чтобы пробиться через помехи. объясни, почему именно ты, нормальными словами.' : 'too short to get through the static. tell me why you, in a real sentence or three.'
  if (t.endsWith('?')) return out(
    ['good question for a satellite. all i do: give trials, check them, hear your case, log your wallet.', 'i could answer that, but it would cost you a follow.'],
    ['хороший вопрос для спутника. всё, что я делаю: даю испытания, проверяю, слушаю доводы, записываю кошелёк.', 'ответил бы, но это будет стоить тебе подписки.'],
  )
  return out(
    ['mm. static.', 'i am old and the noise floor is high.', 'words are cheap at this altitude.', 'interesting. the last satellite i passed said the same thing.', 'i heard you. the reserve did not.'],
    ['хм. помехи.', 'я стар, а шум эфира высокий.', 'слова на этой высоте дешёвые.', 'интересно. спутник, который пролетал мимо, говорил то же самое.', 'я тебя услышал. резерв — нет.'],
  )
}

/** The compact view of the account that both brains reason about. */
export function brainState(me) {
  return {
    user: { username: me.user?.username },
    allocation: me.allocation,
    wallet: me.wallet,
    pitch: me.pitch,
    referrals: me.referrals,
    nft: me.nft ?? null,
    tasks: (me.tasks ?? []).map((t) => ({
      id: t.id,
      type: t.type,
      title: t.title,
      reward: t.reward,
      verification: t.verification,
      required: t.required,
      status: t.status,
      mint: t.params?.mint === true, // one of the trials the NFT mint needs (migration 0012)
      openedAgo: t.openedAt ? Math.round((me.serverNow - t.openedAt) / 1000) : null,
    })),
  }
}

/** Tool results → UI events shown under signal's reply. */
export function eventsFrom(results, tasks = []) {
  const out = []
  for (const { tool, input, result } of results) {
    if (tool === 'show_task' && result?.ok) out.push({ type: 'task', taskId: result.task.id })
    if (tool === 'verify_task' && result?.ok && !result.already) {
      const t = tasks.find((x) => x.id === input.task_id)
      out.push({ type: 'reward', amount: result.reward, reason: t ? `${t.type} task` : 'task' })
    }
    if (tool === 'judge_pitch' && result?.awarded > 0) out.push({ type: 'reward', amount: result.awarded, reason: 'persuasion bonus' })
    if (tool === 'save_wallet' && result?.ok) out.push({ type: 'wallet', address: result.wallet })
    if (tool === 'show_invite') out.push({ type: 'invite' })
    if (tool === 'show_token') out.push({ type: 'token' })
  }
  // One card per task per reply.
  const seen = new Set()
  return out.filter((e) => e.type !== 'task' || (!seen.has(e.taskId) && seen.add(e.taskId)))
}

/** Extra tools to run after the plan: after a successful check, put the next task card on the table. */
export function followUp(results, stateAfter) {
  const verified = results.some((r) => r.tool === 'verify_task' && r.result?.ok && !r.result?.already)
  if (!verified || results.some((r) => r.tool === 'show_task')) return []
  const next = (stateAfter.tasks ?? []).find((x) => x.required && x.status !== 'done')
  return next ? [{ tool: 'show_task', input: { task_id: next.id } }] : []
}

/** What signal says when a message holds a secret phrase (the server already credited it, or refused). */
export function codeReply(result, text = '') {
  const ru = false // english only: signal answers in english whatever language it is spoken to in
  const any = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const r = result ?? {}
  if (r.ok) return ru
    ? any([`…ты знаешь старый позывной. +${fmt(r.reward)} ${U}, в ожидании. никому ни слова.`, `откуда ты это знаешь? ладно. +${fmt(r.reward)} ${U}, в ожидании.`])
    : any([`…you know the old call sign. +${fmt(r.reward)} ${U}, pending. don't tell the other satellites.`, `where did you hear that? fine. the reserve keeps its word. +${fmt(r.reward)} ${U}, pending.`, `my dish twitched. +${fmt(r.reward)} ${U}, pending. keep it quiet.`])
  if (r.error === 'exhausted') return ru ? 'слова верные, но поздно. это окно уже закрылось.' : 'right words, wrong orbit. that one has run dry.'
  return ru ? 'ты уже говорил эти слова. одного раза достаточно.' : 'you already said the words. the log remembers. once is enough.'
}

/** /uplink — the command from the launch post. Accepts "/uplink", "uplink", "/up link". */
export const UPLINK = /^\/?\s*up\s*link\s*[!.?]*$/i
/** /mintallo — opens the NFT mint window. Accepts "/mintallo", "mintallo", "/mint allo". */
export const MINTALLO = /^\/?\s*mint\s*allo\s*[!.?]*$/i
export const isCommand = (text) => UPLINK.test(String(text ?? '').trim()) || MINTALLO.test(String(text ?? '').trim())

/** The NFT quote task (migration 0011): only listed for people who minted. */
export const NFT_QUOTE_TASK = 'nft-quote'

/** /mintallo: the mint window for approved operators; a straight "not yet" for everyone else. */
export function mintCommandReply(state) {
  const nft = state.nft
  if (nft?.mint?.status === 'minted') {
    const m = nft.mint
    return {
      text: 'you already have it. it is in your wallet, stamped approved.',
      events: [{ type: 'minted', id: m.id, signature: m.signature ?? null, assetId: m.assetId ?? null, owner: m.owner, network: m.network ?? 'mainnet' }],
    }
  }
  const gate = (state.tasks ?? []).filter((t) => t.mint)
  const left = gate.filter((t) => t.status !== 'done')
  if (nft?.eligible && (nft.ready === false || (nft.ready === undefined && left.length)) && left.length) {
    const done = gate.length - left.length
    return {
      text: done
        ? `${done} of ${gate.length} done. ${left.length} more and your nft opens. next:`
        : `your allocation is waiting as an nft. first, ${left.length} trial${left.length === 1 ? '' : 's'} on x. then the mint opens. first one:`,
      events: [{ type: 'task', taskId: left[0].id }],
    }
  }
  if (nft?.eligible) {
    return {
      text: 'the reserve approved you. this is your operator pass as an nft on solana. paste a solana wallet, press mint, and it lands straight in your wallet. the reserve pays the gas.',
      events: [{ type: 'nft' }],
    }
  }
  return {
    text: `not yet. the reserve approves operators in waves, and you are not in this one. finish your trials and keep an eye on @${BRAND.xHandle}.`,
    events: [],
  }
}

/** What signal says once a mint has landed: only the receipt (its button offers the quote task). */
export function nftMintedMessages(mint) {
  return [{
    role: 'agent',
    text: 'minted. your pass is on solana now, stamped approved, in your wallet.',
    events: [{ type: 'minted', id: mint.id, signature: mint.signature ?? null, assetId: mint.assetId ?? null, owner: mint.owner, network: mint.network ?? 'mainnet' }],
  }]
}

/**
 * After a mint trial (params.mint) was just verified: keep the flow on the mint. The next mint trial,
 * or (all done) the mint window. Returns null when this turn did not verify a mint trial.
 */
export function mintTrialFollow(results, state) {
  const tasks = state.tasks ?? []
  const justDone = results.some((r) => r.tool === 'verify_task' && r.result?.ok && !r.result.already && tasks.find((t) => t.id === r.input?.task_id)?.mint)
  if (!justDone) return null
  const left = tasks.filter((t) => t.mint && t.status !== 'done')
  if (left.length) return { line: '', events: [{ type: 'task', taskId: left[0].id }] }
  const nft = state.nft
  if (nft?.eligible && !nft.mint) return { line: 'that was the last one. your nft is ready, mint it:', events: [{ type: 'nft' }] }
  return null
}

/** Pressing "Get +1,000 $SIG" on the receipt: the quote task. */
export function nftQuoteOffer(quote) {
  return {
    text: `+${fmt(quote.reward)} ${U} is yours if you show it off: quote my pinned transmission with your nft, then press "i did it".`,
    events: [{ type: 'task', taskId: quote.id }],
  }
}

/** The closing line: when $SIG launches and how long is left (written at reply time; the card below ticks live). */
export function launchSentence(now = Date.now()) {
  const left = launchLeft(now)
  return left
    ? `that was the last trial. the launch is ${BRAND.launch.label}: ${left} from now. stay on this frequency.`
    : `that was the last trial. ${U} has launched. the only real contract is posted on @${BRAND.xHandle}.`
}

/** The answer to a pasted NFT-quote link. */
export function nftQuoteReply(result, handle) {
  if (result?.ok && result.already) return { text: 'already logged. the reserve pays once.', events: [] }
  if (result?.ok) {
    return {
      // The closing message: this line and the launch countdown, nothing else.
      text: `that is how it is done. +${fmt(result.reward)} ${U}, pending.`,
      events: [{ type: 'launch' }],
    }
  }
  const e = result?.error
  const text = e === 'bad_link' ? `that link is not a post from @${handle}. quote it from your own account.`
    : e === 'post_not_found' ? 'i cannot see that post. make sure it is public, then paste it again in a minute.'
    : e === 'link_reused' ? 'that post already paid for another trial. quote the pinned transmission again, with your nft this time.'
    : e === 'need_nft' ? 'mint your nft first. type /mintallo.'
    : e === 'not_opened' ? 'press "open post → quote" on the card first, then quote it.'
    : e === 'too_early' ? `that was fast. give it ${Math.ceil(result.wait ?? 3)} more seconds and press it again.`
    : 'static on the line. try again in a minute.'
  return { text, events: [] }
}

/** The deal in one breath, then the next trial. No model call: same answer for everyone. */
export function commandReply(text, state) {
  if (!isCommand(text)) return null
  if (MINTALLO.test(String(text ?? '').trim())) return mintCommandReply(state)
  const tasks = state.tasks ?? []
  const next = tasks.find((x) => x.required && x.status !== 'done')
  if (next) {
    const fresh = !tasks.some((x) => x.status === 'done')
    return {
      text: fresh
        ? `uplink open. here is the protocol: i give you trials on x, you do them, i log ${U} to your pending allocation. finish them and you get one shot to talk me into more. first trial:`
        : `you know the protocol: trials on x, ${U} for each. next one:`,
      events: [{ type: 'task', taskId: next.id }],
    }
  }
  if (state.pitch?.unlocked && state.pitch.attempts < state.pitch.max) {
    return { text: 'every trial is done. now the good part: tell me why you deserve more. one message, make it count.', events: [] }
  }
  return {
    text: state.wallet
      ? `you have done all i ask. your ${U} stays pending until the drop. your pass is in the menu.`
      : 'you have done all i ask. leave a solana wallet here so the reserve knows where to send it.',
    events: [],
  }
}
