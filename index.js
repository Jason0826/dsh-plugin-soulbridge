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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, ensureConfig, resolveDbPath, Soul, isCorrection, correctionRule } from 'soulbridge';

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

/** Injection policy: what may reach the prompt, and how much of it. */
const INJECT = {
  types: ['strategy', 'fact', 'trait'],
  minImportance: 6,
  maxItems: 5,
};
/** Prompt assembly can run several times per step; do not hit SQLite every time. */
const CACHE_MS = 30_000;

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
};

function readConfig() {
  try {
    return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

/** Adapter side of the core LlmFn port: the host model, called inside a turn. */
function makeLlm(ctx, config) {
  if (config.distill !== 'llm') return undefined;
  // Resolve the service on first use: at apply() time the llm plugin may not be
  // registered yet, and the probe showed the call only works inside a turn.
  return async (prompt) => {
    const service = ctx.get('llm');
    if (!service) throw new Error('llm service unavailable');
    let text = '';
    for await (const chunk of service.stream({
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
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      if (chunk.type === 'block-end' && chunk.block?.type === 'text') text += chunk.block.text ?? '';
    }
    return text;
  };
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

let cache = { text: '', at: 0 };

/** Synchronous by necessity: PromptSection.text cannot return a promise. */
function buildInjection() {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.text;
  try {
    const result = ensureSoul().context({ track: false, ...INJECT });
    cache = { text: result.text, at: now };
    const state = readState();
    writeState({
      injects: (state.injects ?? 0) + 1,
      lastInjectAt: now,
      lastInjectedChars: result.text.length,
      lastInjectedMemories: result.used.length,
    });
    return cache.text;
  } catch {
    return cache.text;
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
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
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
    cache.at = 0; // a new observation may change what should be injected
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
        const type = typeof args?.type === 'string' ? args.type : undefined;
        const importance = args?.importance === undefined ? undefined : Number(args.importance);
        const result = ensureSoul().rememberExplicit({ content, type, importance });
        log(`tool soul_remember: ok=${result.ok} duplicate=${result.duplicate ?? false}`);
        return result;
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function apply(ctx) {
  log(`apply() called (v${VERSION})`);
  writeState({ appliedAt: Date.now(), version: VERSION });

  const config = readConfig();
  injectedLlm = makeLlm(ctx, config);
  injectedMaxLlmChars = config.maxLlmChars;
  log(`distill=${config.distill}${injectedLlm ? ' via host model' : ' (rules only)'}`);

  try {
    ctx.effect(
      () => {
        log('effect registered');
        return () => {
          try {
            soul?.store?.close();
            soul = null;
            cache = { text: '', at: 0 };
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
        const disposers = [tools.register(recallTool()), tools.register(rememberTool())];
        log('tools registered (soul_recall, soul_remember)');
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

      // Keep the last reply: a correction only makes sense next to what it targets.
      if (type === 'assistant/message') {
        const reply = textOf(event.data?.message?.content);
        if (reply.length > 0) lastAssistantText = reply;
        return;
      }

      if (type !== 'user/message') return;

      const data = event.data ?? {};
      const kind = data.source?.kind;
      const text = textOf(data.content);
      log(`user/message source=${kind ?? '?'} chars=${text.length}`);

      // Only the human's own prose. runtime-context / time-context / injected
      // messages arrive with their own source kinds and must not be observed.
      if (kind !== 'user') return;
      if (text.length === 0) return;

      // Evidence, not memory (RFC 0003 phase A): a correction is recorded with
      // the reply it targeted, untouched, and never injected.
      if (isCorrection(text)) {
        try {
          const id = ensureSoul().recordCorrection({
            userText: text,
            assistantText: lastAssistantText,
            rule: correctionRule(text) ?? undefined,
          });
          log(`correction recorded: ${id}`);
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
