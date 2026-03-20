// ── Tournament configuration ──────────────────────────────
// Edit these values to customise tournament behaviour.

module.exports = {
  signupKeyword:       "!join",
  signupDurationMs:    120_000,     // 2 minutes
  mapName:             "Ravaged",
  gameNamePrefix:      "TOURNEY",
  gamePassword:        "tourney2025",
  minPlayers:          4,
  maxPlayers:          16,
  betweenMatchDelayMs: 15_000,
  resultKeyword:       "!win",
  joinWaitMs:          15 * 60_000, // 15 min for players to join hosted game
  intruderKickMs:      10_000,
  readyWaitMs:         60_000,
  ggWatchMs:           2 * 60_000,
  lwgUrl:              "https://www.littlewargame.com/play/",
};
