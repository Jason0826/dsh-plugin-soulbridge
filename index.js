/**
 * dsh-plugin-soulbridge — spike v0.0.2.
 *
 * Now does the real thing for one path: when a user message lands in the
 * session event stream, hand its text to soulbridge's `observe`.
 *
 * Still deliberately small:
 *   - injection is a static marker (memory injection comes next)
 *   - only `user/message` events are acted on
 *   - every failure is logged, never thrown (the host must not break)
 *
 * Log: ~/.soulbridge/plugin.log (override with SOULBRIDGE_HOME).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-plugin-soulbridge';
export const inject = ['systemPrompt'];

const LOG_DIR = process.env.SOULBRIDGE_HOME ?? join(homedir(), '.soulbridge');
const MARKER = '<soulbridge>spike: plugin loaded, injection works</soulbridge>';

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'plugin.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break the host.
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

let soulPromise = null;

/** Lazily open the soul; returns null (and logs) when anything is unavailable. */
function getSoul() {
  if (soulPromise === null) {
    soulPromise = (async () => {
      const core = await import('soulbridge');
      const config = core.ensureConfig();
      const dbPath = core.resolveDbPath();
      const store = core.openSqlite(dbPath);
      const soul = new core.Soul({
        store,
        soulId: config.soulId,
        userId: config.userId,
        name: config.name,
        deviceId: config.deviceId,
      });
      log(`soul ready: db=${dbPath} soul=${config.soulId} user=${config.userId}`);
      return soul;
    })().catch((error) => {
      log(`soul init failed: ${error instanceof Error ? error.message : String(error)}`);
      soulPromise = null;
      return null;
    });
  }
  return soulPromise;
}

async function observeText(text) {
  const started = Date.now();
  try {
    const soul = await getSoul();
    if (!soul) return;
    const result = await soul.observe({ role: 'user', content: text });
    const affect = result?.affect ?? {};
    log(
      `observe ok: chars=${text.length} written=${result?.written ?? '?'}` +
        ` affect=${affect.dominant ?? 'none'} intensity=${affect.intensity ?? '?'}` +
        ` confidence=${affect.confidence ?? '?'} ms=${Date.now() - started}`,
    );
  } catch (error) {
    log(`observe failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function apply(ctx) {
  log('apply() called (v0.0.2)');

  try {
    ctx.effect(
      () => {
        log('effect registered');
        return () => log('effect disposed');
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
      text: () => {
        log('section.text() evaluated');
        return MARKER;
      },
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

      // Injected/plugin messages are not the user speaking.
      if (kind && kind !== 'user') return;
      if (text.length === 0) return;
      void observeText(text);
    });
    log('session/event listener attached');
  } catch (error) {
    log(`session/event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { MARKER, textOf };
