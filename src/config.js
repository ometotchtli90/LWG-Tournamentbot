'use strict';
module.exports = {
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
  intruderKickMs:      10_000,
  readyWaitMs:         5 * 60_000,   // 5 minutes
  ggWatchMs:           2 * 60_000,
  bracketFormat:       'single_elimination', // single_elimination | double_elimination
  lwgUrl:              'https://www.littlewargame.com/play/',
};
