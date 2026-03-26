'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Points per finishing position ─────────────────────────
const PLACE_POINTS  = { 1: 10, 2: 5, 3: 2 };
const DEFAULT_POINTS = 1; // participation — everyone who played

// ── Data path helpers ─────────────────────────────────────
function getDataDir() {
  try {
    const electron = require('electron');
    const a = electron.app || (electron.remote && electron.remote.app);
    if (a) return a.getPath('userData');
  } catch (_) {}
  return path.join(__dirname, '..');
}

function getLeaderboardPath() { return path.join(getDataDir(), 'leaderboard.json'); }

function loadData() {
  const p = getLeaderboardPath();
  if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} }
  return { players: {}, tournaments: [] };
}

function saveData(data) {
  const p = getLeaderboardPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}

// ── Record a completed tournament ─────────────────────────
function recordTournament({ id, name, format, date, champion, second, third, bracket, matchLog, players, replayDir }) {
  const data = loadData();

  // Per-player match stats
  for (const entry of (matchLog || [])) {
    const { winner, loser } = entry;
    if (!winner || winner === 'BYE') continue;
    [winner, loser].forEach(p => {
      if (!p || p === 'BYE') return;
      if (!data.players[p]) data.players[p] = { wins:0, losses:0, titles:0, top3:0, matches:0, points:0, gamesPlayed:[] };
    });
    if (winner && winner !== 'BYE') { data.players[winner].wins++;  data.players[winner].matches++;  data.players[winner].gamesPlayed.push(id); }
    if (loser  && loser  !== 'BYE') { data.players[loser].losses++; data.players[loser].matches++;
      if (!data.players[loser].gamesPlayed.includes(id)) data.players[loser].gamesPlayed.push(id);
    }
  }

  // Points by finishing position + participation point for everyone
  const participated = (players || []).filter(p => p && p !== 'BYE');
  const placements   = [champion, second, third].filter(Boolean).filter(p => p !== 'BYE');

  participated.forEach(p => {
    if (!data.players[p]) data.players[p] = { wins:0, losses:0, titles:0, top3:0, matches:0, points:0, gamesPlayed:[] };
    const place = placements.indexOf(p) + 1;
    const pts   = place > 0 ? (PLACE_POINTS[place] || DEFAULT_POINTS) : DEFAULT_POINTS;
    data.players[p].points = (data.players[p].points || 0) + pts;
    if (!data.players[p].gamesPlayed.includes(id)) data.players[p].gamesPlayed.push(id);
  });

  if (champion && champion !== 'BYE') { data.players[champion].titles++; data.players[champion].top3++; }
  if (second   && second   !== 'BYE' && second !== champion) data.players[second].top3++;
  if (third    && third    !== 'BYE' && third  !== champion && third !== second) data.players[third].top3++;

  data.tournaments.push({
    id, name: name || `Tournament ${new Date(date||Date.now()).toLocaleDateString()}`,
    format, date: date||Date.now(),
    champion: champion||null, second: second||null, third: third||null,
    players: players||[], matchLog: matchLog||[], replayDir: replayDir||null, bracket,
  });

  saveData(data);
  return data;
}

// ══════════════════════════════════════════════════════════
// HTML GENERATION
// ══════════════════════════════════════════════════════════
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function generateHTML(data) {
  const players = Object.entries(data.players||{})
    .map(([name,s]) => ({
      name, wins:s.wins||0, losses:s.losses||0, titles:s.titles||0, top3:s.top3||0,
      matches:s.matches||0, points:s.points||0,
      winRate: s.matches>0 ? Math.round((s.wins/s.matches)*100) : 0,
      tourneysPlayed:(s.gamesPlayed||[]).length,
    }))
    .sort((a,b)=>b.points-a.points||b.titles-a.titles||b.wins-a.wins||a.name.localeCompare(b.name));

  const tournaments = [...(data.tournaments||[])].reverse();
  const podium = players.slice(0,3);
  const now = new Date().toLocaleString();

  // Bracket renderer
  function msHTML(m) {
    if(!m) return '';
    const p1=m.p1||'TBD', p2=m.p2||'TBD', w=m.winner;
    const sl=(name)=>{
      const sc=name==='BYE'?'bye':!name||name==='TBD'?'tbd':w===name?'winner':w?'loser':'';
      return `<div class="ms ${sc}">${esc(name)}${w===name?' 🏆':''}</div>`;
    };
    return `<div class="mc">${sl(p1)}${sl(p2)}</div>`;
  }
  function rcHTML(title,matches){
    return `<div class="br-round"><div class="rn">${esc(title)}</div>${(matches||[]).map(msHTML).join('')}</div>`;
  }
  function bracketHTML(t) {
    if(!t.bracket) return '<p class="muted">No bracket data.</p>';
    const fmt=t.bracket.format;
    if(fmt==='single_elimination'){
      const total=t.bracket.rounds?.length||1;
      return `<div class="br-wrap">${(t.bracket.rounds||[]).map((r,ri)=>{
        const n=total-ri; const nm=n===1?'Final':n===2?'Semis':n===3?'Quarters':`Round ${ri+1}`;
        return rcHTML(nm,r);
      }).join('')}</div>`;
    }
    if(fmt==='double_elimination'){
      return `<p class="br-label c-blue">Winner Bracket</p>
        <div class="br-wrap">${(t.bracket.wb||[]).map((r,i)=>rcHTML(`WB R${i+1}`,r)).join('')}</div>
        <p class="br-label c-red" style="margin-top:14px">Loser Bracket</p>
        <div class="br-wrap">${(t.bracket.lb||[]).map((r,i)=>rcHTML(`LB R${i+1}`,r)).join('')}</div>
        ${t.bracket.gf?`<p class="br-label c-gold" style="margin-top:14px">Grand Final</p>
        <div class="br-wrap">${rcHTML('Grand Final',t.bracket.gf)}</div>`:''}`;
    }
    return '<p class="muted">Unknown format.</p>';
  }

  // Podium cards
  function podCard(p,rank){
    const medals=['🥇','🥈','🥉'];
    if(!p) return `<div class="pod pod-${rank} pod-empty"><div class="pod-medal">${medals[rank-1]}</div><div class="pod-name">—</div></div>`;
    return `<div class="pod pod-${rank}">
      <div class="pod-medal">${medals[rank-1]}</div>
      <div class="pod-name">${esc(p.name)}</div>
      <div class="pod-pts">${p.points} <span style="font-size:13px;font-weight:400">pts</span></div>
      <div class="pod-stats">${p.titles} title${p.titles!==1?'s':''} · ${p.wins}W ${p.losses}L · ${p.winRate}% WR</div>
    </div>`;
  }

  // Rankings rows
  const tRows = players.map((p,i)=>`
    <tr class="${i===0?'r1':i===1?'r2':i===2?'r3':''}">
      <td class="tc">${i+1}</td>
      <td class="tn">${esc(p.name)}</td>
      <td class="tc tp">${p.points}</td>
      <td class="tc">${p.titles}</td><td class="tc">${p.top3}</td>
      <td class="tc">${p.wins}</td><td class="tc">${p.losses}</td><td class="tc">${p.matches}</td>
      <td><div class="wrb"><div class="wrf" style="width:${p.winRate}%"></div><span>${p.winRate}%</span></div></td>
      <td class="tc">${p.tourneysPlayed}</td>
    </tr>`).join('');

  // Tournament history
  const histHTML = tournaments.map(t=>{
    const d=new Date(t.date).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});
    const fl={single_elimination:'Single Elim',double_elimination:'Double Elim',swiss:'Swiss'}[t.format]||t.format||'';
    const mrows=(t.matchLog||[]).filter(m=>m.winner&&m.winner!=='BYE').map(m=>{
      const ds=new Date(t.date).toISOString().slice(0,10);
      const rn=(m.round||'Match').replace(/[^a-zA-Z0-9 ]/g,'').replace(/\s+/g,'-');
      const p1s=(m.p1||'').replace(/[^a-zA-Z0-9_-]/g,''), p2s=(m.p2||'').replace(/[^a-zA-Z0-9_-]/g,'');
      const fn=`${ds}_${rn}_${p1s}-vs-${p2s}.lwr`;
      const rp=t.replayDir?path.join(t.replayDir,fn):null;
      const rl=rp?`<a href="file:///${rp.replace(/\\/g,'/')}" class="rl">⬇ replay</a>`:'';
      const badge=m.method!=='gg'?`<span class="bdg">${esc(m.method)}</span>`:'';
      return `<tr><td>${esc(m.round||'')}</td><td>${esc(m.p1||'')}</td><td>${esc(m.p2||'')}</td>
        <td class="wc">${esc(m.winner)}${badge}</td><td>${rl}</td></tr>`;
    }).join('');
    const matchCount=(t.matchLog||[]).filter(m=>m.winner&&m.winner!=='BYE').length;
    return `<div class="tc-card">
      <div class="tc-hdr">
        <span class="tc-name">${esc(t.name)}</span>
        <span class="tc-meta">${fl} · ${d} · ${(t.players||[]).length} players</span>
      </div>
      <div class="tc-pod">
        ${t.champion?`<span class="pl gold">🥇 ${esc(t.champion)}</span>`:''}
        ${t.second  ?`<span class="pl silver">🥈 ${esc(t.second)}</span>`:''}
        ${t.third   ?`<span class="pl bronze">🥉 ${esc(t.third)}</span>`:''}
      </div>
      ${mrows?`<details><summary>Match Results (${matchCount} games)</summary>
        <div class="mtw"><table class="mt">
          <thead><tr><th>Round</th><th>P1</th><th>P2</th><th>Winner</th><th>Replay</th></tr></thead>
          <tbody>${mrows}</tbody>
        </table></div></details>`:''}
      <details><summary>View Bracket</summary>
        <div class="br-area">${bracketHTML(t)}</div>
      </details>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LWG Tournament Leaderboard</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d1117;--sf:#161b22;--sf2:#1c2128;--bd:#30363d;
  --gold:#f0a500;--silver:#aab4be;--bronze:#cd7f32;
  --green:#3fb950;--red:#f85149;--blue:#58a6ff;
  --text:#e6edf3;--muted:#8b949e;--r:8px}
html,body{min-height:100%;background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;line-height:1.5}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.muted{color:var(--muted)}
.container{max-width:1100px;margin:0 auto;padding:32px 20px}
header{text-align:center;padding:40px 0 32px;border-bottom:1px solid var(--bd);margin-bottom:40px}
header h1{font-size:30px;font-weight:800;color:var(--gold)}
header p{color:var(--muted);font-size:13px;margin-top:6px}
section{margin-bottom:52px}
.st{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
  color:var(--muted);margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--bd)}
.pts-leg{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.pb{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid var(--bd);background:var(--sf)}
.pb.g{border-color:var(--gold);color:var(--gold)}.pb.s{border-color:var(--silver);color:var(--silver)}
.pb.b{border-color:var(--bronze);color:var(--bronze)}.pb.r{color:var(--muted)}
.podium{display:flex;justify-content:center;align-items:flex-end;gap:14px;flex-wrap:wrap}
.pod{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:20px 18px;text-align:center;min-width:186px}
.pod.pod-1{border-color:var(--gold);box-shadow:0 0 24px #f0a50033;order:2;min-height:175px}
.pod.pod-2{border-color:var(--silver);order:1;min-height:148px}
.pod.pod-3{border-color:var(--bronze);order:3;min-height:125px}
.pod.pod-empty{opacity:.35}
.pod-medal{font-size:34px;margin-bottom:8px}
.pod-name{font-size:15px;font-weight:700;margin-bottom:4px}
.pod-pts{font-size:22px;font-weight:800;color:var(--gold);margin-bottom:4px}
.pod-stats{font-size:11px;color:var(--muted)}
.tw{overflow-x:auto;border-radius:var(--r);border:1px solid var(--bd)}
table{width:100%;border-collapse:collapse;background:var(--sf)}
th{background:var(--sf2);padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.07em;color:var(--muted);text-align:left;border-bottom:1px solid var(--bd);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--bd);font-size:13px}
tr:last-child td{border-bottom:none}
tr.r1 td{background:#1a1200}tr.r2 td{background:#141a1f}tr.r3 td{background:#0e1610}
.tc{text-align:center}.tn{font-weight:600}
.tp{font-weight:800;color:var(--gold);font-size:15px}
.wrb{display:flex;align-items:center;gap:8px;min-width:110px}
.wrf{height:6px;border-radius:3px;background:var(--green);min-width:2px}
.wrb span{font-size:12px;color:var(--muted);flex-shrink:0}
.tc-card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:14px;overflow:hidden}
.tc-hdr{display:flex;align-items:baseline;justify-content:space-between;
  padding:14px 18px;border-bottom:1px solid var(--bd);flex-wrap:wrap;gap:8px}
.tc-name{font-weight:700;font-size:15px}.tc-meta{font-size:12px;color:var(--muted)}
.tc-pod{display:flex;gap:14px;padding:12px 18px;flex-wrap:wrap}
.pl{font-size:13px;font-weight:600}
.pl.gold{color:var(--gold)}.pl.silver{color:var(--silver)}.pl.bronze{color:var(--bronze)}
details summary{cursor:pointer;padding:10px 18px;font-size:12px;color:var(--muted);
  border-top:1px solid var(--bd);list-style:none;display:flex;align-items:center;gap:6px;user-select:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:'▶';font-size:10px;transition:transform .2s}
details[open] summary::before{transform:rotate(90deg)}
.br-area{padding:16px 18px 20px;overflow-x:auto}
.mtw{padding:0 18px 16px;overflow-x:auto}
.mt{width:100%;border-collapse:collapse;font-size:12px}
.mt th{background:var(--sf2);padding:5px 10px;text-align:left;border-bottom:1px solid var(--bd);
  font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.mt td{padding:5px 10px;border-bottom:1px solid var(--bd)}
.mt tr:last-child td{border-bottom:none}
.wc{color:var(--green);font-weight:600}
.bdg{font-size:9px;background:var(--sf2);border:1px solid var(--bd);border-radius:3px;
  padding:1px 5px;margin-left:5px;color:var(--muted);vertical-align:middle}
.rl{font-size:11px;color:var(--blue)}
.br-wrap{display:flex;gap:12px;align-items:flex-start;padding-bottom:4px}
.br-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.c-blue{color:var(--blue)}.c-red{color:var(--red)}.c-gold{color:var(--gold)}
.br-round{flex-shrink:0;min-width:136px}
.rn{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);text-align:center;margin-bottom:8px}
.mc{border:1px solid var(--bd);border-radius:5px;overflow:hidden;margin-bottom:10px}
.ms{padding:5px 9px;font-size:12px;border-bottom:1px solid var(--bd)}
.ms:last-child{border-bottom:none}
.ms.winner{background:#1a3d1a;color:var(--green)}
.ms.loser{background:#3d1a1a;color:var(--muted);text-decoration:line-through}
.ms.bye,.ms.tbd{color:var(--muted);font-style:italic;font-size:11px}
footer{text-align:center;padding:32px 0;color:var(--muted);font-size:12px;
  border-top:1px solid var(--bd);margin-top:48px}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🏆 LWG Tournament Leaderboard</h1>
  <p>Updated ${now} · ${players.length} players · ${tournaments.length} tournament${tournaments.length!==1?'s':''}</p>
</header>
${players.length===0?`<div style="text-align:center;padding:80px 20px;color:var(--muted)">
  <div style="font-size:40px;margin-bottom:12px">📋</div><div>No tournament data yet.</div>
</div>`:`
<section>
  <div class="st">🏅 All-Time Standings</div>
  <div class="pts-leg">
    <span class="pb g">🥇 1st = 10 pts</span><span class="pb s">🥈 2nd = 5 pts</span>
    <span class="pb b">🥉 3rd = 2 pts</span><span class="pb r">Participated = 1 pt</span>
  </div>
  <div class="podium">
    ${podCard(podium[1]||null,2)}${podCard(podium[0]||null,1)}${podCard(podium[2]||null,3)}
  </div>
</section>
<section>
  <div class="st">📊 Full Rankings</div>
  <div class="tw"><table>
    <thead><tr><th>#</th><th>Player</th><th>Points</th><th>🏆 Titles</th>
      <th>🥉 Top 3</th><th>Wins</th><th>Losses</th><th>Matches</th><th>Win Rate</th><th>Tourneys</th></tr></thead>
    <tbody>${tRows}</tbody>
  </table></div>
</section>
<section>
  <div class="st">📅 Tournament History</div>
  ${histHTML||'<p class="muted">No tournaments yet.</p>'}
</section>`}
<footer>LWG Tournament Bot · ${now}</footer>
</div>
</body>
</html>`;
}

// ── Export to local file ─────────────────────────────────
function exportToFile(outputPath) {
  const data = loadData();
  const html = generateHTML(data);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  return outputPath;
}

// ── Publish to GitHub ────────────────────────────────────
// Writes the leaderboard HTML into a cloned git repo and pushes.
//
// Setup (one-time, manual):
//   1. git clone https://github.com/YOU/REPO.git  C:\path\to\your\repo
//   2. Configure auth: either SSH key or run:
//      git config credential.helper store
//      git push  (enter credentials once — stored permanently)
//   3. Set repoDir in Settings to C:\path\to\your\repo
//
// Your server: just runs  `git pull`  on a cron/webhook — serves index.html as static.
//
function publishToGitHub({ repoDir, branch = 'main', filename = 'index.html', commitMessage } = {}) {
  if (!repoDir)                    throw new Error('publishToGitHub: repoDir is required');
  if (!fs.existsSync(repoDir))     throw new Error(`publishToGitHub: repoDir not found: ${repoDir}`);
  if (!fs.existsSync(path.join(repoDir, '.git')))
    throw new Error(`publishToGitHub: ${repoDir} is not a git repository`);

  const data    = loadData();
  const html    = generateHTML(data);
  const outFile = path.join(repoDir, filename);

  fs.writeFileSync(outFile, html, 'utf8');

  const msg  = (commitMessage || `leaderboard update ${new Date().toISOString().slice(0,16).replace('T',' ')}`).replace(/"/g,"'");
  const opts = { cwd: repoDir, stdio: 'pipe' };

  try {
    execSync(`git add "${filename}"`, opts);
    const diff = execSync('git diff --cached --stat', opts).toString().trim();
    if (!diff) {
      console.log('[leaderboard] Nothing changed — skipping push.');
      return { pushed: false, reason: 'no_changes' };
    }
    execSync(`git commit -m "${msg}"`, opts);
    execSync(`git push origin ${branch}`, opts);
    console.log(`[leaderboard] ✓ Pushed to GitHub → ${branch}/${filename}`);
    return { pushed: true };
  } catch (e) {
    const stderr = (e.stderr?.toString() || e.message).split('\n')[0];
    console.error('[leaderboard] GitHub push failed:', stderr);
    throw new Error('GitHub push failed: ' + stderr);
  }
}

module.exports = { recordTournament, exportToFile, generateHTML, loadData, publishToGitHub };
