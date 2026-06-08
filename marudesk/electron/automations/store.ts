import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { atomicWriteFile } from '../fs-safe';
import {
  isDue,
  nextRun,
  normalizeSchedule,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSchedule,
} from '../../shared/automations';

/**
 * Persistent store for automations (Stage 12-C). Holds the saved automations in
 * memory (the scheduler reads them every tick) and mirrors changes to a JSON
 * file under userData. The (de)serialization is pure + defensive (the file is
 * hand-editable), so it's headless-tested; only configure/persist touch disk.
 */

const MAX_AUTOMATIONS = 100;
const MAX_RUN_SUMMARY = 2_000;

let automations = new Map<string, Automation>();
let storeFile: string | null = null;

export type { AutomationInput };

/* ── pure (de)serialization — headless-tested ─────────────────────────────── */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Coerce an unknown value into a valid AutomationSchedule (or a safe default). */
export function parseSchedule(v: unknown): AutomationSchedule {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.kind === 'daily') return normalizeSchedule({ kind: 'daily', hour: Number(o.hour) || 0, minute: Number(o.minute) || 0 });
  if (o.kind === 'weekly') {
    return normalizeSchedule({ kind: 'weekly', weekday: Number(o.weekday) || 0, hour: Number(o.hour) || 0, minute: Number(o.minute) || 0 });
  }
  return normalizeSchedule({ kind: 'interval', everyMinutes: Number(o.everyMinutes) || 0 });
}

function parseRun(v: unknown): AutomationRun | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const startedAt = num(o.startedAt);
  const finishedAt = num(o.finishedAt);
  if (startedAt === null || finishedAt === null) return null;
  return {
    startedAt,
    finishedAt,
    status: o.status === 'error' ? 'error' : 'done',
    summary: str(o.summary).slice(0, MAX_RUN_SUMMARY),
  };
}

/** Parse the persisted file into an id→Automation map, dropping malformed entries. */
export function parseAutomations(raw: unknown): Map<string, Automation> {
  const out = new Map<string, Automation>();
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : [];
  for (const item of list) {
    if (out.size >= MAX_AUTOMATIONS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = str(o.id);
    const name = str(o.name);
    const prompt = str(o.prompt);
    if (!id || !name || !prompt || out.has(id)) continue;
    out.set(id, {
      id,
      name,
      prompt,
      provider: str(o.provider, 'anthropic'),
      model: str(o.model),
      schedule: parseSchedule(o.schedule),
      allowTools: Array.isArray(o.allowTools) ? o.allowTools.filter((t): t is string => typeof t === 'string') : [],
      enabled: o.enabled !== false,
      lastRunAt: num(o.lastRunAt),
      nextRunAt: num(o.nextRunAt),
      lastRun: parseRun(o.lastRun),
      createdAt: num(o.createdAt) ?? Date.now(),
    });
  }
  return out;
}

/** Serialize the map to the on-disk shape. */
export function serializeAutomations(map: Map<string, Automation>): string {
  return JSON.stringify({ items: [...map.values()] }, null, 2);
}

/* ── lifecycle + CRUD ─────────────────────────────────────────────────────── */

async function persist(): Promise<void> {
  if (storeFile) await atomicWriteFile(storeFile, serializeAutomations(automations));
}

/** Wire the persistence file (from main) and load saved automations. */
export async function configureAutomationStore(file: string): Promise<void> {
  storeFile = file;
  try {
    automations = parseAutomations(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    automations = new Map();
  }
}

/** All automations, newest first. */
export function listAutomations(): Automation[] {
  return [...automations.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** A snapshot of the in-memory automations the scheduler iterates. */
export function automationsForTick(): Automation[] {
  return [...automations.values()];
}

/** Create an automation, computing its first nextRunAt when enabled. */
export async function createAutomation(input: AutomationInput, now = Date.now()): Promise<Automation> {
  if (automations.size >= MAX_AUTOMATIONS) throw new Error(`too many automations (limit ${MAX_AUTOMATIONS})`);
  const schedule = normalizeSchedule(input.schedule);
  const automation: Automation = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    schedule,
    allowTools: input.allowTools,
    enabled: input.enabled,
    lastRunAt: null,
    nextRunAt: input.enabled ? nextRun(schedule, now) : null,
    lastRun: null,
    createdAt: now,
  };
  automations.set(automation.id, automation);
  await persist();
  return automation;
}

/** Update an automation's editable fields; recompute nextRunAt from the new schedule. */
export async function updateAutomation(id: string, input: AutomationInput, now = Date.now()): Promise<Automation | null> {
  const cur = automations.get(id);
  if (!cur) return null;
  const schedule = normalizeSchedule(input.schedule);
  const next: Automation = {
    ...cur,
    name: input.name.trim() || cur.name,
    prompt: input.prompt,
    provider: input.provider,
    model: input.model,
    schedule,
    allowTools: input.allowTools,
    enabled: input.enabled,
    nextRunAt: input.enabled ? nextRun(schedule, now) : null,
  };
  automations.set(id, next);
  await persist();
  return next;
}

/** Toggle enable; recompute (or clear) nextRunAt. */
export async function setAutomationEnabled(id: string, enabled: boolean, now = Date.now()): Promise<Automation | null> {
  const cur = automations.get(id);
  if (!cur) return null;
  const next = { ...cur, enabled, nextRunAt: enabled ? nextRun(cur.schedule, now) : null };
  automations.set(id, next);
  await persist();
  return next;
}

export async function deleteAutomation(id: string): Promise<boolean> {
  const had = automations.delete(id);
  if (had) await persist();
  return had;
}

/**
 * Record a completed run + advance the schedule. Called by the scheduler after a
 * run settles. Pure of execution — just state + persistence.
 */
export async function recordRun(id: string, run: AutomationRun, now = Date.now()): Promise<void> {
  const cur = automations.get(id);
  if (!cur) return;
  automations.set(id, {
    ...cur,
    lastRunAt: run.finishedAt,
    nextRunAt: cur.enabled ? nextRun(cur.schedule, now) : null,
    lastRun: { ...run, summary: run.summary.slice(0, MAX_RUN_SUMMARY) },
  });
  await persist();
}

/** The due automations at `now` (enabled + nextRunAt passed). */
export function dueAutomations(now: number): Automation[] {
  return automationsForTick().filter((a) => isDue(a, now));
}

/** Test-only reset of module state. */
export function __resetAutomationStoreForTests(): void {
  automations = new Map();
  storeFile = null;
}
