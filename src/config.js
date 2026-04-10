'use strict';

const COMMANDS_HELP =
  '📋 Commands: ' +
  '!ready — confirm you are ready to start | ' +
  '!forfeit — forfeit this match (you lose) | ' +
  '!leave — remove yourself from signup (signup phase only) | ' +
  '!commands — show this list';

module.exports = {
  COMMANDS_HELP,
  signupKeyword:       '!join',
  signupDurationMs:    5 * 60_000,   // 5 minutes
  mapName:             'Ravaged',
  gameNamePrefix:      'TOURNEY',
  minPlayers:          4,
  maxPlayers:          4,
  betweenMatchDelayMs: 10_000,
  resultKeyword:       '!win',
  leaveKeyword:        '!leave',
  joinWaitMs:          5 * 60_000,   // 5 minutes
  banTimeoutMs:        3 * 60_000,   // 3 minutes — map ban phase timer
  intruderKickMs:      10_000,
  readyWaitMs:         5 * 60_000,   // 5 minutes
  ggWatchMs:           2 * 60_000,
  bracketFormat:       'single_elimination', // single_elimination | double_elimination
  lwgUrl:              'https://www.littlewargame.com/play/',

  // ── Per-format settings ────────────────────────────────────
  // Each entry overrides the global settings above for that format.
  formatSettings: {
    single_elimination: {
      mapPool:  ['Ravaged'],         // 1 map = no ban phase
      bestOf:   1,                   // BO1 by default
    },
    double_elimination: {
      mapPool:  ['Ravaged', 'Silent Fjord LE', 'Burning Sands', 'Winter War', 'Deadlock'],
      bestOf:   3,                   // BO3 — first to 2 wins
    },
  },
};
