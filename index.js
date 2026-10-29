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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, ensureConfig, resolveDbPath, Soul } from 'soulbridge';

export const name = 'dsh-plugin-soulbridge';
export const inject = ['systemPrompt'];

const HOME = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const STATE_FILE = join(HOME, 'plugin-state.json');

/** Injection policy: what may reach the prompt, and how much of it. */
const INJECT = {
  types: ['strategy', 'fact', 'trait'],
  minImportance: 6,
  maxItems: 5,
};
/** Prompt assembly can run several times per step; do not hit SQLite every time. */
const CACHE_MS = 30_000;

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
      `observe ok: chars=${text.length} written=${result?.written ?? '?'}` +
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

/**
 * One-shot POC mode (temporary): when ~/.soulbridge/poc.json exists, run its
 * fixtures through the HOST's own model (ctx.llm) and write raw outputs.
 *
 * This measures the same transport a production DSH adapter would use, with no
 * extra key or endpoint. Delete the file to disable.
 */
async function runPoc(ctx) {
  const file = join(HOME, 'poc.json');
  if (!existsSync(file)) return;
  const llmService = ctx.get('llm');
  if (!llmService) {
    log('poc: llm service unavailable');
    return;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    log(`poc: bad config: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const results = [];
  for (const fixture of config.fixtures ?? []) {
    const started = Date.now();
    try {
      let text = '';
      for await (const chunk of llmService.stream({
        provider: config.provider,
        model: config.model,
        messages: [{ role: 'user', content: `${config.prompt}\n\n用户：${fixture.text}` }],
      })) {
        if (chunk.type === 'text-delta') text += chunk.text;
      }
      results.push({ id: fixture.id, raw: text.trim(), ms: Date.now() - started });
    } catch (error) {
      results.push({ id: fixture.id, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    }
    log(`poc: ${fixture.id} done`);
  }

  try {
    writeFileSync(config.out, JSON.stringify(results, null, 2), 'utf8');
    log(`poc: wrote ${results.length} results to ${config.out}`);
  } catch (error) {
    log(`poc: write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function apply(ctx) {
  log(`apply() called (v${VERSION})`);
  writeState({ appliedAt: Date.now(), version: VERSION });

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

  try {
    ctx.on('session/event', (session, event) => {
      const type = event?.type ?? '?';
      log(
        `session/event type=${type}` +
          ` eventKeys=[${safeKeys(event)}]` +
          ` dataKeys=[${safeKeys(event?.data)}]` +
          ` sessionKeys=[${safeKeys(session)}]`,
      );

      if (type !== 'user/message') return;

      const data = event.data ?? {};
      const kind = data.source?.kind;
      const text = textOf(data.content);
      log(`user/message source=${kind ?? '?'} chars=${text.length}`);

      // Only the human's own prose. runtime-context / time-context / injected
      // messages arrive with their own source kinds and must not be observed.
      if (kind !== 'user') return;
      if (text.length === 0) return;
      void observeText(text);
    });
    log('session/event listener attached');

    void runPoc(ctx);

    // NOTE: reflect() is intentionally not wired. observe() already distils each
    // turn (distillStrategy lives in ruleExtract), so a per-turn reflect would
    // only return memories=0; session/disposed never fires on the desktop host.
    // Session-level summarisation waits for a reliable trigger and LLM distillation.
  } catch (error) {
    log(`session/event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { textOf, VERSION };
