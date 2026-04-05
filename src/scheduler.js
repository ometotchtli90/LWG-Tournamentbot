'use strict';
/**
 * scheduler.js
 * Manages recurring / one-shot tournament schedules using node-schedule.
 * Schedules are persisted to data/schedules.json.
 *
 * Each schedule object:
 * {
 *   id:            string (UUID),
 *   name:          string,
 *   enabled:       boolean,
 *   recurrence:    "once" | "daily" | "weekly" | "custom",
 *   fireAt:        ISO string (only for recurrence === "once"),
 *   dayOfWeek:     0–6   (only for recurrence === "weekly"; 0=Sun),
 *   time:          "HH:MM" (local time in `timezone`),
 *   timezone:      IANA tz string, e.g. "Europe/Berlin",
 *   cronExpr:      string (only for recurrence === "custom"),
 *   masterMapPool: string[],   // full list of available maps
 *   mapPoolSize:   number,     // how many to randomly pick for each run
 * }
 */

const nodeSchedule = require('node-schedule');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');

const SCHEDULES_PATH = path.join(__dirname, '..', 'data', 'schedules.json');
const ACCOUNTS_PATH  = path.join(__dirname, '..', 'data', 'accounts.json');

// Reference to controller module — injected via init()
let controller = null;

// Live node-schedule Job instances keyed by schedule id
const jobs     = {};  // tournament trigger jobs
const bootJobs = {};  // pre-boot jobs (fire 2 min before tournament start)

// ── Persistence ───────────────────────────────────────────────────────────────

function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_PATH))
      return JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
  } catch (_) {}
  return [];
}

function saveSchedules(schedules) {
  fs.mkdirSync(path.dirname(SCHEDULES_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2), 'utf8');
}

// ── Cron helpers ──────────────────────────────────────────────────────────────

function makeCronRule(sched) {
  if (sched.recurrence === 'custom') return sched.cronExpr || null;
  if (!sched.time) return null;

  const parts = sched.time.split(':');
  let hh = parseInt(parts[0], 10);
  let mm = parseInt(parts[1] || '0', 10);

  // Fire signupOpenMins early so signup is open for exactly that duration
  const offset = parseInt(sched.signupOpenMins) || 0;
  mm -= offset;
  while (mm < 0) { mm += 60; hh--; }
  hh = ((hh % 24) + 24) % 24;

  if (sched.recurrence === 'daily')  return `${mm} ${hh} * * *`;
  if (sched.recurrence === 'weekly') return `${mm} ${hh} * * ${sched.dayOfWeek ?? 0}`;
  return null; // 'once' handled separately
}

// Cron rule for pre-boot: always 2 minutes before tournament start time
function makeBootCronRule(sched) {
  if (sched.recurrence === 'custom' || !sched.time) return null;

  const parts = sched.time.split(':');
  let hh = parseInt(parts[0], 10);
  let mm = parseInt(parts[1] || '0', 10);

  mm -= 2;
  while (mm < 0) { mm += 60; hh--; }
  hh = ((hh % 24) + 24) % 24;

  if (sched.recurrence === 'daily')  return `${mm} ${hh} * * *`;
  if (sched.recurrence === 'weekly') return `${mm} ${hh} * * ${sched.dayOfWeek ?? 0}`;
  return null;
}

// ── Pre-boot helper ───────────────────────────────────────────────────────────

async function preBootBots(schedName) {
  if (controller.isRunning()) {
    console.log(`[scheduler] Pre-boot for "${schedName}": bots already running.`);
    return;
  }
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    console.error(`[scheduler] Pre-boot for "${schedName}": no accounts.json found. Configure accounts in Settings first.`);
    return;
  }
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  console.log(`[scheduler] Pre-booting browsers 2 min before "${schedName}"…`);
  try {
    await controller.boot(accounts);
    console.log(`[scheduler] Pre-boot complete for "${schedName}".`);
  } catch (e) {
    console.error(`[scheduler] Pre-boot error for "${schedName}":`, e.message);
  }
}

// ── Tournament trigger ────────────────────────────────────────────────────────

async function triggerTournament(sched) {
  console.log(`[scheduler] ▶ Triggering: "${sched.name}"`);

  const cfg = require('./config');

  // Pick random maps from master pool
  const master = Array.isArray(sched.masterMapPool) ? sched.masterMapPool : [];
  const size   = Math.min(Math.max(1, sched.mapPoolSize || 5), master.length || 1);
  const shuffled = master.slice().sort(() => Math.random() - 0.5);
  const picked   = shuffled.slice(0, size);

  console.log(`[scheduler] Map pool (${picked.length}): ${picked.join(', ')}`);

  // Apply picked maps to the live config (double_elimination is always used for scheduled runs)
  if (!cfg.formatSettings)                                cfg.formatSettings = {};
  if (!cfg.formatSettings.double_elimination)             cfg.formatSettings.double_elimination = {};
  cfg.formatSettings.double_elimination.mapPool = picked;
  cfg.bracketFormat = 'double_elimination';

  // ── Apply per-schedule config overrides ───────────────────
  if (sched.signupOpenMins)  cfg.signupDurationMs = parseInt(sched.signupOpenMins)  * 60000;
  if (sched.minPlayers)      cfg.minPlayers       = parseInt(sched.minPlayers);
  if (sched.maxPlayers)      cfg.maxPlayers       = parseInt(sched.maxPlayers);
  if (sched.joinWaitMins)    cfg.joinWaitMs       = parseInt(sched.joinWaitMins)    * 60000;
  if (sched.banTimeoutMins)  cfg.banTimeoutMs     = parseInt(sched.banTimeoutMins)  * 60000;

  try {
    // Auto-boot browsers if they are not already running
    if (!controller.isRunning()) {
      if (!fs.existsSync(ACCOUNTS_PATH)) {
        console.error('[scheduler] Cannot boot: no accounts.json found. Configure accounts in Settings first.');
        return;
      }
      const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
      console.log('[scheduler] Auto-booting browsers…');
      await controller.boot(accounts);
    }

    // Open timed signup (uses signupDurationMs from config)
    await controller.dashboardCommand('openSignup', ['double_elimination', 'timed']);
    console.log(`[scheduler] Signup opened for "${sched.name}".`);
  } catch (e) {
    console.error(`[scheduler] Error triggering "${sched.name}":`, e.message);
  }
}

// ── Job management ────────────────────────────────────────────────────────────

function startJob(sched) {
  // Cancel any existing jobs for this id
  if (jobs[sched.id])     { jobs[sched.id].cancel();     delete jobs[sched.id]; }
  if (bootJobs[sched.id]) { bootJobs[sched.id].cancel(); delete bootJobs[sched.id]; }

  if (!sched.enabled) return;

  const tz = sched.timezone || 'UTC';

  if (sched.recurrence === 'once') {
    if (!sched.fireAt) return;
    const offset  = parseInt(sched.signupOpenMins) || 0;
    const fireAt  = new Date(new Date(sched.fireAt).getTime() - offset * 60000);
    if (fireAt <= new Date()) {
      console.log(`[scheduler] Skipping past one-shot "${sched.name}" (${sched.fireAt})`);
      return;
    }
    // node-schedule fires once when passed a Date directly
    const j = nodeSchedule.scheduleJob(fireAt, () => {
      triggerTournament(sched);
    });
    if (j) jobs[sched.id] = j;

    // Pre-boot job: 2 minutes before tournament start
    const bootAt = new Date(new Date(sched.fireAt).getTime() - 2 * 60000);
    if (bootAt > new Date()) {
      const bj = nodeSchedule.scheduleJob(bootAt, () => preBootBots(sched.name));
      if (bj) bootJobs[sched.id] = bj;
    }
  } else {
    const rule = makeCronRule(sched);
    if (!rule) return;
    const j = nodeSchedule.scheduleJob({ rule, tz }, () => {
      triggerTournament(sched);
    });
    if (j) jobs[sched.id] = j;

    // Pre-boot job: cron 2 minutes before tournament start
    const bootRule = makeBootCronRule(sched);
    if (bootRule) {
      const bj = nodeSchedule.scheduleJob({ rule: bootRule, tz }, () => preBootBots(sched.name));
      if (bj) bootJobs[sched.id] = bj;
    }
  }

  const next = getNextRun(sched);
  console.log(`[scheduler] Scheduled "${sched.name}" → next: ${next || 'n/a'}`);
}

function stopJob(id) {
  if (jobs[id])     { jobs[id].cancel();     delete jobs[id]; }
  if (bootJobs[id]) { bootJobs[id].cancel(); delete bootJobs[id]; }
}

function getNextRun(sched) {
  const job = jobs[sched.id];
  if (!job) return null;
  try {
    const inv = job.nextInvocation();
    return inv ? new Date(inv).toISOString() : null;
  } catch (_) { return null; }
}

// ── Public CRUD API ───────────────────────────────────────────────────────────

function addSchedule(data) {
  const schedules = loadSchedules();
  const sched = { ...data, id: data.id || crypto.randomUUID(), enabled: data.enabled !== false };
  schedules.push(sched);
  saveSchedules(schedules);
  startJob(sched);
  return { ...sched, nextRun: getNextRun(sched) };
}

function updateSchedule(id, data) {
  const schedules = loadSchedules();
  const idx = schedules.findIndex(s => s.id === id);
  if (idx === -1) return null;
  schedules[idx] = { ...schedules[idx], ...data, id };
  saveSchedules(schedules);
  startJob(schedules[idx]);
  return { ...schedules[idx], nextRun: getNextRun(schedules[idx]) };
}

function deleteSchedule(id) {
  stopJob(id);
  const schedules = loadSchedules().filter(s => s.id !== id);
  saveSchedules(schedules);
}

function listSchedules() {
  return loadSchedules().map(s => ({ ...s, nextRun: getNextRun(s) }));
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(ctrl) {
  controller = ctrl;
  const schedules = loadSchedules();
  schedules.forEach(s => startJob(s));
  console.log(`[scheduler] Initialised. ${schedules.length} schedule(s) loaded.`);
}

module.exports = { init, addSchedule, updateSchedule, deleteSchedule, listSchedules, triggerTournament };
