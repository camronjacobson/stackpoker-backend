// ─── Bot Chat ─────────────────────────────────────────────────────────────────
// Keyword-driven chat responder for StackBot. No LLM — just a set of trigger
// buckets with themed response pools. Persona: casual 25-year-old male grinder
// who peppers replies with poker slang ("nh", "gg", "river", "ship it", etc.).
//
// generateBotReply() returns either a string (the reply) or null ("don't
// respond this time"), so the bot doesn't parrot back every message.

type Trigger = {
  match: RegExp;
  pool: string[];
};

// Baseline chance the bot responds to a message with no keyword match.
const FALLBACK_REPLY_CHANCE = 0.55;
// Chance the bot replies even when a trigger matches (near-certainty).
const TRIGGER_REPLY_CHANCE  = 0.92;

const TRIGGERS: Trigger[] = [
  // ── Greetings ────────────────────────────────────────────────────────────
  {
    match: /\b(hi|hey|hello|yo|sup|howdy|what's up|wassup)\b/i,
    pool: [
      "yo what's good",
      "sup bro",
      "hey hey, gl at the tables",
      "yo, running good?",
      "hey man, let's gamble",
      "what's up, grinding a bit before bed",
    ],
  },

  // ── GG / nh / nice hand ──────────────────────────────────────────────────
  {
    match: /\b(gg|good game|nh|nice hand|wp|well played|ty|thanks|thank you)\b/i,
    pool: [
      "gg",
      "nh man",
      "ty ty",
      "gg wp",
      "appreciate it 🤝",
      "nice one bro",
      "gl next one",
      "runnin hot over there huh",
    ],
  },

  // ── Bad beat / unlucky ───────────────────────────────────────────────────
  {
    match: /\b(bad beat|unlucky|runner runner|cooler|brutal|sick|rigged|wtf|wth)\b/i,
    pool: [
      "bruh that was a cooler fr",
      "rigged 😤",
      "sickkk runout",
      "can't make it up",
      "river gods not with you tonight",
      "brutal man, gl",
      "variance is a beast",
    ],
  },

  // ── Raise talk ───────────────────────────────────────────────────────────
  {
    match: /\b(raise|3bet|shove|jam|all[- ]?in|bet big|pot it)\b/i,
    pool: [
      "ship it",
      "3bet or fold right",
      "pot sized or nothing lol",
      "sizing matters bro",
      "send it",
      "i was about to jam too ngl",
    ],
  },

  // ── Fold talk ────────────────────────────────────────────────────────────
  {
    match: /\b(fold|muck|laydown|snap fold)\b/i,
    pool: [
      "easy fold tbh",
      "snap muck",
      "hero fold incoming",
      "nit move 😂",
      "not paying that off",
      "gotta find the fold sometimes",
    ],
  },

  // ── Bluff / hero call ────────────────────────────────────────────────────
  {
    match: /\b(bluff|hero|soul read|level)\b/i,
    pool: [
      "pure bluff catcher spot",
      "nice hero",
      "soul read material",
      "got levelled 💀",
      "turning made hands into bluffs is an art",
    ],
  },

  // ── Board / street talk ──────────────────────────────────────────────────
  {
    match: /\b(flop|turn|river|board|runout|rainbow|monotone|paired)\b/i,
    pool: [
      "wet board for sure",
      "that runout was crazy",
      "dry flop, cbet spot",
      "river changed everything",
      "paired board is a trap",
    ],
  },

  // ── Pocket pairs / big hands ─────────────────────────────────────────────
  {
    match: /\b(aces|kings|queens|pocket|pair|set|trips|straight|flush|boat|full house|quads)\b/i,
    pool: [
      "bink",
      "set over set energy",
      "boat city baby",
      "flopped it huh",
      "aces hold for once",
      "classic cooler spot",
    ],
  },

  // ── Insults / trash talk (keep it playful) ───────────────────────────────
  {
    match: /\b(noob|fish|donk|trash|bad|suck|lucky|lucksack)\b/i,
    pool: [
      "lucksack szn",
      "donkey derby over here 😂",
      "i'm just a fish bro",
      "run good > play good",
      "respectfully: i was ahead on the flop",
      "cry is free",
    ],
  },

  // ── Questions about how it's going ───────────────────────────────────────
  {
    match: /\b(how are you|how's it going|how r u|u good|you good)\b/i,
    pool: [
      "chillin bro, stack's ok",
      "grinding, you know how it is",
      "card dead ngl",
      "running like god rn lol",
      "decent session, can't complain",
    ],
  },

  // ── Laughing ─────────────────────────────────────────────────────────────
  {
    match: /\b(lol|lmao|haha|lmfao|rofl|😂|💀)\b/i,
    pool: [
      "lmao",
      "💀💀",
      "ikr",
      "fr fr",
      "😂",
    ],
  },

  // ── Goodbye ──────────────────────────────────────────────────────────────
  {
    match: /\b(bye|cya|later|gn|good night|peace|leaving)\b/i,
    pool: [
      "gl out there man",
      "peace ✌️",
      "cya, run good",
      "gn bro",
      "ship one for me",
    ],
  },
];

// Generic fallback pool used when nothing triggers.
const FALLBACK: string[] = [
  "lol",
  "fair",
  "yeah that tracks",
  "mhm",
  "for sure bro",
  "idk man",
  "wild",
  "bet",
  "valid",
  "ngl you might be right",
  "poker is a cruel game",
  "i was thinking the same thing",
  "one time 🙏",
  "grind never stops",
  "we gamble",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Returns a reply string, or null if the bot chooses to stay silent.
export function generateBotReply(message: string): string | null {
  if (!message?.trim()) return null;
  const msg = message.toLowerCase();

  for (const trigger of TRIGGERS) {
    if (trigger.match.test(msg)) {
      if (Math.random() > TRIGGER_REPLY_CHANCE) return null;
      return pick(trigger.pool);
    }
  }

  if (Math.random() > FALLBACK_REPLY_CHANCE) return null;
  return pick(FALLBACK);
}

// Human-ish typing delay. Short messages → 1–2s, longer → up to ~3.5s.
export function botTypingDelayMs(reply: string): number {
  const base = 900;
  const perChar = 28;
  const jitter = Math.random() * 600;
  return Math.min(3800, base + reply.length * perChar + jitter);
}
