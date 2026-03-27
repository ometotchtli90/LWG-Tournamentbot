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
  const now = new Date().toLocaleString();
  const latest = tournaments[0] || null;

  // ── Bracket renderer ──────────────────────────────────
  function matchCardHTML(m, isActive) {
    if(!m) return '';
    const p1=m.p1||'TBD', p2=m.p2||'TBD', w=m.winner;
    const slot = (name) => {
      const isBye = name==='BYE', isTbd = !name||name==='TBD';
      const cls = isBye||isTbd ? 'tbd' : w===name ? 'win' : w ? 'lose' : '';
      return `<div class="bslot ${cls}"><span class="bname">${esc(name)}</span>${w===name?'<span class="btrophy">🏆</span>':''}</div>`;
    };
    return `<div class="bmatch${isActive&&!w?' active':''}">${slot(p1)}${slot(p2)}</div>`;
  }

  function roundHTML(title, matches, cls='') {
    return `<div class="bround ${cls}">
      <div class="bround-title">${esc(title)}</div>
      <div class="bround-matches">${(matches||[]).map(m=>matchCardHTML(m,true)).join('')}</div>
    </div>`;
  }

  function bracketHTML(t) {
    if(!t||!t.bracket) return '<p class="no-data">No bracket data.</p>';
    const fmt = t.bracket.format;
    if(fmt==='single_elimination') {
      const total = t.bracket.rounds?.length||1;
      return `<div class="bracket-tree">${(t.bracket.rounds||[]).map((r,ri)=>{
        const n=total-ri;
        const nm = n===1?'Final':n===2?'Semi-Finals':n===3?'Quarter-Finals':`Round ${ri+1}`;
        const cls = r.every(m=>m.winner)?'done':r.some(m=>!m.winner&&m.p1&&m.p2)?'current':'upcoming';
        return roundHTML(nm,r,cls);
      }).join('')}</div>`;
    }
    if(fmt==='double_elimination') {
      return `<div class="bracket-section">
        <div class="bracket-section-label wb">Winner Bracket</div>
        <div class="bracket-tree">${(t.bracket.wb||[]).map((r,i)=>roundHTML(`WB Round ${i+1}`,r)).join('')}</div>
        <div class="bracket-section-label lb">Loser Bracket</div>
        <div class="bracket-tree">${(t.bracket.lb||[]).map((r,i)=>roundHTML(`LB Round ${i+1}`,r)).join('')}</div>
        ${t.bracket.gf?`<div class="bracket-section-label gf">Grand Final</div>
        <div class="bracket-tree">${roundHTML('Grand Final',t.bracket.gf,'gf-round')}</div>`:''}
      </div>`;
    }
    return '';
  }

  // ── Podium HTML ────────────────────────────────────────
  const top3 = players.slice(0,3);
  function podHTML(p, rank) {
    const icons=['🥇','🥈','🥉'];
    const labels=['CHAMPION','RUNNER-UP','3RD PLACE'];
    if(!p) return `<div class="pod pod-${rank} pod-empty"><div class="pod-icon">${icons[rank-1]}</div><div class="pod-empty-label">—</div></div>`;
    const barW = rank===1?100:rank===2?Math.round((top3[1]?.points||0)/(top3[0]?.points||1)*100):Math.round((top3[2]?.points||0)/(top3[0]?.points||1)*100);
    return `<div class="pod pod-${rank}">
      <div class="pod-label">${labels[rank-1]}</div>
      <div class="pod-icon">${icons[rank-1]}</div>
      <div class="pod-name">${esc(p.name)}</div>
      <div class="pod-pts">${p.points}<span class="pod-pts-label">pts</span></div>
      <div class="pod-bar"><div class="pod-bar-fill" style="width:${barW}%"></div></div>
      <div class="pod-sub">${p.titles} title${p.titles!==1?'s':''} &nbsp;·&nbsp; ${p.wins}W ${p.losses}L &nbsp;·&nbsp; ${p.winRate}% WR</div>
    </div>`;
  }

  // ── Standings rows ────────────────────────────────────
  const maxPts = players[0]?.points || 1;
  const standRows = players.map((p,i) => {
    const bar = Math.round((p.points/maxPts)*100);
    const rank = i===0?'gold':i===1?'silver':i===2?'bronze':'';
    return `<tr class="srow ${rank}" style="--anim-delay:${i*30}ms">
      <td class="srank">${i<3?['🥇','🥈','🥉'][i]:`<span class="ranknum">${i+1}</span>`}</td>
      <td class="sname">${esc(p.name)}</td>
      <td class="spts"><span class="pts-val">${p.points}</span></td>
      <td class="sbar"><div class="pts-bar"><div class="pts-bar-fill" style="width:${bar}%"></div></div></td>
      <td class="scenter">${p.titles}</td>
      <td class="scenter">${p.wins}</td>
      <td class="scenter">${p.losses}</td>
      <td class="scenter">${p.matches>0?p.winRate+'%':'—'}</td>
      <td class="scenter">${p.tourneysPlayed}</td>
    </tr>`;
  }).join('');

  // ── Tournament history cards ──────────────────────────
  const histHTML = tournaments.map((t,ti) => {
    const d = new Date(t.date).toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
    const fmt = {single_elimination:'Single Elimination',double_elimination:'Double Elimination',swiss:'Swiss'}[t.format]||t.format||'';
    const mrows = (t.matchLog||[]).filter(m=>m.winner&&m.winner!=='BYE').map(m=>{
      const badge = m.method!=='gg'?`<span class="mbadge">${esc(m.method)}</span>`:'';
      return `<tr><td class="mround">${esc(m.round||'')}</td><td>${esc(m.p1||'')}</td>
        <td class="mvsep">vs</td><td>${esc(m.p2||'')}</td>
        <td class="mwinner">${esc(m.winner)}${badge}</td></tr>`;
    }).join('');
    const matchCount = (t.matchLog||[]).filter(m=>m.winner&&m.winner!=='BYE').length;
    return `<div class="tcard" style="--anim-delay:${ti*50}ms">
      <div class="tcard-head">
        <div class="tcard-left">
          <div class="tcard-name">${esc(t.name)}</div>
          <div class="tcard-meta">${fmt} &nbsp;·&nbsp; ${d} &nbsp;·&nbsp; ${(t.players||[]).length} players</div>
        </div>
        <div class="tcard-places">
          ${t.champion?`<span class="tplace gold">🥇 ${esc(t.champion)}</span>`:''}
          ${t.second  ?`<span class="tplace silver">🥈 ${esc(t.second)}</span>`:''}
          ${t.third   ?`<span class="tplace bronze">🥉 ${esc(t.third)}</span>`:''}
        </div>
      </div>
      <div class="tcard-body">
        <details class="tdetails">
          <summary><span class="det-icon">⚔</span> Match Results <span class="det-count">${matchCount}</span></summary>
          <div class="mtable-wrap">
            <table class="mtable">
              <thead><tr><th>Round</th><th>Player 1</th><th></th><th>Player 2</th><th>Winner</th></tr></thead>
              <tbody>${mrows}</tbody>
            </table>
          </div>
        </details>
        <details class="tdetails">
          <summary><span class="det-icon">🏆</span> Bracket</summary>
          <div class="bracket-wrap">${bracketHTML(t)}</div>
        </details>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LWG Tournament Leaderboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ── Reset & Base ─────────────────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root {
  --bg:        #080b10;
  --bg2:       #0d1219;
  --bg3:       #121820;
  --panel:     #141c26;
  --panel2:    #1a2333;
  --border:    #1f2d40;
  --border2:   #263547;
  --gold:      #f5a623;
  --gold2:     #ffcb6b;
  --silver:    #9baab8;
  --bronze:    #c8835a;
  --green:     #34d399;
  --red:       #f87171;
  --blue:      #60a5fa;
  --purple:    #a78bfa;
  --text:      #e8eef5;
  --text2:     #8fa0b5;
  --text3:     #4f6070;
  --font-head: 'Bebas Neue', sans-serif;
  --font-body: 'DM Sans', sans-serif;
  --font-mono: 'DM Mono', monospace;
}
html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.6;
  min-height: 100vh;
}

/* ── Noise texture overlay ───────────────────────────── */
body::before {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
  opacity:.4;
}

/* ── Sticky nav ──────────────────────────────────────── */
nav {
  position: sticky; top: 0; z-index: 100;
  background: rgba(8,11,16,0.85);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  padding: 0 40px;
  display: flex; align-items: center; gap: 0;
}
.nav-logo {
  font-family: var(--font-head);
  font-size: 26px; letter-spacing: 2px;
  color: var(--gold); margin-right: 32px;
  text-decoration: none;
  white-space: nowrap;
}
.nav-logo span { color: var(--text2); font-size: 20px; }
.nav-links { display:flex; gap:0; flex:1; }
.nav-link {
  padding: 18px 20px;
  font-size: 13px; font-weight: 600;
  letter-spacing: .07em; text-transform: uppercase;
  color: var(--text3); text-decoration: none;
  border-bottom: 3px solid transparent;
  transition: color .2s, border-color .2s;
}
.nav-link:hover { color: var(--text); border-color: var(--border2); }
.nav-link.active { color: var(--gold); border-color: var(--gold); }
.nav-updated {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text3); white-space: nowrap;
}

/* ── Hero ────────────────────────────────────────────── */
.hero {
  position: relative; overflow: hidden;
  padding: 80px 40px 60px;
  text-align: center;
  background: linear-gradient(180deg, #0d1a2e 0%, var(--bg) 100%);
  border-bottom: 1px solid var(--border);
}
.hero::before {
  content:''; position:absolute; inset:0;
  background: radial-gradient(ellipse 70% 60% at 50% 0%, rgba(245,166,35,.08) 0%, transparent 70%);
  pointer-events:none;
}
.hero-eyebrow {
  font-family: var(--font-mono); font-size: 12px; letter-spacing: .25em;
  text-transform: uppercase; color: var(--gold); margin-bottom: 16px;
}
.hero-title {
  font-family: var(--font-head);
  font-size: clamp(56px, 8vw, 96px);
  letter-spacing: 6px; line-height: 1;
  color: var(--text);
}
.hero-title span { color: var(--gold); }
.hero-sub {
  margin-top: 16px; font-size: 16px;
  color: var(--text2); font-weight: 300;
}
.hero-stats {
  display: flex; justify-content: center; gap: 48px;
  margin-top: 40px; flex-wrap: wrap;
}
.hstat { text-align: center; }
.hstat-val {
  font-family: var(--font-head);
  font-size: 40px; letter-spacing: 2px; color: var(--gold);
  line-height: 1;
}
.hstat-label {
  font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--text3); margin-top: 4px;
}

/* ── Section layout ──────────────────────────────────── */
.page-section {
  max-width: 1300px; margin: 0 auto;
  padding: 64px 40px;
}
.page-section + .page-section {
  border-top: 1px solid var(--border);
}
.section-header {
  display: flex; align-items: baseline;
  gap: 16px; margin-bottom: 40px;
}
.section-title {
  font-family: var(--font-head);
  font-size: 42px; letter-spacing: 3px;
  color: var(--text); line-height: 1;
}
.section-title span { color: var(--gold); }
.section-count {
  font-family: var(--font-mono); font-size: 13px;
  color: var(--text3); padding: 3px 10px;
  border: 1px solid var(--border2); border-radius: 20px;
}
.section-desc {
  font-size: 14px; color: var(--text2);
  margin-top: 8px;
}

/* ── Points legend ───────────────────────────────────── */
.pts-legend {
  display: inline-flex; gap: 8px; flex-wrap: wrap;
  margin-bottom: 40px;
  padding: 12px 16px;
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 10px;
}
.ptag {
  font-family: var(--font-mono); font-size: 12px;
  font-weight: 500; padding: 4px 12px; border-radius: 20px;
}
.ptag.g { background: rgba(245,166,35,.12); color: var(--gold);   border: 1px solid rgba(245,166,35,.3); }
.ptag.s { background: rgba(155,170,184,.1);  color: var(--silver); border: 1px solid rgba(155,170,184,.3); }
.ptag.b { background: rgba(200,131,90,.1);   color: var(--bronze); border: 1px solid rgba(200,131,90,.3); }
.ptag.n { background: var(--bg3); color: var(--text3); border: 1px solid var(--border); }

/* ── Podium ──────────────────────────────────────────── */
.podium-wrap {
  display: grid;
  grid-template-columns: 1fr 1.15fr 1fr;
  gap: 16px; margin-bottom: 64px;
  align-items: end;
}
.pod {
  border-radius: 16px; padding: 32px 24px;
  text-align: center; position: relative;
  overflow: hidden;
  transition: transform .3s;
}
.pod:hover { transform: translateY(-4px); }
.pod::before {
  content:''; position:absolute; inset:0;
  background: linear-gradient(180deg, rgba(255,255,255,.03) 0%, transparent 100%);
  pointer-events:none;
}
.pod-1 { background: linear-gradient(145deg, #1a1500, #241c00); border: 1px solid rgba(245,166,35,.35); box-shadow: 0 0 40px rgba(245,166,35,.1); }
.pod-2 { background: linear-gradient(145deg, #111820, #0f1520); border: 1px solid rgba(155,170,184,.25); }
.pod-3 { background: linear-gradient(145deg, #160f0a, #120d08); border: 1px solid rgba(200,131,90,.25); }
.pod-empty { background: var(--panel); border: 1px solid var(--border); opacity:.35; }
.pod-label {
  font-family: var(--font-mono); font-size: 10px;
  letter-spacing: .2em; text-transform: uppercase;
  color: var(--text3); margin-bottom: 12px;
}
.pod-1 .pod-label { color: rgba(245,166,35,.6); }
.pod-icon { font-size: 44px; margin-bottom: 14px; }
.pod-name { font-size: 22px; font-weight: 700; letter-spacing: -.3px; margin-bottom: 6px; }
.pod-1 .pod-name { font-size: 26px; }
.pod-pts {
  font-family: var(--font-head); font-size: 52px;
  letter-spacing: 2px; line-height: 1; color: var(--gold);
}
.pod-1 .pod-pts { font-size: 64px; }
.pod-pts-label { font-family: var(--font-body); font-size: 14px; font-weight: 300; color: var(--text3); margin-left: 4px; }
.pod-bar { height: 3px; background: var(--border2); border-radius: 2px; margin: 14px 0 10px; }
.pod-bar-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, var(--gold), var(--gold2)); transition: width 1s .3s; }
.pod-sub { font-size: 12px; color: var(--text3); }
.pod-empty-label { font-size: 28px; color: var(--text3); margin-top: 20px; }

/* ── Standings table ─────────────────────────────────── */
.standings-wrap {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px; overflow: hidden;
}
.standings-table {
  width: 100%; border-collapse: collapse;
}
.standings-table thead tr {
  background: var(--panel2);
  border-bottom: 2px solid var(--border2);
}
.standings-table th {
  padding: 14px 20px;
  font-family: var(--font-mono); font-size: 11px;
  letter-spacing: .1em; text-transform: uppercase;
  color: var(--text3); font-weight: 500;
  text-align: left; white-space: nowrap;
}
.standings-table th.scenter { text-align: center; }
.standings-table tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background .15s;
  animation: fadeSlide .4s both;
  animation-delay: var(--anim-delay, 0ms);
}
.standings-table tbody tr:last-child { border-bottom: none; }
.standings-table tbody tr:hover { background: rgba(255,255,255,.025); }
.standings-table td { padding: 16px 20px; }
.srow.gold  td:first-child ~ td:nth-child(3) .pts-val { color: var(--gold); }
.srow.gold  { background: rgba(245,166,35,.04); }
.srow.silver{ background: rgba(155,170,184,.03); }
.srow.bronze{ background: rgba(200,131,90,.03); }
.srank { width: 52px; font-size: 20px; text-align: center; }
.ranknum { font-family: var(--font-mono); font-size: 14px; color: var(--text3); }
.sname { font-size: 16px; font-weight: 600; min-width: 160px; }
.spts { width: 80px; }
.pts-val {
  font-family: var(--font-head); font-size: 26px;
  letter-spacing: 1px; color: var(--gold);
}
.sbar { min-width: 160px; }
.pts-bar { height: 6px; background: var(--border2); border-radius: 3px; overflow: hidden; }
.pts-bar-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--gold), var(--gold2)); }
.scenter { text-align: center; font-family: var(--font-mono); font-size: 14px; color: var(--text2); }

/* ── Tournament cards ─────────────────────────────────── */
.tcards { display: flex; flex-direction: column; gap: 20px; }
.tcard {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px; overflow: hidden;
  animation: fadeSlide .5s both;
  animation-delay: var(--anim-delay, 0ms);
  transition: border-color .2s;
}
.tcard:hover { border-color: var(--border2); }
.tcard-head {
  display: flex; align-items: center;
  justify-content: space-between; flex-wrap: wrap;
  gap: 16px; padding: 24px 28px;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(90deg, var(--panel2), var(--panel));
}
.tcard-name { font-size: 20px; font-weight: 700; letter-spacing: -.2px; }
.tcard-meta { font-size: 13px; color: var(--text3); margin-top: 3px; font-family: var(--font-mono); }
.tcard-places { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.tplace { font-size: 14px; font-weight: 600; padding: 6px 14px; border-radius: 8px; }
.tplace.gold   { background: rgba(245,166,35,.12); color: var(--gold);   border: 1px solid rgba(245,166,35,.25); }
.tplace.silver { background: rgba(155,170,184,.1);  color: var(--silver); border: 1px solid rgba(155,170,184,.2); }
.tplace.bronze { background: rgba(200,131,90,.1);   color: var(--bronze); border: 1px solid rgba(200,131,90,.2); }
.tcard-body { padding: 0; }
.tdetails { border-top: 1px solid var(--border); }
.tdetails:first-child { border-top: none; }
.tdetails > summary {
  cursor: pointer; list-style: none;
  padding: 16px 28px; font-size: 14px; font-weight: 600;
  color: var(--text2); display: flex; align-items: center;
  gap: 10px; user-select: none;
  transition: color .15s, background .15s;
}
.tdetails > summary::-webkit-details-marker { display: none; }
.tdetails > summary:hover { color: var(--text); background: rgba(255,255,255,.025); }
.tdetails[open] > summary { color: var(--text); }
.tdetails > summary::after {
  content: '▸'; margin-left: auto; font-size: 12px;
  transition: transform .2s; color: var(--text3);
}
.tdetails[open] > summary::after { transform: rotate(90deg); }
.det-icon { font-size: 16px; }
.det-count {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text3); padding: 2px 8px;
  border: 1px solid var(--border2); border-radius: 10px;
  margin-left: 4px;
}

/* ── Match table ─────────────────────────────────────── */
.mtable-wrap { padding: 0 28px 24px; overflow-x: auto; }
.mtable { width: 100%; border-collapse: collapse; font-size: 14px; }
.mtable th {
  padding: 8px 14px; background: var(--bg3);
  font-size: 11px; font-family: var(--font-mono);
  letter-spacing: .08em; text-transform: uppercase;
  color: var(--text3); text-align: left;
  border-bottom: 1px solid var(--border);
}
.mtable td { padding: 10px 14px; border-bottom: 1px solid var(--border); }
.mtable tr:last-child td { border-bottom: none; }
.mtable tr:hover td { background: rgba(255,255,255,.015); }
.mround { font-family: var(--font-mono); font-size: 12px; color: var(--text3); }
.mvsep  { text-align: center; color: var(--text3); font-size: 12px; font-family: var(--font-mono); }
.mwinner { font-weight: 700; color: var(--green); }
.mbadge {
  font-size: 10px; font-family: var(--font-mono);
  background: var(--bg3); border: 1px solid var(--border2);
  border-radius: 4px; padding: 1px 6px; margin-left: 6px;
  color: var(--text3); vertical-align: middle;
}

/* ── Bracket ─────────────────────────────────────────── */
.bracket-wrap { padding: 24px 28px; overflow-x: auto; }
.bracket-tree { display: flex; gap: 20px; align-items: flex-start; padding-bottom: 8px; }
.bracket-section { display: flex; flex-direction: column; gap: 0; }
.bracket-section-label {
  font-family: var(--font-mono); font-size: 11px;
  letter-spacing: .15em; text-transform: uppercase;
  padding: 10px 0 8px; font-weight: 600;
}
.bracket-section-label.wb { color: var(--blue); }
.bracket-section-label.lb { color: var(--red);  margin-top: 20px; }
.bracket-section-label.gf { color: var(--gold); margin-top: 20px; }
.bround { flex-shrink: 0; min-width: 170px; }
.bround-title {
  font-family: var(--font-mono); font-size: 11px;
  letter-spacing: .1em; text-transform: uppercase;
  color: var(--text3); text-align: center;
  padding: 6px 4px 12px; font-weight: 500;
}
.bround.current .bround-title { color: var(--gold); }
.bround.done    .bround-title { color: var(--green); }
.bround-matches { display: flex; flex-direction: column; gap: 10px; }
.bmatch {
  border: 1px solid var(--border);
  border-radius: 10px; overflow: hidden;
  background: var(--bg3);
  transition: border-color .2s;
}
.bmatch.active { border-color: rgba(245,166,35,.4); box-shadow: 0 0 12px rgba(245,166,35,.08); }
.bslot {
  display: flex; align-items: center;
  justify-content: space-between;
  padding: 9px 14px; font-size: 13px;
  border-bottom: 1px solid var(--border);
  gap: 8px;
}
.bslot:last-child { border-bottom: none; }
.bslot.win  { background: rgba(52,211,153,.08); }
.bslot.lose { background: rgba(248,113,113,.05); }
.bslot.tbd  { color: var(--text3); font-style: italic; font-size: 12px; }
.bname { flex: 1; font-weight: 500; }
.bslot.win .bname  { font-weight: 700; color: var(--green); }
.bslot.lose .bname { color: var(--text3); text-decoration: line-through; }
.btrophy { font-size: 12px; flex-shrink: 0; }

/* ── Latest bracket live section ─────────────────────── */
.live-badge {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--font-mono); font-size: 11px; letter-spacing: .15em;
  text-transform: uppercase; color: var(--green);
  padding: 5px 12px; border-radius: 20px;
  background: rgba(52,211,153,.1); border: 1px solid rgba(52,211,153,.3);
  margin-left: 16px; vertical-align: middle;
}
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green);
  animation: pulse 2s infinite;
}

/* ── Animations ──────────────────────────────────────── */
@keyframes fadeSlide {
  from { opacity:0; transform: translateY(12px); }
  to   { opacity:1; transform: translateY(0); }
}
@keyframes pulse {
  0%,100% { opacity:1; transform: scale(1); }
  50%      { opacity:.4; transform: scale(.8); }
}

/* ── Empty state ─────────────────────────────────────── */
.empty-state {
  text-align: center; padding: 100px 20px;
  color: var(--text3);
}
.empty-icon { font-size: 56px; margin-bottom: 16px; }
.empty-text { font-size: 18px; }

/* ── Footer ──────────────────────────────────────────── */
footer {
  text-align: center; padding: 40px 20px;
  color: var(--text3); font-size: 13px;
  font-family: var(--font-mono);
  border-top: 1px solid var(--border);
}

/* ── Responsive ──────────────────────────────────────── */
@media(max-width:900px){
  .podium-wrap { grid-template-columns: 1fr; }
  .pod-1 { order: -1; }
  nav { padding: 0 20px; }
  .page-section { padding: 48px 20px; }
  .hero { padding: 60px 20px 48px; }
}
@media(max-width:600px){
  .hero-title { font-size: 48px; }
  .standings-table th:nth-child(n+6),
  .standings-table td:nth-child(n+6) { display: none; }
}
</style>
</head>
<body>

<!-- ── Nav ─────────────────────────────────────────────── -->
<nav>
  <a href="#" class="nav-logo">LWG <span>TOURNEY</span></a>
  <div class="nav-links">
    <a href="#standings" class="nav-link active">Standings</a>
    <a href="#bracket"   class="nav-link">Bracket</a>
    <a href="#history"   class="nav-link">History</a>
  </div>
  <span class="nav-updated">Updated ${now}</span>
</nav>

<!-- ── Hero ────────────────────────────────────────────── -->
<div class="hero">
  <div class="hero-eyebrow">LittleWarGame Tournament Series</div>
  <h1 class="hero-title">LEADER<span>BOARD</span></h1>
  <p class="hero-sub">All-time standings, live brackets &amp; tournament history</p>
  <div class="hero-stats">
    <div class="hstat"><div class="hstat-val">${players.length}</div><div class="hstat-label">Players</div></div>
    <div class="hstat"><div class="hstat-val">${tournaments.length}</div><div class="hstat-label">Tournaments</div></div>
    <div class="hstat"><div class="hstat-val">${players.reduce((s,p)=>s+p.matches,0)}</div><div class="hstat-label">Matches Played</div></div>
    <div class="hstat"><div class="hstat-val">${players[0]?.name||'—'}</div><div class="hstat-label">Points Leader</div></div>
  </div>
</div>

${players.length===0 ? `
<div class="empty-state">
  <div class="empty-icon">🏆</div>
  <div class="empty-text">No tournament data yet.<br>Complete a tournament and publish to see results.</div>
</div>
` : `

<!-- ── Standings ──────────────────────────────────────── -->
<section class="page-section" id="standings">
  <div class="section-header">
    <div>
      <div class="section-title">STAND<span>INGS</span></div>
      <div class="section-desc">All-time points across every tournament played</div>
    </div>
    <span class="section-count">${players.length} players</span>
  </div>

  <div class="pts-legend">
    <span class="ptag g">🥇 1st place = 10 pts</span>
    <span class="ptag s">🥈 2nd place = 5 pts</span>
    <span class="ptag b">🥉 3rd place = 2 pts</span>
    <span class="ptag n">Participated = 1 pt</span>
  </div>

  <div class="podium-wrap">
    ${podHTML(players[1]||null,2)}
    ${podHTML(players[0]||null,1)}
    ${podHTML(players[2]||null,3)}
  </div>

  <div class="standings-wrap">
    <table class="standings-table">
      <thead>
        <tr>
          <th class="scenter">#</th>
          <th>Player</th>
          <th>Points</th>
          <th style="min-width:160px">Progress</th>
          <th class="scenter">Titles</th>
          <th class="scenter">Wins</th>
          <th class="scenter">Losses</th>
          <th class="scenter">Win %</th>
          <th class="scenter">Tourneys</th>
        </tr>
      </thead>
      <tbody>${standRows}</tbody>
    </table>
  </div>
</section>

<!-- ── Latest Bracket ─────────────────────────────────── -->
<section class="page-section" id="bracket">
  <div class="section-header">
    <div>
      <div class="section-title">BRACK<span>ET</span>
        ${latest ? `<span class="live-badge"><span class="live-dot"></span>Latest</span>` : ''}
      </div>
      <div class="section-desc">${latest ? `${esc(latest.name)} · ${new Date(latest.date).toLocaleDateString('de-DE')}` : 'No tournament played yet'}</div>
    </div>
  </div>
  ${latest ? `<div class="bracket-wrap" style="padding:0">${bracketHTML(latest)}</div>` : '<p style="color:var(--text3)">No bracket data available.</p>'}
</section>

<!-- ── Tournament History ──────────────────────────────── -->
<section class="page-section" id="history">
  <div class="section-header">
    <div>
      <div class="section-title">HIST<span>ORY</span></div>
      <div class="section-desc">All past tournaments, results &amp; brackets</div>
    </div>
    <span class="section-count">${tournaments.length} tournaments</span>
  </div>
  <div class="tcards">
    ${histHTML || '<p style="color:var(--text3)">No tournament history yet.</p>'}
  </div>
</section>

`}

<footer>LWG Tournament Bot &nbsp;·&nbsp; ${now}</footer>

<script>
// Highlight active nav link on scroll
const sections = document.querySelectorAll('.page-section[id]');
const navLinks  = document.querySelectorAll('.nav-link');
const observer  = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if(e.isIntersecting) {
      navLinks.forEach(l => l.classList.remove('active'));
      const active = document.querySelector('.nav-link[href="#'+e.target.id+'"]');
      if(active) active.classList.add('active');
    }
  });
}, { rootMargin: '-40% 0px -55% 0px' });
sections.forEach(s => observer.observe(s));
</script>
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
// Writes data.json into the repo and pushes it.
// The index.html is permanent in the repo — only data.json changes.
//
// Supports two branch modes:
//   - Same branch as working tree: normal commit + push
//   - Different branch (e.g. gh-pages): uses git worktree
//
function publishToGitHub({ repoDir, branch = 'main', filename = 'data.json', commitMessage } = {}) {
  if (!repoDir)                throw new Error('publishToGitHub: repoDir is required');
  if (!fs.existsSync(repoDir)) throw new Error(`publishToGitHub: repoDir not found: ${repoDir}`);
  if (!fs.existsSync(path.join(repoDir, '.git')))
    throw new Error(`publishToGitHub: ${repoDir} is not a git repository`);

  const data    = loadData();
  // Write data.json (not generated HTML — index.html is permanent in repo)
  const payload = JSON.stringify({ ...data, updatedAt: Date.now() }, null, 2);
  const msg     = (commitMessage || `data update ${new Date().toISOString().slice(0,16).replace('T',' ')}`).replace(/"/g,"'");
  const opts    = { cwd: repoDir, stdio: 'pipe' };

  // Detect current branch
  let currentBranch = 'main';
  try { currentBranch = execSync('git rev-parse --abbrev-ref HEAD', opts).toString().trim(); } catch (_) {}

  if (currentBranch === branch) {
    // ── Simple path: working tree IS the target branch ──
    fs.writeFileSync(path.join(repoDir, filename), payload, 'utf8');
    try {
      execSync(`git add "${filename}"`, opts);
      const diff = execSync('git diff --cached --stat', opts).toString().trim();
      if (!diff) { console.log('[leaderboard] No changes — skipping push.'); return { pushed: false, reason: 'no_changes' }; }
      execSync(`git commit -m "${msg}"`, opts);
      execSync(`git push origin ${branch}`, opts);
      console.log(`[leaderboard] ✓ Pushed ${filename} to ${branch}`);
      return { pushed: true };
    } catch (e) {
      throw new Error('GitHub push failed: ' + (e.stderr?.toString()||e.message).split('\n')[0]);
    }
  } else {
    // ── Cross-branch path: git worktree ──────────────────
    const wtDir = path.join(repoDir, '.git', '_lb_worktree');
    try {
      if (fs.existsSync(wtDir)) {
        try { execSync(`git worktree remove --force "${wtDir}"`, opts); } catch (_) {}
        try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch (_) {}
      }
      execSync(`git worktree add "${wtDir}" ${branch}`, opts);
      fs.writeFileSync(path.join(wtDir, filename), payload, 'utf8');
      const wtOpts = { cwd: wtDir, stdio: 'pipe' };
      execSync(`git add "${filename}"`, wtOpts);
      const diff = execSync('git diff --cached --stat', wtOpts).toString().trim();
      if (!diff) {
        execSync(`git worktree remove --force "${wtDir}"`, opts);
        console.log('[leaderboard] No changes — skipping push.');
        return { pushed: false, reason: 'no_changes' };
      }
      execSync(`git commit -m "${msg}"`, wtOpts);
      execSync(`git push origin ${branch}`, wtOpts);
      console.log(`[leaderboard] ✓ Pushed ${filename} to ${branch}`);
      execSync(`git worktree remove --force "${wtDir}"`, opts);
      return { pushed: true };
    } catch (e) {
      try { execSync(`git worktree remove --force "${wtDir}"`, opts); } catch (_) {}
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch (_) {}
      throw new Error('GitHub push failed: ' + (e.stderr?.toString()||e.message).split('\n')[0]);
    }
  }
}

module.exports = { recordTournament, exportToFile, generateHTML, loadData, publishToGitHub };
