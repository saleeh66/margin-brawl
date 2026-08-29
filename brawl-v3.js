/*
 * Margin Brawl — everything in one file.
 *
 * The fight rules, the Durable Object that referees them, and the entire
 * phone client are all below. Upload this file plus wrangler.jsonc and
 * package.json to a GitHub repo, point Cloudflare at the repo, and the game
 * is live at a permanent address. No computer needed after that.
 *
 * Built from the multi-file project by build.mjs — edit that, not this.
 */

import { DurableObject } from 'cloudflare:workers';

/* ============================================================
   1. The fight
   ============================================================ */
/* The fight itself. Imported by the LAN server (server.mjs) and by the
   Cloudflare Worker (worker/src/index.mjs) so both run identical rules. */

const W = 960, H = 300, GROUND = 254, WALL_L = 40, WALL_R = W - 40;
const MAXHP = 32;                 // punch = 1/32, kick = 2/32 = 1/16

const MOVES = {
  punch: { startup:5, active:5, recover:10, reach:58, dmg:1, kb:2.2, high:true  },
  kick:  { startup:9, active:6, recover:17, reach:82, dmg:2, kb:5.0, high:false }
};
const WORDS = ['POW','WHAP','THWK','BONK','KRAK','SMAK','OOF'];
const IDLE = { l:0, r:0, u:0, d:0, p:0, k:0 };

class Fighter {
  constructor(x, facing, sim){ this.sim = sim; this.reset(x, facing); }
  reset(x, facing){
    this.x = x; this.y = GROUND; this.vx = 0; this.vy = 0; this.facing = facing;
    this.hp = MAXHP; this.state = 'idle'; this.t = 0; this.anim = 0;
    this.move = null; this.hasHit = false; this.stun = 0; this.rot = 0;
  }
  set(s){ this.state = s; this.t = 0; }
  attack(name){
    const s = this.state;
    if (s === 'punch' || s === 'kick' || s === 'hit' || s === 'ko') return;
    this.move = MOVES[name]; this.hasHit = false; this.set(name);
    this.sim.ev.push({ k:'sw', n:name });
  }
  hurt(m, dir, who){
    this.hp -= m.dmg;
    this.vx += dir * m.kb; this.vy -= m.kb * .5;
    this.set('hit'); this.stun = m.dmg > 1 ? 20 : 15; this.move = null;
    this.sim.ev.push({ k:'hit', x:Math.round(this.x + dir * -14), y:Math.round(this.y - 62),
                       w:WORDS[(Math.random() * WORDS.length) | 0], big:m.dmg > 1, s:who });
    if (this.hp <= 0){ this.hp = 0; this.set('ko'); this.vx = dir * 3.4; this.vy = -6; }
  }
  step(inp, foe, who){
    this.anim++; this.t++;
    const grounded = this.y >= GROUND - .01;

    if (this.state === 'ko'){
      this.vy += .82; this.y += this.vy; this.x += this.vx; this.vx *= .9;
      if (this.y > GROUND){ this.y = GROUND; this.vy = 0; this.vx *= .5; }
      this.rot += (this.facing * -1.35 - this.rot) * .18;
      return;
    }
    this.rot += (0 - this.rot) * .3;
    if (this.state === 'hit' && --this.stun <= 0 && grounded) this.set('idle');

    const busy = this.state === 'punch' || this.state === 'kick' || this.state === 'hit';
    if (!busy) this.facing = foe.x < this.x ? -1 : 1;

    if (!busy){
      if (inp.d && grounded){
        if (this.state !== 'duck') this.set('duck');
        this.vx *= .5;
      } else {
        if (this.state === 'duck') this.set('idle');
        const want = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
        if (want){
          this.vx = want * 2.35 * (grounded ? 1 : .82);
          if (grounded && this.state !== 'jump') this.set('walk');
        } else {
          this.vx *= grounded ? .55 : .94;
          if (grounded && this.state === 'walk') this.set('idle');
        }
        if (inp.u && grounded){ this.vy = -12.2; this.set('jump'); this.sim.ev.push({ k:'jmp' }); }
        if (inp.p) this.attack('punch');
        else if (inp.k) this.attack('kick');
      }
    }

    this.vy += .74; this.y += this.vy; this.x += this.vx;
    if (this.y >= GROUND){
      this.y = GROUND; this.vy = 0;
      if (this.state === 'jump') this.set('idle');
    }
    this.x = Math.max(WALL_L, Math.min(WALL_R, this.x));

    const d = foe.x - this.x;
    if (Math.abs(d) < 32 && Math.abs(foe.y - this.y) < 60)
      this.x += (32 - Math.abs(d)) * .06 * (d > 0 ? -1 : 1);

    if ((this.state === 'punch' || this.state === 'kick') && this.move){
      const m = this.move;
      if (this.t > m.startup && this.t <= m.startup + m.active && !this.hasHit && foe.state !== 'ko'){
        const dx = (foe.x - this.x) * this.facing, dy = foe.y - this.y;
        if (dx > -6 && dx < m.reach + 20 && Math.abs(dy) < 76){
          this.hasHit = true;
          if (m.high && foe.state === 'duck')
            this.sim.ev.push({ k:'whiff', x:Math.round(foe.x), y:Math.round(foe.y - 104) });
          else
            foe.hurt(m, this.facing, who === 1 ? 2 : 1);
        }
      }
      if (this.t >= m.startup + m.active + m.recover){ this.move = null; this.set('idle'); }
    }
  }
}

class Sim {
  constructor(){
    this.a = new Fighter(W * .3, 1, this);
    this.b = new Fighter(W * .7, -1, this);
    this.ev = [];
    this.hardReset();
  }
  hardReset(){
    this.wins = [0, 0]; this.round = 1; this.phase = 'waiting';
    this.phaseT = 0; this.clock = 60; this.banner = ''; this.bannerSub = '';
    this.a.reset(W * .3, 1); this.b.reset(W * .7, -1);
  }
  startRound(){
    this.a.reset(W * .3, 1); this.b.reset(W * .7, -1);
    this.clock = 60; this.phase = 'intro'; this.phaseT = 0;
    this.banner = 'ROUND ' + this.round; this.bannerSub = '';
  }
  endRound(winner){
    this.phase = 'over'; this.phaseT = 0;
    if (winner === 1){ this.wins[0]++; this.banner = 'K.O.'; this.bannerSub = 'player 2 is out of ink'; }
    else if (winner === 2){ this.wins[1]++; this.banner = 'K.O.'; this.bannerSub = 'player 1 is out of ink'; }
    else {
      this.banner = 'TIME';
      if (this.a.hp > this.b.hp){ this.wins[0]++; this.bannerSub = 'player 1 has more ink left'; }
      else if (this.b.hp > this.a.hp){ this.wins[1]++; this.bannerSub = 'player 2 has more ink left'; }
      else this.bannerSub = 'dead even — nobody scores';
    }
    this.ev.push({ k:'ko' });
  }
  tick(i1, i2, ready){
    this.phaseT++;

    if (this.phase === 'waiting'){
      this.a.step(IDLE, this.b, 1); this.b.step(IDLE, this.a, 2);
      if (ready){ this.wins = [0, 0]; this.round = 1; this.startRound(); }
      return;
    }
    if (!ready && this.phase !== 'match'){ this.hardReset(); return; }

    if (this.phase === 'intro'){
      if (this.phaseT === 44){ this.banner = 'FIGHT!'; this.bannerSub = ''; this.ev.push({ k:'go' }); }
      if (this.phaseT > 78){ this.banner = ''; this.phase = 'fight'; this.phaseT = 0; }
      this.a.step(IDLE, this.b, 1); this.b.step(IDLE, this.a, 2);
      return;
    }
    if (this.phase === 'fight'){
      this.clock -= 1 / 60;
      this.a.step(i1, this.b, 1);
      this.b.step(i2, this.a, 2);
      if (this.b.hp <= 0) this.endRound(1);
      else if (this.a.hp <= 0) this.endRound(2);
      else if (this.clock <= 0){ this.clock = 0; this.endRound(0); }
      return;
    }
    if (this.phase === 'over'){
      this.a.step(IDLE, this.b, 1); this.b.step(IDLE, this.a, 2);
      if (this.phaseT > 130){
        if (this.wins[0] >= 2 || this.wins[1] >= 2){ this.phase = 'match'; this.banner = ''; this.phaseT = 0; }
        else { this.round++; this.startRound(); }
      }
      return;
    }
    if (this.phase === 'match'){
      this.a.step(IDLE, this.b, 1); this.b.step(IDLE, this.a, 2);
    }
  }
  pack(f){
    return { x:Math.round(f.x * 10) / 10, y:Math.round(f.y * 10) / 10,
             vy:Math.round(f.vy * 10) / 10, st:f.state, t:f.t, an:f.anim,
             ro:Math.round(f.rot * 100) / 100, hp:f.hp, fc:f.facing };
  }
  snapshot(){
    const s = {
      type:'s', ph:this.phase, bn:this.banner, bs:this.bannerSub,
      cl:Math.max(0, Math.ceil(this.clock)), w1:this.wins[0], w2:this.wins[1],
      rd:this.round, a:this.pack(this.a), b:this.pack(this.b)
    };
    if (this.ev.length){ s.e = this.ev; this.ev = []; }
    return s;
  }
}

/* turn a player's held-button message into one tick of input, consuming taps */
function consume(seat){
  const h = seat.held, t = seat.taps;
  const i = { l:h.l, r:h.r, d:h.d, u:t.u, p:t.p, k:t.k };
  t.u = t.p = t.k = 0;
  return i;
}
function applyInput(seat, msg){
  const h = seat.held;
  if (!h.u && msg.u) seat.taps.u = 1;
  if (!h.p && msg.p) seat.taps.p = 1;
  if (!h.k && msg.k) seat.taps.k = 1;
  h.l = msg.l ? 1 : 0; h.r = msg.r ? 1 : 0; h.d = msg.d ? 1 : 0;
  h.u = msg.u ? 1 : 0; h.p = msg.p ? 1 : 0; h.k = msg.k ? 1 : 0;
}
function newSeat(){
  return { held:{ l:0,r:0,u:0,d:0,p:0,k:0 }, taps:{ u:0,p:0,k:0 }, rematch:false };
}
function roomCode(raw){
  return String(raw || 'MAIN').toUpperCase().slice(0, 8).replace(/[^A-Z0-9]/g, '') || 'MAIN';
}

/* ============================================================
   2. The client, served as the page
   ============================================================ */
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#1A1814">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Margin Brawl">
<title>Margin Brawl</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Gloria+Hallelujah&family=Special+Elite&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none}
  html,body{margin:0;height:100%;overflow:hidden;background:#1A1814;overscroll-behavior:none;touch-action:none}
  body{
    height:100dvh;display:flex;flex-direction:column;
    font-family:'Special Elite',ui-monospace,monospace;color:#EDE7D4;background:#1A1814;
    padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }

  /* the page fills every pixel it is given */
  #arena{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;background:#FAF6E9}
  #c{display:block;width:100%;height:100%}

  #pads{flex:0 0 auto;height:clamp(118px,36dvh,188px);
        display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 12px;
        --cell:clamp(40px,11.5dvh,58px);background:#231F1A}
  .dpad{display:grid;grid-template-columns:repeat(3,var(--cell));grid-template-rows:repeat(3,var(--cell));gap:4px}
  .key{background:#F6F1E1;color:#2B2820;border:2.5px solid #3B372E;border-radius:10px;
       font-family:'Special Elite',monospace;font-size:12px;line-height:1;letter-spacing:.05em;
       box-shadow:2px 3px 0 #3B372E;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:0;
       transition:transform .05s,box-shadow .05s,background .06s}
  .key .g{font-size:20px}
  .key .t{font-size:9px;opacity:.5}
  .key.on{background:#DED5B8;transform:translate(2px,3px);box-shadow:0 0 0 #3B372E}
  .dpad .key{width:var(--cell);height:var(--cell)}
  .up{grid-area:1/2}.left{grid-area:2/1}.right{grid-area:2/3}.down{grid-area:3/2}
  .atk{display:flex;flex-direction:column;gap:8px}
  .atk .key{width:calc(var(--cell)*2.1);height:calc(var(--cell)*1.4);font-size:14px}
  body.p1 .atk .key{background:#E7ECF6;border-color:#1D3C87;box-shadow:2px 3px 0 #1D3C87;color:#1D3C87}
  body.p2 .atk .key{background:#F7E7E4;border-color:#B02A21;box-shadow:2px 3px 0 #B02A21;color:#B02A21}

  .center{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;
          font-size:10px;opacity:.7;letter-spacing:.06em;min-width:100px}
  .center b{font-weight:400;font-size:12px;opacity:.95}
  body.p1 .center b{color:#7FA0DC}
  body.p2 .center b{color:#E08A80}
  .center button{background:none;border:1.5px solid rgba(237,231,212,.3);color:inherit;font:inherit;
                 font-size:9.5px;padding:5px 9px;border-radius:6px;letter-spacing:.08em}
  #ping{font-size:9px;opacity:.5}
  #build{position:absolute;left:6px;bottom:5px;z-index:6;font-size:9px;letter-spacing:.08em;
         color:#5A5750;opacity:.5;pointer-events:none}
  #hint{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:9;max-width:80%;
        background:#2B2820;color:#EDE7D4;font-size:11px;line-height:1.5;padding:9px 13px;border-radius:8px;
        text-align:center;opacity:0;transition:opacity .25s;pointer-events:none}
  #hint.show{opacity:.96}

  .veil{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:10px;text-align:center;padding:14px 20px;background:rgba(250,246,233,.96);color:#2B2820;
        overflow:auto}
  .veil.hide{display:none}
  .title{font-family:'Gloria Hallelujah',cursive;font-size:clamp(19px,4.6vw,34px);color:#1D3C87;line-height:1;margin:0;transform:rotate(-1.5deg)}
  .title em{font-style:normal;color:#B02A21;display:block}
  .sub{font-size:clamp(10px,2vw,13px);opacity:.75;max-width:52ch;line-height:1.7;margin:0}
  .sub.bad{color:#B02A21;opacity:.95}
  .mono{font-size:11px;opacity:.55;word-break:break-all}
  .go{font-family:'Gloria Hallelujah',cursive;font-size:clamp(14px,2.4vw,19px);padding:9px 26px;
      background:#1D3C87;color:#FAF6E9;border:none;border-radius:4px;transform:rotate(-1deg);box-shadow:3px 4px 0 #12265a}
  .go:active{transform:translate(3px,4px) rotate(-1deg);box-shadow:0 0 0}
  .go[disabled]{opacity:.45}
  .addr{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}
  .addr input{font-family:'Special Elite',monospace;font-size:14px;padding:8px 10px;width:min(230px,60vw);
              border:2px solid #5A5750;border-radius:5px;background:#FFFDF5;color:#2B2820;-webkit-user-select:text;user-select:text}
  .addr button{font-family:'Special Elite',monospace;font-size:12px;padding:9px 14px;border:2px solid #1D3C87;
               background:#1D3C87;color:#FAF6E9;border-radius:5px}
  .hide{display:none !important}
  .dots::after{content:"";animation:dots 1.4s steps(4,end) infinite}
  @keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}

  #rotate{position:fixed;inset:0;z-index:20;display:none;flex-direction:column;align-items:center;
          justify-content:center;gap:16px;background:#1A1814;text-align:center;padding:24px}
  #rotate .ph{width:50px;height:84px;border:3px solid #EDE7D4;border-radius:9px;animation:turn 2.4s ease-in-out infinite}
  @keyframes turn{0%,30%{transform:rotate(0)}60%,100%{transform:rotate(-90deg)}}
  @media (orientation:portrait){#rotate{display:flex}}
  @media (prefers-reduced-motion:reduce){#rotate .ph{animation:none;transform:rotate(-90deg)}.dots::after{content:"..."}}
  :focus-visible{outline:3px solid #B02A21;outline-offset:2px}
</style>
</head>
<body>

<div id="arena">
  <canvas id="c"></canvas>
  <div class="veil" id="veil">
    <h1 class="title" id="vtitle">Margin<em>Brawl</em></h1>
    <p class="sub" id="vmsg">Connecting<span class="dots"></span></p>
    <p class="sub mono" id="vwhere"></p>
    <div class="addr hide" id="addrBox">
      <input id="addrInput" placeholder="192.168.1.42:8080" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false">
      <button id="addrGo">Connect</button>
    </div>
    <button class="go hide" id="again">Run it back</button>
    <button class="go hide" id="share" style="background:#5A5750;box-shadow:3px 4px 0 #3B372E">Share this game</button>
    <button class="go hide" id="faceVeil" style="background:#B02A21;box-shadow:3px 4px 0 #7d1c16">Use my face</button>
  </div>
  <div id="hint"></div>
  <div id="build">build 3 · faces</div>
</div>

<div id="pads">
  <div class="dpad">
    <button class="key up"    data-k="u"><span class="g">▲</span><span class="t">JUMP</span></button>
    <button class="key left"  data-k="l"><span class="g">◀</span></button>
    <button class="key right" data-k="r"><span class="g">▶</span></button>
    <button class="key down"  data-k="d"><span class="g">▼</span><span class="t">DUCK</span></button>
  </div>
  <div class="center">
    <b id="who">connecting</b>
    <span id="score">0 – 0</span>
    <button id="full">FULL SCREEN</button>
    <button id="faceBtn" class="hide">USE MY FACE</button>
    <input type="file" id="faceInput" accept="image/*" capture="user" style="display:none">
    <span id="ping">—</span>
  </div>
  <div class="atk">
    <button class="key" data-k="p">PUNCH</button>
    <button class="key" data-k="k">KICK</button>
  </div>
</div>

<div id="rotate">
  <div class="ph"></div>
  <p class="sub" style="color:#EDE7D4;opacity:.85">Turn the phone sideways.<br>This one needs a wide page.</p>
</div>

<script>
(() => {
"use strict";

/* ---------- constants (must match server.js) ---------- */
const W = 960, GROUND = 254, MAXHP = 32;
const MOVES = { punch:{ startup:5, active:5, recover:10 }, kick:{ startup:9, active:6, recover:17 } };
const INK_B = '#1D3C87', INK_R = '#B02A21', PAPER = '#FAF6E9',
      RULE = '#BCCEDB', MARGIN = '#E8A7A2', PENCIL = '#5A5750';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const arena = document.getElementById('arena');
const cvs = document.getElementById('c'), ctx = cvs.getContext('2d');

/* ---------- faces: 64x64 one-bit stipple, 512 bytes on the wire ---------- */
const FACE_S = 64;
let faceA = null, faceB = null, myFaceData = null;
function faceCanvas(b64, ink){
  let bin;
  try { bin = atob(b64); } catch(e){ return null; }
  if (bin.length !== FACE_S * FACE_S / 8) return null;
  const c = document.createElement('canvas');
  c.width = FACE_S; c.height = FACE_S;
  const g = c.getContext('2d'), id = g.createImageData(FACE_S, FACE_S);
  const r = parseInt(ink.slice(1,3),16), gg = parseInt(ink.slice(3,5),16), b = parseInt(ink.slice(5,7),16);
  for (let i = 0; i < FACE_S * FACE_S; i++){
    const on = (bin.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
    const p = i * 4;
    id.data[p] = r; id.data[p+1] = gg; id.data[p+2] = b; id.data[p+3] = on ? 255 : 0;
  }
  g.putImageData(id, 0, 0);
  return c;
}
const dpr = Math.min(2, window.devicePixelRatio || 1);

/* ---------- camera: world is 960 wide, screen decides the rest ---------- */
let cw = 0, ch = 0, scale = 1, visH = 300, yOff = 0, topY = 0;
let paper = document.createElement('canvas');

function resize(){
  const r = arena.getBoundingClientRect();
  cw = Math.max(1, r.width); ch = Math.max(1, r.height);
  cvs.width = Math.round(cw * dpr); cvs.height = Math.round(ch * dpr);
  scale = cw / W;                      // fit width: both phones see the same arena
  visH = ch / scale;
  yOff = (visH - 46) - GROUND;         // park the ground near the bottom edge
  topY = -yOff;                        // world y of the top of the screen
  makePaper();
}
function makePaper(){
  paper = document.createElement('canvas');
  paper.width = cvs.width; paper.height = cvs.height;
  const p = paper.getContext('2d');
  p.setTransform(dpr, 0, 0, dpr, 0, 0);
  p.fillStyle = PAPER; p.fillRect(0, 0, cw, ch);
  p.strokeStyle = RULE; p.lineWidth = 1;
  for (let y = 26; y < ch; y += 26){
    p.beginPath();
    for (let x = 0; x <= cw; x += 24) p.lineTo(x, y + Math.sin(x * .02 + y) * .5);
    p.stroke();
  }
  p.strokeStyle = MARGIN; p.lineWidth = 1.6;
  const mx = 50 * scale;
  p.beginPath(); p.moveTo(mx, 0); p.lineTo(mx + 2, ch); p.stroke();
  p.fillStyle = 'rgba(90,87,80,.05)';
  for (let i = 0; i < 900; i++) p.fillRect(Math.random() * cw, Math.random() * ch, 1.2, 1.2);
  p.fillStyle = '#EFE9D6'; p.strokeStyle = '#D8D0B8'; p.lineWidth = 1.4;
  [ch * .3, ch * .68].forEach(y => { p.beginPath(); p.arc(20 * scale, y, 8, 0, 7); p.fill(); p.stroke(); });
}
function worldTransform(){ ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, dpr * scale * yOff); }

/* ---------- hand-drawn strokes ---------- */
let boil = 0, frame = 0;
function jit(i){ const s = Math.sin(i * 127.1 + boil * 78.233) * 43758.5453; return s - Math.floor(s); }
function inkLine(x1, y1, x2, y2, seed){
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
  const segs = Math.max(2, Math.round(len / 16));
  ctx.beginPath(); ctx.moveTo(x1, y1);
  for (let i = 1; i <= segs; i++){
    const t = i / segs, last = i === segs;
    const jx = last ? 0 : (jit(seed + i * 3.1) - .5) * 2.1;
    const jy = last ? 0 : (jit(seed + i * 7.7) - .5) * 2.1;
    ctx.lineTo(x1 + dx * t + jx, y1 + dy * t + jy);
  }
  ctx.stroke();
}
function inkCircle(cx2, cy, r, seed){
  const n = 11; ctx.beginPath();
  for (let i = 0; i <= n; i++){
    const a = (i / n) * 6.2832 - 1.2;
    const rr = r + (jit(seed + i * 5.3) - .5) * 1.9;
    const x = cx2 + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * .96;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
}

/* ---------- sound ---------- */
let AC = null;
function blip(freq, dur, type, vol){
  try {
    AC = AC || new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square'; o.frequency.value = freq;
    o.frequency.exponentialRampToValueAtTime(freq * .45, AC.currentTime + dur);
    g.gain.value = vol || .06;
    g.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + dur);
    o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + dur);
  } catch(e){}
}

/* ---------- poses ---------- */
function ease(t){ return t < .5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2) / 2; }
function poseOf(f){
  const a = f.anim, s = f.state;
  const P = { hip:[0,-46], neck:[0,-76], head:[0,-90], hr:11,
              ef:[11,-60], hf:[15,-42], eb:[-11,-60], hb:[-15,-42],
              kf:[7,-24], ff:[9,-1], kb:[-7,-24], fb:[-11,-1] };
  if (s === 'idle' || s === 'walk'){
    const bob = Math.sin(a * .07) * 1.6;
    P.hip[1] += bob; P.neck[1] += bob; P.head[1] += bob; P.ef[1] += bob; P.eb[1] += bob;
  }
  if (s === 'walk'){
    const w = Math.sin(a * .26);
    P.ff = [15 * w, -1 - Math.max(0, w) * 7];  P.kf = [8 * w + 4, -24];
    P.fb = [-15 * w, -1 - Math.max(0, -w) * 7]; P.kb = [-8 * w - 4, -24];
    P.hf = [15 - 9 * w, -42]; P.hb = [-15 + 9 * w, -42];
  }
  if (s === 'jump'){
    const up = f.vy < 0;
    P.kf = [12,-30]; P.ff = [8,-14]; P.kb = [-8,-32]; P.fb = [-14,-19];
    P.hf = [16, up ? -88 : -70]; P.ef = [13,-72]; P.hb = [-18,-64];
  }
  if (s === 'duck'){
    P.hip = [0,-26]; P.neck = [1,-50]; P.head = [3,-63]; P.hr = 10.5;
    P.ef = [11,-40]; P.hf = [17,-30]; P.eb = [-9,-40]; P.hb = [-15,-28];
    P.kf = [16,-14];  P.ff = [20,-1];  P.kb = [-14,-14]; P.fb = [-18,-1];
  }
  if (s === 'punch'){
    const m = MOVES.punch, tot = m.startup + m.active;
    const ext = f.t > tot ? Math.max(0, 1 - (f.t - tot) / m.recover) : ease(Math.min(1, f.t / tot));
    P.hf = [12 + ext * 46, -74]; P.ef = [9 + ext * 24, -73];
    P.hb = [-20,-56]; P.eb = [-13,-62];
    P.hip[0] += ext * 3; P.neck[0] += ext * 4; P.head[0] += ext * 5;
    P.ff = [12 + ext * 6, -1]; P.fb = [-14 - ext * 4, -1];
  }
  if (s === 'kick'){
    const m = MOVES.kick, tot = m.startup + m.active;
    const ext = f.t > tot ? Math.max(0, 1 - (f.t - tot) / m.recover) : ease(Math.min(1, f.t / tot));
    P.ff = [8 + ext * 64, -2 - ext * 42]; P.kf = [6 + ext * 33, -18 - ext * 20];
    P.hip[0] -= ext * 8; P.neck[0] -= ext * 11; P.head[0] -= ext * 13; P.hip[1] += ext * 3;
    P.hf = [4 - ext * 22, -74]; P.ef = [2 - ext * 12, -66];
    P.hb = [-18 - ext * 12, -80]; P.eb = [-14,-66];
    P.fb = [-13,-1]; P.kb = [-9,-24];
  }
  if (s === 'hit'){
    const k = Math.min(1, f.t / 6);
    P.head[0] -= 9 * k; P.head[1] += 3 * k; P.neck[0] -= 6 * k; P.hip[0] -= 2 * k;
    P.hf = [2,-86]; P.ef = [6,-68]; P.hb = [-20,-80]; P.eb = [-15,-64];
    P.ff = [16,-1]; P.fb = [-17,-1];
  }
  if (s === 'ko'){
    P.hip = [0,-30]; P.neck = [0,-56]; P.head = [-2,-70];
    P.hf = [26,-60]; P.ef = [14,-52]; P.hb = [-24,-40]; P.eb = [-14,-44];
    P.ff = [22,-6];  P.kf = [12,-16]; P.fb = [-20,-14]; P.kb = [-10,-20];
  }
  return P;
}
function drawFighter(f, mine){
  const P = poseOf(f), fc = f.facing;
  const X = p => p[0] * fc, Y = p => p[1];
  const sd = f.ink === INK_B ? 100 : 700;
  ctx.save(); ctx.translate(f.x, f.y);
  if (f.rot) ctx.rotate(f.rot);
  ctx.strokeStyle = 'rgba(90,87,80,.28)'; ctx.lineWidth = 1.6;
  const sy = GROUND - f.y + 2;
  inkLine(-16, sy, 16, sy, sd + 41); inkLine(-11, sy + 2.5, 12, sy + 2.5, sd + 42);
  if (mine){ ctx.strokeStyle = 'rgba(90,87,80,.42)'; ctx.lineWidth = 1.5; inkCircle(0, sy - 1, 21, 55); }
  ctx.strokeStyle = f.ink; ctx.lineWidth = 3.2;
  inkLine(X(P.neck), Y(P.neck), X(P.hip), Y(P.hip), sd + 1);
  ctx.lineWidth = 2.5; ctx.globalAlpha = .72;
  inkLine(X(P.neck), Y(P.neck) + 2, X(P.eb), Y(P.eb), sd + 2);
  inkLine(X(P.eb), Y(P.eb), X(P.hb), Y(P.hb), sd + 3);
  inkLine(X(P.hip), Y(P.hip), X(P.kb), Y(P.kb), sd + 4);
  inkLine(X(P.kb), Y(P.kb), X(P.fb), Y(P.fb), sd + 5);
  ctx.globalAlpha = 1; ctx.lineWidth = 3.2;
  inkLine(X(P.neck), Y(P.neck) + 2, X(P.ef), Y(P.ef), sd + 6);
  inkLine(X(P.ef), Y(P.ef), X(P.hf), Y(P.hf), sd + 7);
  inkLine(X(P.hip), Y(P.hip), X(P.kf), Y(P.kf), sd + 8);
  inkLine(X(P.kf), Y(P.kf), X(P.ff), Y(P.ff), sd + 9);
  const face = (f.ink === INK_B) ? faceA : faceB;
  const hx = X(P.head), hy = Y(P.head);
  if (face){
    ctx.save();
    ctx.beginPath(); ctx.arc(hx, hy, P.hr + 1.5, 0, 7); ctx.clip();
    ctx.translate(hx, hy); ctx.scale(fc, 1);           // face looks where you're facing
    const d = (P.hr + 1.5) * 2.35;
    ctx.drawImage(face, -d / 2, -d / 2, d, d);
    ctx.restore();
  }
  ctx.lineWidth = 3;
  inkCircle(hx, hy, P.hr, sd + 10);
  ctx.fillStyle = f.ink;
  const ex = hx + fc * 4, ey = hy - 2;
  if (f.state === 'ko'){
    ctx.lineWidth = 2;
    inkLine(ex - 3, ey - 3, ex + 3, ey + 3, sd + 11);
    inkLine(ex + 3, ey - 3, ex - 3, ey + 3, sd + 12);
  } else if (!face){
    ctx.beginPath(); ctx.arc(ex, ey, f.state === 'hit' ? 2.6 : 1.8, 0, 7); ctx.fill();
  }
  ctx.restore();
}

/* ---------- effects ---------- */
const fx = [];
function drawFx(){
  for (let i = fx.length - 1; i >= 0; i--){
    const e = fx[i];
    if (--e.life <= 0){ fx.splice(i, 1); continue; }
    if (e.k === 'spark'){
      ctx.strokeStyle = e.c; ctx.lineWidth = 2.4; ctx.globalAlpha = Math.min(1, e.life / 8);
      for (let j = 0; j < e.n; j++){
        const a = (j / e.n) * 6.283 + e.life * .1;
        const r1 = 8 + (13 - e.life), r2 = r1 + 11;
        inkLine(e.x + Math.cos(a) * r1, e.y + Math.sin(a) * r1,
                e.x + Math.cos(a) * r2, e.y + Math.sin(a) * r2, j * 9 + e.life);
      }
      ctx.globalAlpha = 1;
    } else {
      const p = 1 - e.life / e.max;
      ctx.save(); ctx.translate(e.x, e.y - p * 24); ctx.rotate(e.rot);
      ctx.globalAlpha = Math.min(1, e.life / 14);
      ctx.font = (e.small ? '15px' : '22px') + " 'Gloria Hallelujah', cursive";
      ctx.textAlign = 'center'; ctx.fillStyle = e.c; ctx.fillText(e.w, 0, 0);
      ctx.globalAlpha = 1; ctx.restore();
    }
  }
}

/* ---------- HUD (anchored to the top of whatever screen this is) ---------- */
function hpBar(x, y, w, h, hp, color, flip){
  ctx.strokeStyle = PENCIL; ctx.lineWidth = 2;
  inkLine(x, y, x + w, y, 900); inkLine(x, y + h, x + w, y + h, 901);
  inkLine(x, y, x, y + h, 902); inkLine(x + w, y, x + w, y + h, 903);
  const tw = w / MAXHP;
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.8, tw - 2.6);
  ctx.globalAlpha = hp <= 4 && (Math.floor(boil / 2) % 2) ? .45 : 1;
  for (let i = 0; i < hp; i++){
    const idx = flip ? MAXHP - 1 - i : i;
    inkLine(x + idx * tw + tw / 2, y + 3, x + idx * tw + tw / 2, y + h - 3, 905 + idx);
  }
  ctx.globalAlpha = 1;
}
function tally(x, y, n, color){
  ctx.strokeStyle = color; ctx.lineWidth = 2.6;
  for (let i = 0; i < n; i++) inkLine(x + i * 9, y, x + i * 9 + 2, y - 14, 940 + i);
}
function drawHUD(){
  const bw = 300, T = topY;
  ctx.font = "12px 'Special Elite', monospace";
  ctx.textAlign = 'left';  ctx.fillStyle = INK_B;
  ctx.fillText(mySlot === 1 ? 'P1 — YOU' : 'P1', 60, T + 20);
  ctx.textAlign = 'right'; ctx.fillStyle = INK_R;
  ctx.fillText(mySlot === 2 ? 'YOU — P2' : 'P2', W - 26, T + 20);
  hpBar(60, T + 26, bw, 14, snap.a.hp, INK_B, false);
  hpBar(W - 26 - bw, T + 26, bw, 14, snap.b.hp, INK_R, true);
  tally(60, T + 60, snap.w1, INK_B);
  tally(W - 26 - Math.max(0, snap.w2 - 1) * 9 - 2, T + 60, snap.w2, INK_R);
  ctx.textAlign = 'center'; ctx.font = "24px 'Gloria Hallelujah', cursive";
  ctx.fillStyle = snap.cl <= 10 ? INK_R : PENCIL;
  ctx.fillText(String(snap.cl), W / 2, T + 38);
}
function drawGround(){
  ctx.strokeStyle = PENCIL; ctx.lineWidth = 3;
  inkLine(24, GROUND + 3, W - 24, GROUND + 3, 800);
  ctx.lineWidth = 1.6; ctx.globalAlpha = .5;
  for (let x = 36; x < W - 28; x += 26) inkLine(x, GROUND + 6, x - 9, GROUND + 14, 810 + x);
  ctx.globalAlpha = 1;
}
function drawBanner(){
  if (!snap || !snap.bn) return;
  ctx.save(); ctx.translate(W / 2, topY + visH * .44); ctx.rotate(-.035); ctx.textAlign = 'center';
  ctx.font = "46px 'Gloria Hallelujah', cursive";
  ctx.fillStyle = snap.bn === 'K.O.' ? INK_R : PENCIL;
  ctx.fillText(snap.bn, 0, 0);
  if (snap.bs){
    ctx.font = "13px 'Special Elite', monospace"; ctx.fillStyle = PENCIL;
    ctx.fillText(snap.bs, 0, 26);
  }
  ctx.restore();
}

/* ---------- where is the server? ---------- */
const params = new URLSearchParams(location.search);
const room = (params.get('room') || 'main').toUpperCase();
const isFile = location.protocol === 'file:';
function stored(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
function store(k, v){ try { localStorage.setItem(k, v); } catch(e){} }

let serverAddr = params.get('server') || (isFile ? (stored('brawl.server') || '') : location.host);
let net = serverAddr ? 'connecting' : 'noaddr';   // noaddr | connecting | open | retry
let attempts = 0, ws = null, mySlot = 0, snap = null, latency = null;
let roomState = { p1:false, p2:false, watchers:0, rematch:[false,false] };

const veil = document.getElementById('veil'), vtitle = document.getElementById('vtitle'),
      vmsg = document.getElementById('vmsg'), vwhere = document.getElementById('vwhere'),
      addrBox = document.getElementById('addrBox'), addrInput = document.getElementById('addrInput'),
      againBtn = document.getElementById('again'), whoEl = document.getElementById('who'),
      scoreEl = document.getElementById('score'), pingEl = document.getElementById('ping'),
      hintEl = document.getElementById('hint');

function wsURL(){
  const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
  return proto + '//' + serverAddr + '/ws?room=' + encodeURIComponent(room);
}
function connect(){
  if (!serverAddr){ net = 'noaddr'; return; }
  net = attempts ? 'retry' : 'connecting';
  try { ws = new WebSocket(wsURL()); }
  catch(e){ net = 'retry'; attempts++; setTimeout(connect, 1500); return; }

  ws.onopen = () => { net = 'open'; attempts = 0; if (isFile) store('brawl.server', serverAddr); sendInput(); };
  ws.onclose = () => {
    ws = null; snap = null; mySlot = 0; attempts++;
    faceA = faceB = null; faceBtn.classList.add('hide'); faceVeilBtn.classList.add('hide');
    net = 'retry';
    whoEl.textContent = 'no server';
    document.body.classList.remove('p1', 'p2');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch(err){ return; }
    if (m.type === 's'){ snap = m; if (m.e) m.e.forEach(handleEvent); }
    else if (m.type === 'hello'){
      mySlot = m.slot;
      document.body.classList.toggle('p1', mySlot === 1);
      document.body.classList.toggle('p2', mySlot === 2);
      whoEl.textContent = mySlot === 1 ? 'you are P1' : mySlot === 2 ? 'you are P2' : 'watching';
      if (!mySlot) showHint('Both player slots are taken. Close the game on any other phone or tab, then reload here.', 7000);
      faceBtn.classList.remove('hide');
      if (mySlot && myFaceData) applyMyFace(myFaceData);
    }
    else if (m.type === 'room') roomState = m;
    else if (m.type === 'face'){
      const c = m.d ? faceCanvas(m.d, m.slot === 1 ? INK_B : INK_R) : null;
      if (m.slot === 1) faceA = c; else if (m.slot === 2) faceB = c;
    }
    else if (m.type === 'pong'){ latency = Date.now() - m.t; pingEl.textContent = latency + ' ms'; }
  };
}
function handleEvent(e){
  if (e.k === 'hit'){
    const c = e.s === 1 ? INK_B : INK_R;
    fx.push({ k:'spark', x:e.x, y:e.y, life:13, c, n:e.big ? 9 : 6 });
    fx.push({ k:'word', x:e.x - 6, y:e.y - 24, life:32, max:32, c, w:e.w, rot:(Math.random() - .5) * .5 });
    blip(e.big ? 150 : 230, .12, 'square', .07);
  } else if (e.k === 'whiff'){
    fx.push({ k:'word', x:e.x, y:e.y, life:26, max:26, c:PENCIL, w:'whiff', rot:-.15, small:true });
    blip(420, .07, 'sine', .025);
  } else if (e.k === 'sw') blip(e.n === 'kick' ? 180 : 250, .05, 'triangle', .03);
  else if (e.k === 'jmp') blip(620, .07, 'sine', .03);
  else if (e.k === 'go')  blip(880, .12, 'square', .05);
  else if (e.k === 'ko')  blip(120, .35, 'sawtooth', .05);
}
setInterval(() => { if (net === 'open' && ws) ws.send(JSON.stringify({ type:'ping', t:Date.now() })); }, 2000);

addrInput.value = serverAddr && isFile ? serverAddr : '';
document.getElementById('addrGo').addEventListener('click', () => {
  let v = addrInput.value.trim().replace(/^https?:\\/\\//, '').replace(/\\/+$/, '');
  if (!v) return;
  if (!/:\\d+$/.test(v)) v += ':8080';
  serverAddr = v; store('brawl.server', v); attempts = 0;
  if (ws){ try { ws.close(); } catch(e){} ws = null; }
  connect();
});
addrInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('addrGo').click(); });

/* ---------- input ---------- */
const held = { l:0, r:0, u:0, d:0, p:0, k:0 };
function sendInput(){
  if (net !== 'open' || !ws || !mySlot) return;
  try { ws.send(JSON.stringify({ type:'i', l:held.l, r:held.r, u:held.u, d:held.d, p:held.p, k:held.k })); } catch(e){}
}
document.querySelectorAll('#pads .key').forEach(btn => {
  const k = btn.dataset.k;
  const on = e => { e.preventDefault(); if (held[k]) return; held[k] = 1; btn.classList.add('on'); sendInput(); };
  const off = e => { e.preventDefault(); if (!held[k]) return; held[k] = 0; btn.classList.remove('on'); sendInput(); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('pointerleave', off);
  btn.addEventListener('contextmenu', e => e.preventDefault());
});
const KEYS = { a:'l', arrowleft:'l', d:'r', arrowright:'r', w:'u', arrowup:'u', ' ':'u',
               s:'d', arrowdown:'d', j:'p', f:'p', k:'k', g:'k' };
addEventListener('keydown', e => { const k = KEYS[e.key.toLowerCase()];
  if (!k || e.target.tagName === 'INPUT') return; e.preventDefault(); if (held[k]) return; held[k] = 1; sendInput(); });
addEventListener('keyup', e => { const k = KEYS[e.key.toLowerCase()];
  if (!k) return; held[k] = 0; sendInput(); });
addEventListener('blur', () => { Object.keys(held).forEach(k => held[k] = 0);
  document.querySelectorAll('.key.on').forEach(b => b.classList.remove('on')); sendInput(); });

againBtn.addEventListener('click', () => {
  if (net === 'open' && ws && mySlot) ws.send(JSON.stringify({ type:'rematch' }));
});

const shareBtn = document.getElementById('share');
shareBtn.addEventListener('click', async () => {
  const link = location.origin + location.pathname + (room === 'MAIN' ? '' : '?room=' + room);
  try {
    if (navigator.share){ await navigator.share({ title:'Margin Brawl', text:'Fight me', url:link }); return; }
    await navigator.clipboard.writeText(link);
    showHint('Link copied. Send it to the other player.', 4000);
  } catch(e){ showHint(link, 9000); }
});

/* ---------- take a face ---------- */
const BAYER = [[0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5]];

async function loadBitmap(file){
  if (window.createImageBitmap){
    try { return await createImageBitmap(file, { imageOrientation:'from-image' }); }
    catch(e){ try { return await createImageBitmap(file); } catch(e2){} }
  }
  return await new Promise((res, rej) => {
    const img = new Image(), fr = new FileReader();
    fr.onload = () => { img.onload = () => res(img); img.onerror = rej; img.src = fr.result; };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}

async function makeFace(file){
  const bmp = await loadBitmap(file);
  const S = FACE_S;
  const oc = document.createElement('canvas'); oc.width = S; oc.height = S;
  const o = oc.getContext('2d', { willReadFrequently:true });
  const iw = bmp.width || bmp.naturalWidth, ih = bmp.height || bmp.naturalHeight;
  const side = Math.min(iw, ih);
  // centre square, nudged up: faces sit above the middle of a selfie
  const sx = (iw - side) / 2;
  const sy = Math.max(0, (ih - side) / 2 - side * 0.06);
  o.drawImage(bmp, sx, sy, side, side, 0, 0, S, S);

  const px = o.getImageData(0, 0, S, S).data;
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++)
    lum[i] = (px[i*4] * .299 + px[i*4+1] * .587 + px[i*4+2] * .114) / 255;

  // stretch contrast between the 5th and 95th percentile so any lighting works
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(sorted.length * .05)], hi = sorted[Math.floor(sorted.length * .95)];
  const span = Math.max(.05, hi - lo);

  const bits = new Uint8Array(S * S / 8);
  const R = S / 2 - 1.5, cx = S / 2 - .5, cy = S / 2 - .5;
  for (let y = 0; y < S; y++){
    for (let x = 0; x < S; x++){
      const i = y * S + x;
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > R * R) continue;   // circle mask
      let v = (lum[i] - lo) / span;
      v = Math.min(1, Math.max(0, v));
      v = v * 1.12 - .06;                                               // a touch more bite
      const t = (BAYER[y & 3][x & 3] + .5) / 16;
      if (v < t) bits[i >> 3] |= 128 >> (i & 7);                        // dark -> ink
    }
  }
  let str = '';
  for (let i = 0; i < bits.length; i++) str += String.fromCharCode(bits[i]);
  return btoa(str);
}

function applyMyFace(b64){
  myFaceData = b64;
  const c = faceCanvas(b64, mySlot === 2 ? INK_R : INK_B);
  if (mySlot === 2) faceB = c; else faceA = c;
  try { localStorage.setItem('brawl.face', b64); } catch(e){}
  if (net === 'open' && ws && mySlot) ws.send(JSON.stringify({ type:'face', d:b64 }));
}

const faceBtn = document.getElementById('faceBtn'), faceInput = document.getElementById('faceInput');
const faceVeilBtn = document.getElementById('faceVeil');
faceBtn.addEventListener('click', () => faceInput.click());
faceVeilBtn.addEventListener('click', () => faceInput.click());
faceInput.addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  faceInput.value = '';
  if (!file) return;
  showHint('Inking your face...', 2500);
  try {
    const b64 = await makeFace(file);
    applyMyFace(b64);
    showHint('That is you now. Tap again to retake.', 3500);
  } catch(err){
    showHint('Could not read that picture. Try again.', 4000);
  }
});
try {
  const saved = localStorage.getItem('brawl.face');
  if (saved) myFaceData = saved;
} catch(e){}

/* ---------- full screen ---------- */
function showHint(text, ms){
  hintEl.textContent = text; hintEl.classList.add('show');
  clearTimeout(showHint.t); showHint.t = setTimeout(() => hintEl.classList.remove('show'), ms || 5000);
}
document.getElementById('full').addEventListener('click', async () => {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const inFS = document.fullscreenElement || document.webkitFullscreenElement;
  if (!req){
    showHint('This browser has no full screen. On iPhone: Share → Add to Home Screen, then open Margin Brawl from the icon — it opens with no browser bars.', 8000);
    return;
  }
  try {
    if (inFS) await exit.call(document); else await req.call(el);
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch(e){
    showHint('Full screen was refused. On iPhone: Share → Add to Home Screen, then open it from the icon.', 8000);
  }
});

/* ---------- overlay ---------- */
function setVeil(title, msg, where, bad){
  veil.classList.remove('hide');
  if (vtitle.dataset.v !== title){ vtitle.innerHTML = title; vtitle.dataset.v = title; }
  if (vmsg.dataset.v !== msg){ vmsg.innerHTML = msg; vmsg.dataset.v = msg; }
  vmsg.classList.toggle('bad', !!bad);
  vwhere.textContent = where || '';
}
function updateVeil(){
  // connection problems always win — they are what you need to know
  if (net === 'noaddr'){
    setVeil('Where is the<em>server?</em>',
      isFile ? 'This page was opened straight from the folder, so it has no server to talk to. Start it with <b>node server.js</b>, then type the address it printed.'
             : 'Type the address the server printed.',
      '', true);
    addrBox.classList.remove('hide'); againBtn.classList.add('hide'); shareBtn.classList.add('hide');
    faceVeilBtn.classList.add('hide');
    whoEl.textContent = 'no server';
    return;
  }
  if (net === 'connecting'){
    setVeil('Margin<em>Brawl</em>', 'Connecting<span class="dots"></span>', wsURL(), false);
    addrBox.classList.add('hide'); againBtn.classList.add('hide'); shareBtn.classList.add('hide');
    faceVeilBtn.classList.add('hide');
    return;
  }
  if (net === 'retry'){
    setVeil('Can\\'t reach<em>the server</em>',
      'Tried ' + attempts + (attempts === 1 ? ' time' : ' times') + '. Check the server is running, both devices are on the same WiFi, and the port is open. Retrying<span class="dots"></span>',
      wsURL(), true);
    addrBox.classList.remove('hide'); againBtn.classList.add('hide'); shareBtn.classList.add('hide');
    return;
  }
  if (!snap){
    setVeil('Margin<em>Brawl</em>', 'Connected. Waiting for the first frame<span class="dots"></span>', wsURL(), false);
    addrBox.classList.add('hide'); againBtn.classList.add('hide'); shareBtn.classList.add('hide');
    return;
  }
  if (snap.ph === 'waiting'){
    const alone = !(roomState.p1 && roomState.p2);
    setVeil(mySlot ? 'You are<em>Player ' + mySlot + '</em>' : 'Ringside<em>seat</em>',
      alone ? 'Waiting for the other pen<span class="dots"></span><br>Send them this same address.'
            : 'Both pens ready. Starting<span class="dots"></span>',
      'room ' + room, false);
    addrBox.classList.add('hide'); againBtn.classList.add('hide');
    shareBtn.classList.toggle('hide', !alone || isFile);
    faceVeilBtn.classList.toggle('hide', !mySlot);
    return;
  }
  if (snap.ph === 'match'){
    const won1 = snap.w1 >= 2;
    const youWon = (won1 && mySlot === 1) || (!won1 && mySlot === 2);
    setVeil(mySlot ? (youWon ? 'You keep<em>the page</em>' : 'Out of<em>ink</em>')
                   : (won1 ? 'Player 1<em>keeps the page</em>' : 'Player 2<em>keeps the page</em>'),
            'Final tally ' + snap.w1 + ' – ' + snap.w2 + '.', '', false);
    addrBox.classList.add('hide'); shareBtn.classList.add('hide'); faceVeilBtn.classList.add('hide');
    if (mySlot){
      againBtn.classList.remove('hide');
      const mine = roomState.rematch[mySlot - 1];
      againBtn.disabled = mine;
      againBtn.textContent = mine ? 'waiting for the other pen' : 'Run it back';
    }
    return;
  }
  veil.classList.add('hide');
  againBtn.classList.add('hide'); shareBtn.classList.add('hide'); faceVeilBtn.classList.add('hide');
  againBtn.disabled = false; againBtn.textContent = 'Run it back';
}

/* ---------- render ---------- */
const rA = { x:W * .3, y:GROUND }, rB = { x:W * .7, y:GROUND };
function mkFighter(d, r, ink){
  r.x += (d.x - r.x) * .5; r.y += (d.y - r.y) * .5;
  if (Math.abs(d.x - r.x) > 60){ r.x = d.x; r.y = d.y; }
  return { x:r.x, y:r.y, vy:d.vy, state:d.st, t:d.t, anim:d.an, rot:d.ro, hp:d.hp, facing:d.fc, ink };
}
function paint(){
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(paper, 0, 0);
  worldTransform();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  drawGround();
  if (snap){
    const A = mkFighter(snap.a, rA, INK_B), B = mkFighter(snap.b, rB, INK_R);
    if (A.hp <= B.hp){ drawFighter(A, mySlot === 1); drawFighter(B, mySlot === 2); }
    else { drawFighter(B, mySlot === 2); drawFighter(A, mySlot === 1); }
    drawFx();
    if (snap.ph !== 'waiting' && snap.ph !== 'match') drawHUD();
    drawBanner();
    scoreEl.textContent = snap.w1 + ' – ' + snap.w2;
  } else drawFx();
  updateVeil();
}
function loop(){
  requestAnimationFrame(loop);
  frame++;
  if (!reduceMotion && frame % 4 === 0) boil++;
  paint();
}

resize();
addEventListener('resize', () => setTimeout(resize, 60));
addEventListener('orientationchange', () => setTimeout(resize, 250));
if (document.fonts) document.fonts.ready.then(() => { resize(); paint(); });
connect();
requestAnimationFrame(loop);
})();
</script>
</body>
</html>
`;

/* ============================================================
   3. The arena and the Worker
   ============================================================ */
const TICK_MS = 1000 / 60;
const SEND_EVERY = 2;              // snapshot at 30 Hz while fighting
const IDLE_SEND_EVERY = 30;        // 2 Hz while waiting — keeps the socket warm
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;   // cut loose sockets after 2 hours
const FACE_CHARS = 684;                      // exactly one 64x64 one-bit face, base64

export class Arena extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.sim = new Sim();
    this.sessions = new Map();     // ws -> { slot, held, taps, rematch, since }
    this.seats = [null, null];     // ws for player 1 and player 2
    this.timer = null;
    this.frame = 0;
    this.acc = 0;
    this.last = Date.now();
  }

  async fetch(request){
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('This endpoint speaks WebSocket only.', { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();               // live socket: the object stays awake to run the fight

    const seat = newSeat();
    seat.since = Date.now();
    if (!this.seats[0]){ this.seats[0] = server; seat.slot = 1; }
    else if (!this.seats[1]){ this.seats[1] = server; seat.slot = 2; }
    else seat.slot = 0;            // spectator
    this.sessions.set(server, seat);

    this.send(server, { type:'hello', slot:seat.slot, maxhp:MAXHP, w:W, h:H, ground:GROUND });
    for (const n of [1, 2]){
      const other = this.seats[n - 1] && this.sessions.get(this.seats[n - 1]);
      if (other && other.face) this.send(server, { type:'face', slot:n, d:other.face });
    }
    this.announce();
    this.startLoop();

    server.addEventListener('message', ev => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch(e){ return; }
      if (!msg) return;
      if (msg.type === 'i' && seat.slot) applyInput(seat, msg);
      else if (msg.type === 'ping') this.send(server, { type:'pong', t:msg.t });
      else if (msg.type === 'face' && seat.slot){
        // a face is a fixed-size blob; anything else is not one
        if (typeof msg.d !== 'string' || msg.d.length !== FACE_CHARS) return;
        seat.face = msg.d;
        this.broadcast({ type:'face', slot:seat.slot, d:msg.d });
      }
      else if (msg.type === 'rematch' && seat.slot){
        seat.rematch = true;
        const s1 = this.seats[0] && this.sessions.get(this.seats[0]);
        const s2 = this.seats[1] && this.sessions.get(this.seats[1]);
        if (s1 && s2 && s1.rematch && s2.rematch && this.sim.phase === 'match'){
          s1.rematch = false; s2.rematch = false;
          this.sim.hardReset();
        }
        this.announce();
      }
    });

    const drop = () => this.drop(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  drop(ws){
    if (!this.sessions.has(ws)) return;
    this.sessions.delete(ws);
    let freed = 0;
    if (this.seats[0] === ws){ this.seats[0] = null; freed = 1; }
    else if (this.seats[1] === ws){ this.seats[1] = null; freed = 2; }
    if (this.sessions.size === 0){ this.stopLoop(); this.sim.hardReset(); return; }
    if (freed) this.broadcast({ type:'face', slot:freed, d:null });
    this.sim.hardReset();
    this.sessions.forEach(s => s.rematch = false);
    this.announce();
  }

  send(ws, obj){
    try { ws.send(JSON.stringify(obj)); } catch(e){ this.drop(ws); }
  }
  broadcast(obj){
    const text = JSON.stringify(obj);
    this.sessions.forEach((_, ws) => { try { ws.send(text); } catch(e){ this.drop(ws); } });
  }
  announce(){
    const s1 = this.seats[0] && this.sessions.get(this.seats[0]);
    const s2 = this.seats[1] && this.sessions.get(this.seats[1]);
    let watchers = 0;
    this.sessions.forEach(s => { if (!s.slot) watchers++; });
    this.broadcast({ type:'room', p1:!!s1, p2:!!s2, watchers,
                     rematch:[!!(s1 && s1.rematch), !!(s2 && s2.rematch)] });
  }

  startLoop(){
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => this.pump(), 16);
  }
  stopLoop(){
    if (!this.timer) return;
    clearInterval(this.timer); this.timer = null;
  }
  pump(){
    const now = Date.now();
    this.acc += Math.min(200, now - this.last);
    this.last = now;

    // hang up on sockets that have been open absurdly long (protects the free tier)
    this.sessions.forEach((s, ws) => {
      if (now - s.since > MAX_SESSION_MS){ try { ws.close(1000, 'session expired'); } catch(e){} this.drop(ws); }
    });
    if (this.sessions.size === 0){ this.stopLoop(); return; }

    const s1 = this.seats[0] && this.sessions.get(this.seats[0]);
    const s2 = this.seats[1] && this.sessions.get(this.seats[1]);
    const ready = !!(s1 && s2);

    while (this.acc >= TICK_MS){
      this.acc -= TICK_MS;
      this.frame++;
      this.sim.tick(s1 ? consume(s1) : IDLE, s2 ? consume(s2) : IDLE, ready);
      const every = ready ? SEND_EVERY : IDLE_SEND_EVERY;
      if (this.frame % every === 0) this.broadcast(this.sim.snapshot());
    }
  }
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if (url.pathname === '/ws'){
      const room = roomCode(url.searchParams.get('room'));
      const stub = env.ARENA.getByName(room);
      return stub.fetch(request);
    }
    return new Response(PAGE, { headers: { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-cache' } });
  }
};
