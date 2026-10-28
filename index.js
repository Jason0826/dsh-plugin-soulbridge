/**
 * dsh-plugin-soulbridge — spike.
 *
 * Goal of this iteration is evidence, not features:
 *   1. does `systemPrompt.section` get registered and evaluated?
 *   2. does `session/event` reach us, and what does its payload look like?
 *   3. is the lifecycle disposer called on unload?
 *
 * Everything is appended to `~/.soulbridge/plugin.log` (override with
 * SOULBRIDGE_HOME). Registration is individually guarded so one failure still
 * leaves the other evidence behind.
 *
 * No database access, no core import yet: fewer moving parts, clearer signal.
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

export function apply(ctx) {
  log('apply() called');

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
      log(
        `session/event type=${event?.type ?? '?'}` +
          ` eventKeys=[${safeKeys(event)}]` +
          ` dataKeys=[${safeKeys(event?.data)}]` +
          ` sessionKeys=[${safeKeys(session)}]`,
      );
    });
    log('session/event listener attached');
  } catch (error) {
    log(`session/event listener failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export { MARKER };
