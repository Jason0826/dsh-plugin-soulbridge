/**
 * dsh-plugin-soulbridge — DSH adapter for the soulbridge personality layer.
 *
 * Division of labour (ADR 0024): core owns state and wording; this plugin owns
 * timing. It does three things and nothing else:
 *   1. puts core's context text into the system prompt (verb 1)
 *   2. hands every human message to observe() (verb 2)
 *   3. records a heartbeat so "is it working?" is answerable without log spelunking
 *
 * Every failure degrades: the host must never break because this plugin is
 * unhappy. What was injected, observed, or skipped is written to
 * ~/.soulbridge/plugin-state.json.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  openSqlite,
  ensureConfig,
  resolveDbPath,
  Soul,
  detectCorrection,
  renderConsolidationPrompt,
  renderRelationPrompt,
  renderVerificationPrompt,
  parseRelationDraft,
  normalizeStatement,
  parseConclusionDraft,
  parseVerificationDraft,
} from 'soulbridge';

export const name = 'dsh-plugin-soulbridge';
export const inject = ['systemPrompt'];

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const STATE_FILE = join(HOME, 'plugin-state.json');
/**
 * The model's raw replies, complete. Written as JSON strings so newlines stay
 * one line per entry; nothing is cut, because a truncated failure message is
 * what made an earlier diagnosis impossible.
 */
const LLM_RAW_FILE = join(HOME, 'llm-raw.log');

function logLlmRaw(raw) {
  try {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(LLM_RAW_FILE, `${new Date().toISOString()} ${JSON.stringify(String(raw))}\n`);
  } catch (error) {
    log(`llm raw write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Structured trace (brief 0005): one jsonl line per decision, for reconciliation
 * rather than reading. Never contains user text — ids, sizes and usage only.
 *
 * The first consumer is "is the context running away": a 134-turn session
 * degenerated into repeated tokens and the database had no trace of it.
 */
const TRACE_FILE = join(HOME, 'trace.jsonl');
const TRACE_MAX_BYTES = 10 * 1024 * 1024;

function trace(record) {
  if (readConfig().traceEnabled === false) return;
  try {
    mkdirSync(HOME, { recursive: true });
    try {
      if (statSync(TRACE_FILE).size > TRACE_MAX_BYTES) renameSync(TRACE_FILE, `${TRACE_FILE}.1`);
    } catch {
      // No file yet: nothing to rotate.
    }
    appendFileSync(TRACE_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    log(`trace write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Prompt assembly can run several times per step; do not hit SQLite every time. */

/**
 * Optional plugin config: ~/.soulbridge/plugin-config.json
 * { "distill": "rules" | "llm", "provider": "...", "model": "...", "maxLlmChars": 2000 }
 *
 * Rules are the default. With "llm", the host model is asked only when the
 * rules found nothing, so it adds recall without overriding a rule that fired.
 */
const CONFIG_FILE = join(HOME, 'plugin-config.json');
const CONFIG_DEFAULTS = {
  distill: 'rules',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  maxLlmChars: 2000,
  /** off | rules | llm — who writes entities/facts from a finished turn (ADR 0029). */
  extract: 'llm',
  /** Turns of silence that end a topic thread. Lowered temporarily for tests. */
  threadIdleTurns: 6,
  /** Minutes of silence after which another session counts as finished. */
  threadIdleMinutes: 1440,
};

function readConfig() {
  try {
    return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

/** Adapter side of the core LlmFn port: the host model, called inside a turn. */
let currentTurn;
let currentStep;

function makeLlm(ctx, config) {
  if (config.distill !== 'llm') return undefined;
  // Resolve the service on first use: at apply() time the llm plugin may not be
  // registered yet, and the probe showed the call only works inside a turn.
  return async (prompt) => {
    const service = ctx.get('llm');
    if (!service) throw new Error('llm service unavailable');
    // Probe: the same call succeeds and fails minutes apart, and we only ever
    // recorded the outcome. Start/end plus the live turn/step show which window
    // a call actually lands in.
    const started = Date.now();
    log(`llm probe: start turn=${currentTurn ?? '?'} step=${currentStep ?? '?'} chars=${prompt.length}`);
    try {
      const text = await collectText(
        service.stream({
          provider: config.provider,
          model: config.model,
          messages: [
            {
              id: `distill_${Date.now()}`,
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'user' },
            },
          ],
        }),
      );
      log(
        `llm probe: end ok ms=${Date.now() - started} out=${typeof text === 'string' ? text.length : -1}` +
          ` step=${currentStep ?? '?'}`,
      );
      return text;
    } catch (error) {
      log(
        `llm probe: end fail ms=${Date.now() - started} step=${currentStep ?? '?'}` +
          ` err=${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}

/**
 * Collect the stream's text exactly once.
 *
 * The host emits `text-delta` chunks and then a `block-end` carrying the whole
 * block. Concatenating both doubled every reply, which turned valid JSON into
 * two concatenated objects and made every distillation look like `failed`.
 */
export async function collectText(stream) {
  let text = '';
  let sawDelta = false;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      text += chunk.text;
      sawDelta = true;
    } else if (!sawDelta && chunk.type === 'block-end' && chunk.block?.type === 'text') {
      text += chunk.block.text ?? '';
    }
  }
  return text;
}

function log(line) {
  try {
    mkdirSync(HOME, { recursive: true });
    appendFileSync(join(HOME, 'plugin.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break the host.
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  try {
    mkdirSync(HOME, { recursive: true });
    const next = { ...readState(), ...patch, version: VERSION, updatedAt: Date.now() };
    writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch (error) {
    log(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let soul = null;
let soulError = null;
/** Last reply text, so a correction can be stored with what it targets. */
let lastAssistantText;
/** Injected by apply(); the Soul reads them once at construction. */
let injectedLlm;
let injectedMaxLlmChars = 2000;

/** Open the soul once. Throws only the first time; callers degrade to no injection. */
function ensureSoul() {
  if (soul) return soul;
  if (soulError) throw soulError;
  try {
    const config = ensureConfig();
    soul = new Soul({
      store: openSqlite(resolveDbPath()),
      soulId: config.soulId,
      userId: config.userId,
      name: config.name,
      deviceId: config.deviceId,
      llm: injectedLlm,
      llmMaxChars: injectedMaxLlmChars,
      onLlmRaw: logLlmRaw,
    });
    log(`soul ready: db=${resolveDbPath()} soul=${config.soulId} user=${config.userId}`);
    writeState({ appliedAt: readState().appliedAt ?? Date.now(), soulId: config.soulId, userId: config.userId });
    return soul;
  } catch (error) {
    soulError = error instanceof Error ? error : new Error(String(error));
    log(`soul init failed: ${soulError.message}`);
    writeState({ lastError: `soul init failed: ${soulError.message}` });
    throw soulError;
  }
}

/** Last system-prompt text hash, so a changed section is visible in the trace. */
let lastSectionHash = '';

/** FNV-1a: short, dependency-free, good enough to detect change. */
function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Anchors: the few rules that should always be visible. Kept in the system
 * prompt because that section is evaluated before the message arrives, so it
 * cannot rank anything.
 */
const ANCHOR = { types: ['strategy', 'fact', 'trait'], minImportance: 8, maxItems: 3 };
/**
 * Related injections come from `turn_pairs` (RFC 0007): every exchange scored
 * against the current message, with no length or count cap.
 *
 * No cap on purpose. A long emotional exchange is exactly the thing worth
 * remembering, so a character budget would systematically drop the important
 * ones. Context limits are the host's problem (it compacts); ranking quality is
 * ours. If injection grows too large later, sharpen the ranking or distill the
 * pairs — do not go back to cutting length.
 */

/**
 * The system-prompt section: identity and style only.
 *
 * DSH declares `systemPromptUpdate: "in-history"` for this provider, and the
 * loop appends every *changed* prompt as a new system node that keeps counting
 * until compaction. Anchor memories drift with recency, so putting them here
 * would grow the prompt version by version over a long session. Anything that
 * changes per turn goes through the pre-step message instead.
 *
 * Synchronous by necessity: PromptSection.text cannot return a promise.
 */
function buildInjection() {
  try {
    const result = ensureSoul().context({ track: false, includeAnchors: false });
    const text = result.text;
    const hash = hashText(text);
    if (hash !== lastSectionHash) {
      const changed = lastSectionHash !== '';
      lastSectionHash = hash;
      log(`section: ${changed ? 'changed' : 'first'} hash=${hash} chars=${text.length}`);
      trace({ event: 'section', hash, changed, chars: text.length });
    }
    return text;
  } catch (error) {
    log(`section: failed: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function safeKeys(value) {
  if (!value || typeof value !== 'object') return '';
  try {
    return Object.keys(value).slice(0, 12).join(',');
  } catch {
    return '';
  }
}

/** UserMessage.content is a ContentBlock[]; only text blocks are user prose. */
function reasoningOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Block inventory of one assistant message, for measuring what a reply really
 * contains. Types, sizes and tool names only — never the text itself.
 */
export function summarizeBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    const type = typeof block?.type === 'string' ? block.type : '?';
    const entry = { type };
    if (typeof block?.text === 'string') entry.chars = block.text.length;
    if (typeof block?.reasoning === 'string') entry.chars = block.reasoning.length;
    const name = block?.name ?? block?.toolName ?? block?.tool?.name;
    if (typeof name === 'string') entry.name = name;
    if (block?.arguments !== undefined) {
      const raw = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments);
      entry.argsChars = raw.length;
    }
    return entry;
  });
}

/**
 * Exchanges ranked against the current message, for the pre-step injection.
 *
 * Source is `turn_pairs`, not `memories`: one question and one answer is the
 * unit that can answer "what did we talk about last time" (RFC 0007). The
 * system prompt keeps `memories` for now — anchors become the picture in MVP2.
 *
 * `used` carries the pair ids so an injection can be reviewed afterwards.
 * Every related pair is injected, whatever its length.
 */
/**
 * The cheapest possible memory: one line per fact, with the id needed to expand.
 *
 * Injection should not replay whole conversations — that decides for the model
 * what is worth reading. It should say "this happened", and leave the detail
 * behind `soul_detail`. When the current message names someone we know, we send
 * that person's timeline ends: the earliest fact (how it started) and the most
 * recent ones (where it stands).
 */
const LATIN_NAME = /[a-z0-9]/i;

/**
 * Does this message name the entity?
 *
 * A plain `includes` is wrong for short Latin names: an entity called "a" would
 * match "chat", "data" and every English word. Latin names need boundaries; CJK
 * names of two or more characters are matched as substrings, and a one-character
 * CJK name is skipped rather than guessed.
 */
export function mentions(text, entity) {
  const names = [entity?.name, ...(Array.isArray(entity?.aliases) ? entity.aliases : [])].filter(Boolean);
  for (const name of names) {
    if (LATIN_NAME.test(name)) {
      const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)) return true;
      continue;
    }
    if (name.length >= 2 && text.includes(name)) return true;
  }
  return false;
}

export function buildFactHooks(text, options = {}) {
  const parts = [];
  const used = [];
  try {
    const known = ensureSoul().findEntities('', 50);
    // The entity timeline already covers the subject of an entity question;
    // injecting both produced two copies of the same facts in one prompt.
    const skip = new Set(options.skip ?? []);
    const mentioned = known.filter((entity) => mentions(text, entity) && !skip.has(entity.name));
    for (const entity of mentioned.slice(0, 3)) {
      const earliest = ensureSoul().factsAbout(entity.id, { order: 'asc', limit: 1 });
      const recent = ensureSoul().factsAbout(entity.id, { limit: 4 });
      const seen = new Set();
      const lines = [];
      for (const fact of [...earliest, ...recent]) {
        if (seen.has(fact.id)) continue;
        seen.add(fact.id);
        const when = fact.atText ?? (fact.at ? new Date(fact.at).toISOString().slice(0, 10) : '');
        lines.push(`- [${fact.id}] ${fact.statement}${when ? `（${when}）` : ''}`);
        used.push(fact.id);
      }
      if (lines.length > 0) {
        parts.push(`<about name="${entity.name}">\n${lines.join('\n')}\n</about>`);
      }
    }
  } catch (error) {
    log(`prestep: hooks failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parts.length === 0) return '';
  return { text: parts.join('\n\n'), used };
}

/**
 * Which injection blocks a plan allows.
 *
 * When the question names a subject, the entity timeline is the answer and the
 * related-pairs search is the contamination: it is how "上次和 a 吃饭" ends up
 * answered with something about b. So the plan chooses one or the other.
 */
export function planBlocks(plan) {
  if (!plan) return { related: true, timeline: false };
  if (plan.primitive === 'entity') return { related: false, timeline: true };
  return { related: true, timeline: false };
}

function buildRelatedContext(text) {
  const parts = [];
  const used = [];
  // The plan is computed first because it decides which blocks are allowed.
  let plan = null;
  try {
    plan = ensureSoul().planRetrieval(text);
    log(`router: ${plan.primitive}${plan.subject ? `(${plan.subject})` : ''} — ${plan.reason}`);
    trace({ event: 'router', primitive: plan.primitive, subject: plan.subject ?? null, reason: plan.reason });
  } catch (error) {
    log(`router failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const policy = planBlocks(plan);
  try {
    // Anchors moved here from the system prompt: a message is counted once and
    // compacted normally, while a changed prompt becomes a new prompt version.
    const anchors = ensureSoul().context({
      track: false,
      includeSoul: false,
      includeStyle: false,
      ...ANCHOR,
    });
    if (anchors.text.trim()) {
      parts.push(anchors.text.trim());
      used.push(...anchors.used);
    }
  } catch (error) {
    log(`prestep: anchors failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hooks = buildFactHooks(text, { skip: policy.timeline && plan?.subject ? [plan.subject] : [] });
  if (hooks && hooks.text) {
    parts.push(hooks.text);
    used.push(...hooks.used);
  }
  if (policy.timeline && plan?.subject) {
    try {
      // The question, not just the subject: an entity with many facts must return
      // the ones this question is about, not its three most recent.
      const timeline = ensureSoul().latestAbout(plan.subject, { query: text, limit: 3 });
      if (timeline.length > 0) {
        const body = timeline
          .map((fact) => `- [${fact.id}] ${fact.atText ? `${fact.atText} ` : ''}${fact.statement}`)
          .join('\n');
        parts.push(`<about-now name="${plan.subject}">\n${body}\n</about-now>`);
        used.push(...timeline.map((fact) => fact.id));
      } else {
        // Saying "nothing" explicitly is better than letting a relevance search
        // fill the gap with somebody else's memories.
        parts.push(`<about-now name="${plan.subject}">（没有任何关于它的记忆）</about-now>`);
      }
    } catch (error) {
      log(`timeline failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (policy.related) {
    const pairs = ensureSoul().recallTurnPairs(text);
    if (pairs.length > 0) {
      const body = pairs.map((pair) => `- [Q] ${pair.userText}\n  [A] ${pair.assistantText}`).join('\n');
      parts.push(`<related>\n${body}\n</related>`);
      used.push(...pairs.map((pair) => pair.id));
    }
  }
  if (parts.length === 0) return '';
  // Retrieval practice: a fact that keeps being surfaced decays more slowly.
  try {
    ensureSoul().recordRecalls([...new Set(used)].filter((id) => String(id).startsWith('fc_')));
  } catch (error) {
    log(`recordRecalls failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { text: parts.join('\n\n'), used };
}

/**
 * Build the agent/pre-step middleware (RFC 0006).
 *
 * Idempotence is by construction, not cleanup: one injection per (session,
 * turn), and the injected message carries a source kind the observer ignores —
 * the probe showed that using `user` there fed injected text back into memory.
 *
 * @param deps.getContext - returns the memory block for one message, or ''.
 */
/**
 * The "where were we" block for a new session, or '' when there is nothing to
 * hand over. Pure: the caller decides when, this decides what.
 */
export function renderHandoff(last, sessionId) {
  if (!last || last.thread.sessionId === sessionId) return '';
  const when = new Date(last.thread.closedAt ?? Date.now()).toISOString().slice(0, 10);
  const lines = [`<handoff topic="${last.thread.topic.slice(0, 30)}" closed="${when}">`];
  if (last.conclusion) lines.push(`  上次的结论：${last.conclusion.statement}`);
  for (const turn of last.turns) {
    lines.push(`  ${turn.turnNo}. 用户：${turn.userText.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  lines.push('</handoff>');
  return lines.join('\n');
}

/**
 * The sessions the user has archived in the workspace.
 *
 * `workspaceRegistry` is a Cordis service on the host context; archive is its
 * durable set, not an event, so it is read at each turn. Absent service means an
 * older or different host — the caller then falls back to the inactivity rule.
 */
function readArchivedSessions(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
    const ids = registry?.archivedSessionIds;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch (error) {
    log(`archive list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
export function createPreStepHandler(deps) {
  /** sessionId -> last turn that received an injection */
  const injectedTurn = new Map();
  /** Sessions that already got the handoff block once. */
  const handedOff = new Set();

  /**
   * The "where were we" block: the last topic that finished.
   *
   * Deliberately once per session and only when that topic belongs to a
   * different session — repeating it every turn would make it wallpaper, and
   * re-reading the previous session's own topic is not a handoff.
   */
  function takeHandoff(sessionId) {
    if (handedOff.has(sessionId)) return '';
    handedOff.add(sessionId);
    try {
      const last = ensureSoul().lastClosedThread();
      const block = renderHandoff(last, sessionId);
      if (block) {
        log(`handoff: "${last.thread.topic}" summary=${last.conclusion ? 'yes' : 'no'}`);
        trace({
          event: 'handoff',
          thread: last.thread.id,
          theme: last.thread.topic,
          hasSummary: Boolean(last.conclusion),
        });
      }
      return block;
    } catch (error) {
      log(`handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  return async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter') return decision;
      // We are inside a live turn now, which is the only place the host model is
      // callable. Extraction first, consolidation only if extraction had nothing:
      // one model call per step keeps every call inside that window.
      void (async () => {
        try {
          const extracted = await drainExtractionQueue();
          if (!extracted) await runConsolidationStep();
        } catch (error) {
          log(`background: ${error instanceof Error ? error.message : String(error)}`);
        }
      })();
      // Control switch for the A/B test: plugin-config.json { "injectEnabled": false }
      if (readConfig().injectEnabled === false) {
        log('prestep: inject disabled by config');
        return decision;
      }
      // Topics the conversation has moved past, closed once per turn. Counting
      // actual turns — the host's turn numbers jump by 10–30 per exchange, so a
      // numeric difference closed a topic one message after it opened.
      const sessionId = payload?.agent?.id ?? payload?.agent?.session?.id ?? 'default';
      try {
        const closeConfig = readConfig();
        const closed = ensureSoul().closeIdleThreads(sessionId, {
          idleTurns: closeConfig.threadIdleTurns ?? 6,
          idleMs: (closeConfig.threadIdleMinutes ?? 30) * 60_000,
          // The host's own archive list: a session the user put away is finished
          // by declaration, so its topics close immediately.
          archivedSessionIds: deps.archivedSessions?.() ?? [],
          at: Date.now(),
        });
        if (closed.length > 0) {
          // The reason is logged because a threshold that fires too early must be
          // visible: a topic closed by a guess is a partial conclusion written to
          // durable memory.
          log(`threads closed: ${closed.map((thread) => `${thread.id}(${thread.reason})`).join(',')}`);
          trace({ event: 'threads-closed', closed });
          // A closed thread is the unit consolidation runs on — never a batch of
          // facts, which can mix two topics into one conclusion.
          enqueueConsolidation(closed.map((thread) => thread.id));
        }
      } catch (error) {
        log(`threads close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const text = textOf(messages[messages.length - 1]?.content);
      if (text.length === 0) return decision;

      const turn = payload?.turn;
      if (injectedTurn.get(sessionId) === turn) return decision;

      const ctx = deps.getContext(text);
      const related = typeof ctx === 'string' ? ctx : (ctx?.text ?? '');
      const used = typeof ctx === 'string' ? [] : (ctx?.used ?? []);
      // "Where were we" is answered by the last topic that finished, not by the
      // previous session: one session can hold several topics, and a topic can
      // span sessions. Injected once per session, when it is a different one.
      const handoff = takeHandoff(sessionId);
      const block = [handoff, related].filter(Boolean).join('\n\n');
      injectedTurn.set(sessionId, turn);
      if (injectedTurn.size > 16) {
        // Keep the map bounded: drop the oldest entry, not the newest.
        const oldest = injectedTurn.keys().next().value;
        if (oldest !== undefined) injectedTurn.delete(oldest);
      }
      if (!block) {
        log(`prestep: no related memory (turn=${turn})`);
        return decision;
      }

      const note = {
        id: `memctx_${turn}`,
        role: 'user',
        content: [{ type: 'text', text: block }],
        source: { kind: 'memory-context' },
      };
      const idPart = used.length > 0 ? ` ids=[${used.join(',')}]` : '';
      log(`prestep: inject turn=${turn} chars=${block.length}${idPart} handoff=${handoff ? 'yes' : 'no'}`);
      trace({ event: 'inject', session: sessionId, turn, chars: block.length, ids: used, handoff: Boolean(handoff) });
      return { ...decision, messages: [...decision.messages, note] };
    } catch (error) {
      log(`prestep: skipped after error: ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  };
}

/* ------------------------------------------------------------------ *
 * Turn pairs (RFC 0007): one exchange is the unit of memory.
 * ------------------------------------------------------------------ */

/** Exchanges awaiting their reply to finish: sessionId -> { turn, userText, at, assistantParts }. */
const pendingTurns = new Map();

/**
 * The turn boundary is an event, not a silence.
 *
 * This used to write a turn after two seconds without a new assistant message.
 * That looked harmless until the data said otherwise: a tool call often runs
 * longer than two seconds, so the timer fired mid-turn, wrote a truncated pair
 * and dropped everything after it. One recorded write landed 1m47s before the
 * same turn's `turn/end`.
 *
 * Now the only triggers are `turn/end` and the next user message. If the app is
 * killed mid-turn, that turn is lost — a missing turn is better than a turn cut
 * in half, and the loss is visible (the next turn's text starts mid-story).
 */
function noteUserTurn(sessionId, event, text) {
  pendingTurns.set(sessionId, {
    turn: Number(event?.data?.turn ?? event?.seq ?? 0),
    userText: text,
    at: Number(event?.time ?? Date.now()),
    assistantParts: [],
  });
}

function noteAssistantPart(sessionId, text) {
  const pending = pendingTurns.get(sessionId);
  if (!pending) return;
  pending.assistantParts.push(text);
}

/** One step of the reply, kept in order: reasoning, text, tool. */
function noteAssistantStep(sessionId, kind, text) {
  const pending = pendingTurns.get(sessionId);
  if (!pending) return;
  if (!pending.steps) pending.steps = [];
  pending.steps.push({ idx: pending.steps.length, kind, text, at: Date.now() });
}

/**
 * Write the pending exchange. Called on `turn/end` and, as a fallback, when the
 * next user message arrives. No assistant text means the turn never completed —
 * drop it rather than write a pair with an empty side (RFC 0007 §2.2).
 */
function flushTurnPair(sessionId) {
  const pending = pendingTurns.get(sessionId);
  if (!pending) return;
  pendingTurns.delete(sessionId);
  if (pending.assistantParts.length === 0) {
    log(`turn pair dropped (no reply) session=${sessionId} turn=${pending.turn}`);
    return;
  }
  try {
    const turnId = ensureSoul().recordTurnPair({
      sessionId,
      turn: pending.turn,
      userText: pending.userText,
      assistantText: pending.assistantParts.join('\n'),
      at: pending.at,
      steps: pending.steps ?? [],
    });
    const chars = pending.userText.length + pending.assistantParts.join('').length;
    log(`turn pair recorded session=${sessionId} turn=${pending.turn} chars=${chars}`);
    // Extraction is queued, not run here: outside a live turn the host model is
    // not callable (every attempt returned an empty stream today). The queue is
    // drained at the start of the next turn, which is inside one.
    enqueueExtraction(turnId, pending.turn);
  } catch (error) {
    log(`turn pair failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * Extraction queue: written at turn end, drained inside the next turn
 * ------------------------------------------------------------------ */

const EXTRACT_QUEUE_FILE = join(HOME, 'pending-extract.json');
const EXTRACT_MAX_ATTEMPTS = 3;

function readExtractQueue() {
  try {
    const raw = JSON.parse(readFileSync(EXTRACT_QUEUE_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeExtractQueue(queue) {
  try {
    writeFileSync(EXTRACT_QUEUE_FILE, JSON.stringify(queue.slice(0, 50), null, 2), 'utf8');
  } catch (error) {
    log(`extract queue write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function enqueueExtraction(turnId, turnNo) {
  const queue = readExtractQueue();
  if (queue.some((item) => item.turnId === turnId)) return;
  queue.push({ turnId, turnNo, attempts: 0 });
  writeExtractQueue(queue);
  log(`extract queued turn=${turnNo} pending=${queue.length}`);
}

/**
 * Does this message carry anything worth extracting?
 *
 * Length alone is the wrong test: "做" and "重来" are one and two characters and
 * are real decisions. Only pure acknowledgements are skipped, and a skip is
 * always logged — a silent skip is how the pipeline looked dead for an hour.
 */
function hasSubstance(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return !/^(好的?|嗯+|哦+|可以|行|ok|okay|收到|明白|继续|好)[。！!.\s]*$/i.test(trimmed);
}

async function runExtraction(text, turnId, turnNo) {
  const config = readConfig();
  if (config.extract === 'off') return 'skipped-off';
  if (typeof text !== 'string' || !hasSubstance(text)) {
    log(`extract skipped: no substance (chars=${typeof text === 'string' ? text.length : -1}) turn=${turnNo}`);
    return 'skipped-empty';
  }
  const started = Date.now();
  try {
    const useLlm = config.extract === 'llm' && Boolean(injectedLlm);
    const soul = ensureSoul();
    const turnRow = soul.turn(turnId);
    const context = soul.extractionContext(20, { turnNo });
    // "The previous turn belonged to this thread" is the cheapest continuity hint
    // there is: in most cases the answer is simply "the same one again".
    if (turnRow) {
      const previousThreadId = soul.threadBefore(turnRow.sessionId, turnNo);
      if (previousThreadId) context.previousThreadId = previousThreadId;
    }
    const draft = await soul.extract(text, {
      llm: useLlm ? injectedLlm : undefined,
      mode: useLlm ? 'auto' : 'rules',
      // The extractor needs the open threads so it can say which one this turn
      // continues, and how long ago each was last seen.
      context,
    });
    const result = soul.commitDrafts(draft, { turnId });
    // Attribution is written even when nothing was extracted: a turn that says
    // "无" (nothing worth remembering) can still be part of a thread.
    const attribution = soul.applyThread(draft.thread, {
      sessionId: turnRow?.sessionId ?? 'unknown',
      turnNo,
      turnId,
      at: Date.now(),
      fallbackTopic: text.slice(0, 20),
    });
    const ms = Date.now() - started;
    log(
      `extract ok: by=${draft.by} reason=${draft.reason ?? '-'} entities=${result.entities.length} facts=${result.facts.length}` +
        ` gaps=${result.gaps.length} skipped=${result.skipped.length} ms=${ms} turn=${turnNo}` +
        ` thread=${attribution.threadId}${attribution.created ? '(new)' : ''}`,
    );
    for (const skipped of result.skipped.slice(0, 3)) {
      log(`  extract skipped: ${skipped.what} (${skipped.reason})`);
    }
    trace({
      event: 'extract',
      turn: turnNo,
      by: draft.by,
      reason: draft.reason,
      entities: result.entities.length,
      facts: result.facts.length,
      gaps: result.gaps.length,
      skipped: result.skipped,
      thread: attribution.threadId,
      threadCreated: attribution.created,
      threadTopic: attribution.topic,
      ms,
    });
    // Rules mode is a deliberate configuration, not a failed model call.
    if (!useLlm) return 'rules-mode';
    return draft.by === 'llm' ? 'ok' : `rules:${draft.reason ?? 'unknown'}`;
  } catch (error) {
    log(`extract failed: ${error instanceof Error ? error.message : String(error)}`);
    return `failed:${error instanceof Error ? error.message : String(error)}`;
  }
}

let draining = false;

/**
 * Drain the extraction queue inside a live turn.
 *
 * The host model is only callable while a turn is running, so the queue exists:
 * turns are written at the end of one and extracted at the start of the next.
 * A failure keeps the item for a retry; three failures drop it with the reason.
 */
/**
 * Drain ONE queued turn per step.
 *
 * The host model is only callable inside the current step: of three serial
 * calls in one drain, the middle one succeeded and the other two failed with the
 * stream gone. One item per step keeps every attempt inside that window; the
 * queue is a backlog, not a batch.
 *
 * A model failure keeps the item, because the rules pass is only a floor: if it
 * counted as done, that turn would never get a model extraction. Three failures
 * drop it with the reason.
 */
export async function drainExtractionQueue() {
  if (draining) return;
  const config = readConfig();
  if (config.extract === 'off') return;
  const queue = readExtractQueue();
  if (queue.length === 0) return;
  draining = true;
  try {
    const [item, ...rest] = queue;
    let text = '';
    try {
      const turn = ensureSoul().turn(item.turnId);
      text = turn?.userText ?? '';
    } catch {
      text = '';
    }
    if (!text) {
      log(`extract queue: turn ${item.turnId} missing, dropped`);
      writeExtractQueue(rest);
      return;
    }

    const outcome = await runExtraction(text, item.turnId, item.turnNo);
    const ok =
      outcome === 'ok' || outcome === 'skipped-off' || outcome === 'skipped-empty' || outcome === 'rules-mode';
    if (ok) {
      writeExtractQueue(rest);
      trace({ event: 'extract-queue', drained: 1, remaining: rest.length, outcome });
      return true;
    }

    // A rules result caused by a broken model call is not a completed extraction.
    const attempts = (item.attempts ?? 0) + 1;
    if (attempts >= EXTRACT_MAX_ATTEMPTS) {
      log(`extract queue: giving up on turn=${item.turnNo} after ${attempts}: ${outcome}`);
      writeExtractQueue(rest);
      return true;
    }
    log(`extract queue: retry turn=${item.turnNo} attempt=${attempts} (${outcome})`);
    writeExtractQueue([{ ...item, attempts }, ...rest]);
    trace({ event: 'extract-queue', drained: 1, remaining: rest.length + 1, outcome, retry: true });
    return true;
  } finally {
    draining = false;
  }
}

/* ------------------------------------------------------------------ *
 * Consolidation: observations → one conclusion, checked before it lands
 * ------------------------------------------------------------------ */

const CONSOLIDATION_FILE = join(HOME, 'consolidation.json');
/** Closed threads waiting to be consolidated, oldest first. */
const CONSOLIDATION_QUEUE_FILE = join(HOME, 'pending-threads.json');
const CONSOLIDATION_MAX_FACTS = 8;

function readConsolidationState() {
  try {
    const raw = JSON.parse(readFileSync(CONSOLIDATION_FILE, 'utf8'));
    return { pending: raw?.pending ?? null };
  } catch {
    return { pending: null };
  }
}

function readConsolidationQueue() {
  try {
    const raw = JSON.parse(readFileSync(CONSOLIDATION_QUEUE_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeConsolidationQueue(queue) {
  try {
    writeFileSync(CONSOLIDATION_QUEUE_FILE, JSON.stringify(queue.slice(0, 50), null, 2), 'utf8');
  } catch (error) {
    log(`consolidate queue write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function enqueueConsolidation(threadIds) {
  if (!Array.isArray(threadIds) || threadIds.length === 0) return;
  const queue = readConsolidationQueue();
  for (const id of threadIds) if (!queue.includes(id)) queue.push(id);
  writeConsolidationQueue(queue);
  log(`consolidate queued: ${threadIds.join(',')} pending=${queue.length}`);
}

function shiftConsolidationQueue() {
  const queue = readConsolidationQueue();
  if (queue.length === 0) return null;
  const [first, ...rest] = queue;
  writeConsolidationQueue(rest);
  return first;
}

function writeConsolidationState(state) {
  try {
    writeFileSync(CONSOLIDATION_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    log(`consolidate: state write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write (or merge) the conclusion and close the thread with it.
 *
 * Merging never rewrites the held statement — the evidence is what grows, so the
 * merge stays auditable. Refine and conflict still write a new row and supersede
 * the old one, which keeps the chain of revisions.
 */
function finishConclusion(soul, draft, { threadId, batch, relation }) {
  const allowed = batch.map((fact) => fact.id);
  let result;
  if (relation.kind === 'duplicate' && relation.target) {
    result = soul.recordConclusion(draft, { allowed, mergeInto: relation.target });
  } else {
    const effective =
      (relation.kind === 'refine' || relation.kind === 'conflict') && relation.target
        ? { ...draft, supersedes: relation.target }
        : draft;
    result = soul.recordConclusion(effective, { allowed });
  }
  const summaryId = result.merged ?? result.fact?.id;
  // The conclusion becomes the thread's summary; a closed thread with no summary
  // is still closed, it just has nothing to remember it by.
  if (result.ok && threadId && summaryId) soul.store.closeThread(threadId, Date.now(), summaryId);
  log(
    `consolidate ok: thread=${threadId ?? '-'} relation=${relation.kind} "${draft.statement}" ` +
      `evidence=${draft.evidence.length} written=${Boolean(result.fact)} merged=${result.merged ?? '-'} ` +
      `superseded=${result.superseded ?? '-'}`,
  );
  trace({
    event: 'consolidate',
    verdict: 'supported',
    ok: result.ok,
    reason: result.reason,
    relation: relation.kind,
    target: relation.target ?? null,
    statement: draft.statement,
    thread: threadId,
  });
  writeConsolidationState({ pending: null });
}

/**
 * One consolidation step per call, never two model calls in one step.
 *
 * Consolidation runs on a **closed thread**, not on a batch of facts: a
 * conversation still in progress is not a chapter yet, and a batch can mix two
 * unrelated topics into one conclusion.
 *
 * The two phases are split across steps on purpose: the verifier must answer
 * without the draft's reasoning in view (Chain-of-Verification), and a second
 * call in the same step would run past the window where the host model is
 * callable anyway.
 *
 * Returns true when a model call was made, so the caller can skip other work.
 */
async function runConsolidationStep() {
  const config = readConfig();
  if (config.extract === 'off' || !injectedLlm) return false;
  const soul = ensureSoul();
  const state = readConsolidationState();

  if (state.pending?.phase === 'verify') {
    const { draft, batch, threadId } = state.pending;
    const raw = await injectedLlm(renderVerificationPrompt({ conclusion: draft.statement, facts: batch }));
    const verdict = parseVerificationDraft(raw) ?? { verdict: 'unsupported', reason: 'unparseable verdict' };
    if (verdict.verdict === 'supported') {
      // Supported, but not yet written: first ask whether we already hold it.
      // The check runs in its own step so this step keeps to one model call.
      const candidates = soul.conclusionCandidates(draft.evidence, 8);
      if (candidates.length > 0) {
        writeConsolidationState({ pending: { phase: 'dedupe', draft, batch, threadId, candidates } });
        log(`consolidate verify ok: thread=${threadId ?? '-'} — checking ${candidates.length} held conclusions`);
        return true;
      }
      finishConclusion(soul, draft, { threadId, batch, relation: { kind: 'unrelated' } });
    } else {
      // Partial support is dropped, not downgraded: a half-true conclusion is a
      // wrong one, and the sample is what teaches the prompt next time.
      log(`consolidate dropped: ${verdict.verdict} — "${draft.statement}" (${verdict.reason ?? '-'})`);
      trace({
        event: 'consolidate',
        verdict: verdict.verdict,
        dropped: true,
        reason: verdict.reason,
        statement: draft.statement,
        thread: threadId,
      });
    }
    writeConsolidationState({ pending: null });
    return true;
  }

  if (state.pending?.phase === 'dedupe') {
    const { draft, batch, threadId, candidates } = state.pending;
    // The one check a rule can make safely: the same text. A hit cannot be wrong,
    // and it costs nothing.
    const exact = candidates.find(
      (candidate) => normalizeStatement(candidate.statement) === normalizeStatement(draft.statement),
    );
    if (exact) {
      log(`dedupe: exact duplicate of ${exact.id} — merging evidence, not writing`);
      finishConclusion(soul, draft, { threadId, batch, relation: { kind: 'duplicate', target: exact.id } });
      return true;
    }
    const raw = await injectedLlm(renderRelationPrompt({ conclusion: draft.statement, existing: candidates }));
    const parsed = parseRelationDraft(raw);
    // An id we did not offer is a hallucination; treating it as unrelated only
    // ever writes the new conclusion, never deletes one.
    const known = parsed?.target && candidates.some((candidate) => candidate.id === parsed.target);
    const relation =
      parsed && (parsed.kind === 'unrelated' || known) ? parsed : { kind: 'unrelated', reason: 'unknown target' };
    log(`dedupe: ${relation.kind}${relation.target ? ` → ${relation.target}` : ''} "${draft.statement}"`);
    trace({ event: 'dedupe', relation: relation.kind, target: relation.target ?? null, reason: relation.reason });
    finishConclusion(soul, draft, { threadId, batch, relation });
    return true;
  }

  const threadId = shiftConsolidationQueue();
  if (!threadId) return false;
  const context = soul.threadContext(threadId);
  if (!context) {
    log(`consolidate: thread ${threadId} missing, skipped`);
    return true;
  }
  // Two citations are the floor for a conclusion; a thread with fewer facts is
  // recorded as "not yet", not forced into a judgement.
  if (context.facts.length < 2) {
    log(`consolidate skipped: thread ${threadId} has ${context.facts.length} fact(s)`);
    trace({ event: 'consolidate', verdict: 'too-few-facts', thread: threadId, facts: context.facts.length });
    return true;
  }

  const batch = context.facts.slice(0, CONSOLIDATION_MAX_FACTS).map((fact) => ({
    id: fact.id,
    statement: fact.statement,
    atText: fact.atText,
  }));
  const raw = await injectedLlm(
    renderConsolidationPrompt({
      facts: batch,
      existing: soul.conclusions(5).map((fact) => ({ id: fact.id, statement: fact.statement })),
      thread: {
        topic: context.thread.topic,
        turns: context.turns.map((turn) => {
          const answer = turn.assistantText.replace(/\s+/g, ' ').slice(0, 120);
          return `用户：${turn.userText.slice(0, 160)}${answer ? ` / 我：${answer}` : ''}`;
        }),
      },
    }),
  );
  const draft = parseConclusionDraft(raw);
  if (!draft) {
    log(`consolidate: nothing to conclude from thread ${threadId} (${batch.length} facts)`);
    trace({ event: 'consolidate', verdict: 'none', thread: threadId, batch: batch.length });
    writeConsolidationState({ pending: null });
    return true;
  }
  log(`consolidate draft: thread=${threadId} "${draft.statement}" evidence=${draft.evidence.join(',')} — verifying next step`);
  trace({ event: 'consolidate', verdict: 'draft', statement: draft.statement, evidence: draft.evidence, thread: threadId });
  writeConsolidationState({ pending: { phase: 'verify', draft, batch, threadId } });
  return true;
}

/**
 * One-shot backfill: enqueue the last few completed turns so they go through the
 * same path as new ones. Marker file keeps a restart from re-billing old turns.
 */
async function backfillExtraction() {
  const marker = join(HOME, '.extract-backfill-done');
  if (existsSync(marker)) return;
  const config = readConfig();
  if (config.extract === 'off') return;
  try {
    const recent = ensureSoul().recallTurnPairs('', 5);
    log(`extract backfill: queued ${recent.length} turns`);
    for (const turn of recent) {
      enqueueExtraction(turn.id, turn.turn);
    }
    writeFileSync(marker, new Date().toISOString());
  } catch (error) {
    log(`extract backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function observeText(text) {
  const started = Date.now();
  try {
    const result = await ensureSoul().observe({ role: 'user', content: text });
    const affect = result?.affect ?? {};
    const state = readState();
    writeState({
      observes: (state.observes ?? 0) + 1,
      lastObserveAt: started,
      lastObservedChars: text.length,
      lastWritten: result?.written ?? 0,
      lastAffect: affect.dominant ?? null,
    });
    log(
      `observe ok: chars=${text.length} written=${result?.written ?? '?'} committed=${result?.committed ?? '?'} by=${result?.extractedBy ?? '?'} llm=${result?.llmOutcome ?? '?'}` +
        ` affect=${affect.dominant ?? 'none'} confidence=${affect.confidence ?? '?'} ms=${Date.now() - started}`,
    );
    // A new observation may change the anchors inside the next pre-step block.
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = readState();
    writeState({ observeFails: (state.observeFails ?? 0) + 1, lastError: `observe failed: ${message}` });
    log(`observe failed: ${message}`);
  }
}

/** Tool output must match the declared schema; text blocks keep it readable. */
function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

function recallTool() {
  return {
    name: 'soul_recall',
    description:
      '按关键词从长期记忆里召回相关条目。当用户提到过去说过的话、偏好、约定，' +
      '或你不确定某事是否记过时使用。返回按相关性排序的条目。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，通常是用户当前问题里的主题词' },
        limit: { type: 'number', description: '返回条数，默认 5，上限 20' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                content: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['id', 'type', 'content', 'score'],
            },
          },
          reason: { type: 'string' },
        },
        required: ['ok', 'count', 'memories'],
      },
      render: textRender,
    },
    async execute(args) {
      try {
        const query = String(args?.query ?? '').trim();
        if (query.length === 0) return { ok: false, count: 0, memories: [], reason: 'empty query' };
        const limit = Math.min(20, Math.max(1, Number(args?.limit ?? 5)));
        const hits = ensureSoul().recall(query, limit);
        log(`tool soul_recall: chars=${query.length} hits=${hits.length}`);
        return {
          ok: true,
          count: hits.length,
          memories: hits.map((hit) => ({
            id: hit.memory.id,
            type: hit.memory.type,
            content: hit.memory.content,
            score: Number(hit.score.toFixed(3)),
          })),
        };
      } catch (error) {
        return { ok: false, count: 0, memories: [], reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function rememberTool() {
  return {
    name: 'soul_remember',
    description:
      '把一件值得长期记住的事写进记忆。只在用户明确要求记住、或确认这是一条长期约定/偏好时使用；' +
      '不要用它记录一次性的临时信息。content 必须写用户的原话（可精简，不可改写含义），' +
      '不要写"这是用户要求记住的一条内容"这类元描述；系统已经自动记录过的内容不要去重写。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '用户的原话（可精简），不超过 200 字' },
        type: {
          type: 'string',
          enum: ['strategy', 'fact', 'trait', 'cognition'],
          description: 'strategy=规则/做法，fact=事实，trait=偏好，cognition=原则',
        },
        importance: { type: 'number', description: '1-10，默认 7' },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          duplicate: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      render: textRender,
    },
    async execute(args) {
      try {
        const content = String(args?.content ?? '').trim();
        if (!content) return { ok: false, reason: 'empty content' };
        const type = typeof args?.type === 'string' ? args.type : 'strategy';
        const importance = args?.importance === undefined ? 7 : Number(args.importance);
        // Explicit memories are lessons in the two-layer model (ADR 0032): a fact
        // held by the soul itself, not a row in the retired memories table.
        const mapped = type === 'cognition' ? '原则' : type === 'trait' ? '性格' : type === 'fact' ? '事实' : '教训';
        const soul = ensureSoul();
        const duplicate = soul.recentFacts(500).find((fact) => fact.statement === content && fact.status !== 'superseded');
        if (duplicate) return { ok: true, id: duplicate.id, duplicate: true };
        const fact = soul.recordFact({
          statement: content,
          typeName: mapped,
          holder: 'self',
          source: 'told',
          confidence: Math.min(1, Math.max(0, (Number.isFinite(importance) ? importance : 7) / 10)),
        });
        log(`tool soul_remember: ok=true type=${mapped} id=${fact.id}`);
        return { ok: true, id: fact.id };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function detailTool() {
  return {
    name: 'soul_detail',
    description:
      '按事实 id 取回当时的完整对话。注入里每条记忆是形如 [fc_xxx] 的一句话；' +
      '只有需要原话、细节或上下文时才调用它——先看一句话就能回答的问题，不要调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '事实 id，例如 fc_ab12' },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          statement: { type: 'string' },
          at: { type: 'number' },
          atText: { type: 'string' },
          userText: { type: 'string' },
          assistantText: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['ok'],
      },
      render: textRender,
    },
    async execute(args) {
      try {
        const id = String(args?.id ?? '').trim();
        const detail = ensureSoul().factDetail(id);
        if (!detail) {
          log(`tool soul_detail: miss ${id}`);
          return { ok: false, reason: `no fact ${id}` };
        }
        log(`tool soul_detail: ${id} turn=${detail.turn ? 'yes' : 'no'}`);
        return {
          ok: true,
          statement: detail.fact.statement,
          at: detail.fact.at,
          atText: detail.fact.atText,
          userText: detail.turn?.userText,
          assistantText: detail.turn?.assistantText,
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/**
 * Is this plugin on the profile's bundle list?
 *
 * A plugin is loaded only because its package is listed in `dsh.profile.bundles`.
 * Desktop's fatal-error recovery (sanitizeProfile) renames cordis.patch.yml and
 * restores a caller-given bundle list, which silently dropped this bundle once:
 * the app stayed up, the plugin simply was not there, and the logs just stopped.
 *
 * The profile directory is derived from this module's own location
 * (<profile>/node_modules/dsh-plugin-soulbridge/index.js), so it cannot drift
 * from where the running copy actually is.
 */
export function checkBundle(manifest, name = 'dsh-plugin-soulbridge') {
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { ok: false, reason: 'no dsh.profile.bundles list', bundles: [] };
  return { ok: bundles.includes(name), reason: bundles.includes(name) ? 'present' : 'missing', bundles };
}

function selfCheck() {
  try {
    const pluginDir = fileURLToPath(new URL('.', import.meta.url));
    const profileDir = resolve(pluginDir, '..', '..');
    const manifestFile = join(profileDir, 'package.json');
    if (!existsSync(manifestFile)) {
      log(`bundle check: no profile manifest at ${manifestFile}`);
      return;
    }
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const result = checkBundle(manifest);
    if (result.ok) {
      log(`bundle check: present (profile=${profileDir})`);
      return;
    }
    log(
      `bundle check: MISSING from dsh.profile.bundles (profile=${profileDir}) — ` +
        `add "${name}" to that list or this plugin will not load after a restart`,
    );
    trace({ event: 'bundle-missing', profile: profileDir, bundles: result.bundles });
    writeState({ bundleMissing: true, bundleCheckedAt: Date.now(), profile: profileDir });
  } catch (error) {
    log(`bundle check: failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function apply(ctx) {
  log(`apply() called (v${VERSION})`);
  writeState({ appliedAt: Date.now(), version: VERSION });
  selfCheck();


  const config = readConfig();
  injectedLlm = makeLlm(ctx, config);
  injectedMaxLlmChars = config.maxLlmChars;
  log(`distill=${config.distill}${injectedLlm ? ' via host model' : ' (rules only)'}`);
  // Backfill is triggered by the first user message, not here: at apply() time
  // the host model service is not mounted yet and every call fails.

  try {
    ctx.effect(
      () => {
        log('effect registered');
        return () => {
          try {
            soul?.store?.close();
            soul = null;
            lastSectionHash = '';
            log('effect disposed (store closed)');
          } catch (error) {
            log(`dispose failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        };
      },
      'soulbridge.lifecycle',
    );
  } catch (error) {
    log(`effect registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    ctx.systemPrompt.section({
      name: 'soulbridge',
      order: 10,
      text: () => buildInjection(),
    });
    log('section registered (name=soulbridge order=10)');
  } catch (error) {
    log(`section registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // RFC 0006: relevant memories are injected here, not in the system prompt —
  // this is the only point that runs after the user message and before the
  // request, and its waterfall can change the request.
  try {
    if (ctx.on) {
      ctx.on('agent/pre-step', createPreStepHandler({ getContext: buildRelatedContext, archivedSessions: () => readArchivedSessions(ctx) }));
      log('pre-step listener attached');
    }
  } catch (error) {
    log(`pre-step listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Tools (RFC 0005): registered only when the host exposes the service, and
  // disposed with the plugin so a reload cannot register twice.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (toolsCtx) => {
        const tools = toolsCtx.get('tools');
        if (!tools) {
          log('tools: service unavailable; disabled');
          return;
        }
        const disposers = [tools.register(recallTool()), tools.register(rememberTool()), tools.register(detailTool())];
        log('tools registered (soul_recall, soul_remember, soul_detail)');
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose?.();
            } catch {
              // A failed disposer must not block the rest of unload.
            }
          }
          log('tools disposed');
        });
      });
    } else {
      log('tools: ctx.inject unavailable; disabled');
    }
  } catch (error) {
    log(`tools registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    ctx.on('session/event', (session, event) => {
      const type = event?.type ?? '?';
      log(
        `session/event type=${type}` +
          ` eventKeys=[${safeKeys(event)}]` +
          ` dataKeys=[${safeKeys(event?.data)}]` +
          ` sessionKeys=[${safeKeys(session)}]`,
      );

      const sessionId = session?.id ?? 'default';

      // Keep the last reply: a correction only makes sense next to what it targets.
      if (typeof event.data?.turn === 'number') currentTurn = event.data.turn;
      if (typeof event.data?.step === 'number') currentStep = event.data.step;

      if (type === 'assistant/message') {
        const content = event.data?.message?.content;
        const reply = textOf(content);
        if (reply.length > 0) {
          lastAssistantText = reply;
          noteAssistantPart(sessionId, reply);
        }
        // Reasoning is stored, never injected: it is a draft, but "why did you
        // say that" and consolidation both need it.
        const reasoning = reasoningOf(content);
        if (reasoning.length > 0) noteAssistantStep(sessionId, 'reasoning', reasoning);
        if (reply.length > 0) noteAssistantStep(sessionId, 'text', reply);
        // Context size per request: the only number that can show whether a
        // long session is running away (no user text, usage only).
        trace({
          event: 'message',
          session: sessionId,
          turn: event.data?.turn,
          step: event.data?.step,
          replyChars: reply.length,
          // What the model actually returned, block by block: the turn is 5
          // steps on average and 70% of turns call tools, so "one question one
          // answer" is a product abstraction, not the model's shape. Types and
          // sizes only — never the text.
          blocks: summarizeBlocks(event.data?.message?.content),
          usage: event.data?.usage ?? null,
        });
        return;
      }

      // A turn is over: write the pair. This is the primary flush point; the
      // silence timer and the next user turn are fallbacks only.
      if (type === 'turn/end') {
        flushTurnPair(sessionId);
        return;
      }

      if (type !== 'user/message') return;

      const data = event.data ?? {};
      const kind = data.source?.kind;
      const text = textOf(data.content);
      log(`user/message source=${kind ?? '?'} chars=${text.length}`);
      // The model service is only mounted once the session is live, so the
      // one-shot backfill waits for the first real message instead of running
      // inside apply() where the llm lookup fails.
      if (kind === 'user') {
        void backfillExtraction();
      }

      // Only the human's own prose. runtime-context / time-context / injected
      // messages arrive with their own source kinds and must not be observed.
      if (kind !== 'user') return;
      if (text.length === 0) return;

      // A new user turn means the previous one never saw turn/end (interrupt,
      // crash). Drop it rather than write a half pair.
      flushTurnPair(sessionId);
      noteUserTurn(sessionId, event, text);

      // Evidence, not memory (RFC 0003 phase A), recorded with the reply it targeted.
      // Two layers: explicit markers (L1) first, then structure against that reply (L2).
      const verdict = detectCorrection(text, lastAssistantText);
      if (verdict.isCorrection) {
        try {
          const id = ensureSoul().recordCorrection({
            userText: text,
            assistantText: lastAssistantText,
            rule: verdict.marker ? `${verdict.layer}:${verdict.marker}` : verdict.layer,
          });
          log(`correction recorded: ${id} layer=${verdict.layer} marker=${verdict.marker ?? '-'}`);
        } catch (error) {
          log(`correction failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      void observeText(text);
    });
    log('session/event listener attached');


    // NOTE: reflect() is intentionally not wired. observe() already distils each
    // turn (distillStrategy lives in ruleExtract), so a per-turn reflect would
    // only return memories=0; session/disposed never fires on the desktop host.
    // Session-level summarisation waits for a reliable trigger and LLM distillation.
  } catch (error) {
    log(`session/event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { textOf, VERSION };
