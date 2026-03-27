# data.json Format

This file is the single source of truth for the leaderboard website.  
Edit it manually, commit, and push — the server updates automatically via webhook.

---

## Top-level structure

```json
{
  "updatedAt": 1700000000000,
  "players": { ... },
  "tournaments": [ ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `updatedAt` | Unix timestamp (ms) or `null` | Shown as "Updated" in the nav. Use `Date.now()` or epoch ms. |
| `players` | Object | One entry per player, keyed by username |
| `tournaments` | Array | One entry per tournament, newest last |

---

## Player entry

```json
"PlayerName": {
  "wins":          12,
  "losses":        4,
  "titles":        2,
  "top3":          3,
  "matches":       16,
  "points":        27,
  "gamesPlayed":   ["T-001", "T-002", "T-003"]
}
```

| Field | Description |
|---|---|
| `wins` | Total individual match wins across all tournaments |
| `losses` | Total individual match losses |
| `titles` | Number of tournament championships (1st place) |
| `top3` | Number of top-3 finishes (includes titles) |
| `matches` | Total matches played (wins + losses) |
| `points` | Total accumulated points (1st=10, 2nd=5, 3rd=2, participated=1) |
| `gamesPlayed` | Array of tournament IDs this player participated in |

---

## Tournament entry

```json
{
  "id":       "T-001",
  "name":     "Tournament #1",
  "format":   "single_elimination",
  "date":     1700000000000,
  "champion": "PlayerA",
  "second":   "PlayerB",
  "third":    "PlayerC",
  "players":  ["PlayerA", "PlayerB", "PlayerC", "PlayerD"],
  "matchLog": [ ... ],
  "bracket":  { ... }
}
```

| Field | Values | Description |
|---|---|---|
| `id` | Any unique string | e.g. `"T-001"`, `"T-2024-03"` |
| `name` | String | Displayed as tournament title |
| `format` | `"single_elimination"` / `"double_elimination"` | Affects bracket rendering |
| `date` | Unix timestamp (ms) | Use epoch milliseconds |
| `champion` | Player name or `null` | 1st place |
| `second` | Player name or `null` | 2nd place |
| `third` | Player name or `null` | 3rd place |
| `players` | Array of names | Everyone who signed up |
| `matchLog` | Array of match results | See below |
| `bracket` | Bracket object or `null` | See below — can be omitted |

---

## matchLog entry

```json
{
  "matchId": "SE-1-0",
  "round":   "Semi-Finals",
  "p1":      "PlayerA",
  "p2":      "PlayerB",
  "winner":  "PlayerA",
  "loser":   "PlayerB",
  "method":  "gg"
}
```

| `method` values | Meaning |
|---|---|
| `"gg"` | Loser typed gg in chat |
| `"disconnect"` | Loser disconnected |
| `"no_show"` | Player didn't join |
| `"manual"` | Manually entered result |
| `"override"` | Result was corrected |

---

## bracket object (single_elimination)

```json
{
  "format": "single_elimination",
  "rounds": [
    [
      { "id": "SE-0-0", "p1": "PlayerA", "p2": "PlayerB", "winner": "PlayerA", "loser": "PlayerB", "roundIdx": 0, "matchIdx": 0 },
      { "id": "SE-0-1", "p1": "PlayerC", "p2": "PlayerD", "winner": "PlayerC", "loser": "PlayerD", "roundIdx": 0, "matchIdx": 1 }
    ],
    [
      { "id": "SE-1-0", "p1": "PlayerA", "p2": "PlayerC", "winner": "PlayerA", "loser": "PlayerC", "roundIdx": 1, "matchIdx": 0 }
    ]
  ],
  "eliminated": ["PlayerB", "PlayerD", "PlayerC"]
}
```

Each round is an array of matches. `winner`/`loser` are `null` for unplayed matches.  
Use `"BYE"` for bye slots. Set `bracket: null` to skip bracket display entirely.

---

## Complete minimal example

```json
{
  "updatedAt": 1711400000000,
  "players": {
    "ConsciouslyEating": {
      "wins": 3, "losses": 0, "titles": 1, "top3": 1,
      "matches": 3, "points": 10, "gamesPlayed": ["T-001"]
    },
    "guest_831272": {
      "wins": 1, "losses": 1, "titles": 0, "top3": 1,
      "matches": 2, "points": 5, "gamesPlayed": ["T-001"]
    },
    "crayon": {
      "wins": 1, "losses": 1, "titles": 0, "top3": 0,
      "matches": 2, "points": 1, "gamesPlayed": ["T-001"]
    },
    "guest_049249": {
      "wins": 0, "losses": 1, "titles": 0, "top3": 0,
      "matches": 1, "points": 1, "gamesPlayed": ["T-001"]
    }
  },
  "tournaments": [
    {
      "id": "T-001",
      "name": "Tournament #1",
      "format": "single_elimination",
      "date": 1711400000000,
      "champion": "ConsciouslyEating",
      "second": "guest_831272",
      "third": null,
      "players": ["ConsciouslyEating", "guest_831272", "crayon", "guest_049249"],
      "matchLog": [
        { "round": "Semi-Finals", "p1": "ConsciouslyEating", "p2": "guest_049249", "winner": "ConsciouslyEating", "loser": "guest_049249", "method": "gg" },
        { "round": "Semi-Finals", "p1": "guest_831272", "p2": "crayon", "winner": "guest_831272", "loser": "crayon", "method": "disconnect" },
        { "round": "Final", "p1": "ConsciouslyEating", "p2": "guest_831272", "winner": "ConsciouslyEating", "loser": "guest_831272", "method": "gg" }
      ],
      "bracket": null
    }
  ]
}
```

---

## Points calculation reminder

| Place | Points |
|---|---|
| 🥇 1st | +10 |
| 🥈 2nd | +5 |
| 🥉 3rd | +2 |
| Participated | +1 |

Points are cumulative across all tournaments.
