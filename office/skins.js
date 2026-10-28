// Visual packs for the same office state machine. A skin can rename rooms,
// replace HTML chrome through scoped CSS, change the canvas palette, and draw
// before or after a frame. Geometry, routing and hit boxes remain in office.html.
const GUILD_SPRITES = new Map()
function guildSprite(spec) {
  const key = JSON.stringify(spec)
  if (GUILD_SPRITES.has(key)) return GUILD_SPRITES.get(key)
  const c = document.createElement('canvas'); c.width = 32; c.height = 48
  const q = c.getContext('2d'); q.imageSmoothingEnabled = false
  const r = (x, y, w, h, color) => { q.fillStyle = color; q.fillRect(x, y, w, h) }
  const { job, hair, skin, armor, trim, back, frame, zipped, rank, sub, race } = spec
  if (sub) return fairySprite(c, q, r, spec)
  // Cape, feet and legs: a narrow little body beneath the large sprite head.
  if (job === 'lead' || job === 'write') { r(10, 25, 12, 14, '#3a2833'); r(9, 29, 2, 9, trim) }
  r(10 + frame, 42, 5, 3, '#2b2223'); r(18 - frame, 42, 5, 3, '#2b2223')
  r(11, 36, 4, 7, '#654330'); r(18, 36, 4, 7, '#654330')
  r(8, 25, 17, 12, '#261c20'); r(9, 24, 15, 12, armor)
  r(8, 27, 4, 5, trim); r(21, 27, 4, 5, trim)
  r(10, 32, 13, 2, '#3b2923'); r(15, 32, 3, 2, trim)
  r(7, 29, 3, 5, skin); r(23, 29, 3, 5, skin)
  // Head: stepped rows make a rounded silhouette at 32×48, with no vector AA.
  r(10, 5, 12, 2, '#281d20'); r(7, 7, 18, 3, '#281d20'); r(5, 10, 22, 9, '#281d20'); r(7, 19, 18, 4, '#281d20')
  r(10, 6, 12, 2, skin); r(8, 8, 16, 3, skin); r(6, 11, 20, 8, skin); r(8, 19, 16, 3, skin)
  // Hair is asymmetric and stepped, not a square helmet.
  r(9, 5, 14, 2, hair); r(7, 7, 18, 3, hair); r(6, 10, 5, 7, hair); r(22, 10, 4, 7, hair)
  r(10, 9, 5, 3, hair); if (spec.hairVariant) { r(15, 9, 7, 2, hair); r(20, 10, 4, 3, hair) } else { r(13, 9, 4, 2, hair); r(18, 9, 3, 4, hair) }
  if (back) {
    r(7, 10, 19, 10, hair); r(9, 19, 15, 4, hair)
    r(11, 21, 2, 3, '#281d20'); r(20, 21, 2, 3, '#281d20')
  } else {
    r(10, 14, 3, 3, '#2b2023'); r(20, 14, 3, 3, '#2b2023'); r(11, 14, 1, 1, '#fff7d8'); r(21, 14, 1, 1, '#fff7d8')
    r(9, 18, 3, 2, '#d8867e'); r(22, 18, 3, 2, '#d8867e')
    if (zipped) { for (let x = 13; x < 21; x += 2) r(x, 20 + ((x / 2) & 1), 2, 1, '#5d5153') }
    else r(15, 20, 4, 1, '#703b42')
  }
  // Head gear and held equipment change the silhouette per job.
  if (job === 'read') { r(5, 5, 23, 3, '#355a37'); r(10, 1, 13, 5, '#507845'); r(23, 2, 3, 7, trim) }
  else if (job === 'shell') { r(5, 6, 23, 2, '#3f3265'); r(10, 0, 13, 7, '#574684'); r(21, 0, 4, 3, '#574684'); r(23, 0, 2, 1, trim) }
  else if (job === 'code') { r(7, 5, 19, 3, '#326079'); r(11, 2, 12, 4, '#47859f'); r(14, 3, 6, 1, '#9ce0e7') }
  else if (job === 'ops') { r(5, 5, 23, 3, '#7d612b'); r(8, 2, 17, 4, '#a78036'); r(15, 0, 3, 3, '#efc755') }
  else if (job === 'lead') { r(6, 5, 21, 2, '#64465f'); r(10, 2, 13, 4, '#886183') }
  if (job === 'read') { r(25, 28, 6, 8, '#ddc887'); r(27, 29, 1, 6, '#875038') }
  else if (job === 'shell' || job === 'code') { r(27, 24, 2, 13, '#6c482b'); r(28, 22, 4, 4, trim) }
  else if (job === 'ops' || job === 'watch') { r(26, 25, 5, 10, '#30454f'); r(28, 23, 1, 3, '#91e8cf') }
  else if (job === 'write') { r(28, 23, 1, 14, '#e9cd72'); r(29, 22, 1, 3, '#fff2ad') }
  else { r(27, 25, 3, 11, '#644028'); r(28, 22, 1, 5, trim) }
  // Race marks over the shared body: long ears, a beard, tusks, horns.
  if (race === 'elf' && !back) { r(3, 12, 3, 2, skin); r(1, 10, 3, 2, skin); r(26, 12, 3, 2, skin); r(28, 10, 3, 2, skin); r(1, 10, 1, 1, '#281d20'); r(30, 10, 1, 1, '#281d20') }
  if (race === 'elf' && back) { r(1, 10, 4, 3, skin); r(27, 10, 4, 3, skin) }
  if (race === 'dwarf' && !back) { r(8, 17, 16, 6, hair); r(10, 23, 12, 3, hair); r(13, 26, 6, 2, hair); r(14, 19, 4, 1, '#703b42'); r(12, 24, 1, 1, trim); r(19, 24, 1, 1, trim) }
  if (race === 'orc' && !back) { r(12, 19, 1, 2, '#f4ecd2'); r(19, 19, 1, 2, '#f4ecd2') }
  if (race === 'tiefling') { r(7, 3, 3, 4, '#3a2630'); r(6, 1, 2, 3, '#3a2630'); r(22, 3, 3, 4, '#3a2630'); r(24, 1, 2, 3, '#3a2630') }
  if (!sub && rank >= 4) { r(11, 0, 12, 2, '#d59b2d'); r(11, 0, 3, 1, '#f1c84b'); r(16, 0, 2, 1, '#f1c84b'); r(21, 0, 2, 1, '#f1c84b') }
  GUILD_SPRITES.set(key, c)
  return c
}
// A subagent in the guild is a summoned sprite: a small glowing body, pointed
// ears, gossamer wings and a star on a wand, not a little copy of a member.
function fairySprite(c, q, r, spec) {
  const { skin, trim, armor, back, frame, zipped } = spec
  const wing = frame ? 'rgba(206,240,255,.78)' : 'rgba(226,248,255,.62)', vein = 'rgba(120,190,220,.8)'
  // Wings first, behind the body: upper and lower pair, a flap per frame.
  const up = frame ? 1 : 0
  r(1, 14 - up, 9, 8, wing); r(0, 16 - up, 2, 4, wing); r(22, 14 - up, 9, 8, wing); r(30, 16 - up, 2, 4, wing)
  r(3, 22, 7, 6, wing); r(22, 22, 7, 6, wing)
  r(4, 16 - up, 5, 1, vein); r(23, 16 - up, 5, 1, vein); r(5, 24, 4, 1, vein); r(23, 24, 4, 1, vein)
  // A leaf dress in the job's colour, bare legs, no boots.
  r(12, 26, 8, 3, armor); r(11, 29, 10, 5, armor); r(10, 33, 12, 2, trim)
  r(13, 35, 2, 6, skin); r(17, 35, 2, 6, skin); r(12 + frame, 41, 3, 2, trim); r(17 - frame, 41, 3, 2, trim)
  r(10, 27, 2, 4, skin); r(20, 27, 2, 4, skin)
  // Head: round, with long ears and a flower in the hair.
  r(11, 9, 10, 2, '#281d20'); r(9, 11, 14, 11, '#281d20'); r(11, 22, 10, 3, '#281d20')
  r(11, 10, 10, 2, skin); r(10, 12, 12, 10, skin); r(11, 22, 10, 2, skin)
  r(6, 13, 4, 2, skin); r(5, 12, 2, 1, skin); r(22, 13, 4, 2, skin); r(25, 12, 2, 1, skin)
  r(10, 9, 12, 3, '#f6d27a'); r(9, 11, 3, 5, '#f6d27a'); r(20, 11, 3, 5, '#f6d27a')
  r(19, 8, 3, 3, '#ff9fc6'); r(20, 9, 1, 1, '#fff2a8')
  if (!back) {
    r(12, 15, 2, 3, '#2b2023'); r(18, 15, 2, 3, '#2b2023'); r(12, 15, 1, 1, '#ffffff'); r(18, 15, 1, 1, '#ffffff')
    r(11, 19, 2, 1, '#ff9aa8'); r(19, 19, 2, 1, '#ff9aa8')
    if (zipped) r(14, 20, 4, 1, '#5d5153'); else r(15, 20, 2, 1, '#b4505c')
  }
  // The wand and its star.
  r(23, 22, 1, 9, '#c8a46a'); r(22, 19, 3, 3, '#fff2a8'); r(21, 20, 5, 1, '#fff2a8'); r(23, 18, 1, 5, '#fff2a8')
  GUILD_SPRITES.set(JSON.stringify(spec), c)
  return c
}
// The guild's members are of many peoples; a session keeps its race.
const GUILD_RACES = ['human', 'elf', 'dwarf', 'orc', 'halfling', 'tiefling', 'human', 'elf']
const GUILD_SKINS = { human: ['#f2c6a0', '#dca47f', '#b97c55', '#8a5a3c', '#f0b98c'], elf: ['#f3d9c0', '#e7c39d', '#c99a76'], dwarf: ['#e7b08a', '#c88d66', '#a56c4c'], orc: ['#8fae6a', '#7a9b5b', '#9cb37a'], halfling: ['#f2c6a0', '#d9a07a', '#b07a54'], tiefling: ['#c9727a', '#a9637c', '#b08ab8'] }
const GUILD_HAIR = { human: ['#4b3023', '#7b4c28', '#332b35', '#c8a052', '#d9d6ca'], elf: ['#e9dfb0', '#c9d6e3', '#3f2f4a', '#b4552e'], dwarf: ['#8b3a1c', '#5a3624', '#b9b2a2', '#c06a2b'], orc: ['#1f1a1d', '#3b2a22', '#4a4038'], halfling: ['#6b4126', '#a0662f', '#3a2a22'], tiefling: ['#221a2a', '#4a2240', '#e8e1ec'] }

window.OFFICE_SKINS = {
  office: {
    key: 'office',
    name: '🏢 모던 오피스',
    title: "🏢 __OFFICE_OWNER__네 사무실",
    zones: {
      library: ['📚 자료실', '파일·코드·웹을 읽고 찾을 때'],
      workshop: ['🛠 작업실', '명령 실행 (Bash · 모니터링)'],
      phone: ['📞 통화 부스', 'MCP로 외부 서비스 호출 중'],
      lounge: ['☕ 휴게실', '할 일 없이 대기 · 10분 넘으면 낮잠'],
    },
    palette: { ground: '#efe3cf', grid: 'rgba(160,120,80,.07)', sectionS: 40, sectionL: 90, podS: 55, podL: 87 },
    css: '',
  },
  guildhall: {
    key: 'guildhall',
    name: '⚔ 클래식 판타지 길드홀',
    title: "⚔ __OFFICE_OWNER__ 길드 회관",
    zones: {
      library: ['📜 기록 보관소', '고서·지도·마법 문서를 조사할 때'],
      workshop: ['⚒ 대장간', '명령을 실행하고 장비를 손볼 때'],
      phone: ['🔮 수정 통신실', '외부 길드·서비스와 통신할 때'],
      lounge: ['🍖 여관 홀', '의뢰 사이에 쉬고 체력을 회복할 때'],
    },
    palette: { ground: '#a78b61', grid: 'rgba(73,46,25,.16)', sectionS: 34, sectionL: 68, podS: 42, podL: 71 },
    deskColor: '#805533', deskLeg: '#49311f',
    css: `
body {
  --bg: #161715; --ink: #f7e8ba; --muted: #c4b58d; --card: #493722;
  --line: #281b12; --warn: #f0bd4f; --bad: #a94735; --ok: #78a65b;
  background-color: #161715;
  background-image: radial-gradient(ellipse at 52% 30%, rgba(111,75,39,.34), transparent 58%), repeating-linear-gradient(0deg, rgba(255,229,172,.025) 0 1px, transparent 1px 4px);
}
body::before { content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 20; opacity: .18; background-image: repeating-radial-gradient(circle at 20% 30%, transparent 0 2px, rgba(255,244,208,.16) 3px, transparent 4px); mix-blend-mode: soft-light; }
header h1 { color: #ffe8a3; text-shadow: 0 2px 0 #281b12, 0 0 12px rgba(240,189,79,.3); letter-spacing: .08em; }
.chip, #ask button { border-color: #25170e; box-shadow: inset 0 0 0 1px #8f6c37, 0 3px 0 #25170e; background: linear-gradient(#5c4428,#3e2d1c); color: #f8e7b6; }
#card, #settings, #help, #tip, #pickbar, #movebar, #quietmenu, #placemenu { background: #f1dfb4; color: #352315; border-color: #291a10; border-radius: 4px 13px 4px 13px; box-shadow: inset 0 0 0 2px #9b7543, 0 6px 0 #1f140d, 0 12px 24px rgba(0,0,0,.35); }
#card .said { background: #e4ce9f; border: 1px solid #a47a45; }
#card .ctabs button.on, #card .shelf .tabs button.on { background: #513920; color: #ffe9ac; }
#card .titlebar, #card .cfoot { background: #f1dfb4; box-shadow: 0 -8px 14px rgba(241,223,180,.94); border-color: #a47a45; }
canvas { filter: sepia(.24) saturate(.88) contrast(1.08) brightness(.9); image-rendering: auto; }
#hint kbd, kbd { border-radius: 3px; background: #4a3420; color: #ffeab0; border-color: #25170e; }
#ask .q { background: #d7a63e; color: #2c1c11; }
#ask .x { background: #963f30; color: #fff0ce; }
`,
    drawMeetingFloor({ tile, MEET }) { tile(MEET.x0, MEET.y0, MEET.x1 - MEET.x0, MEET.y1 - MEET.y0, '#755132', '#4c311f'); for(let x=MEET.x0+.15;x<MEET.x1;x+=.45)tile(x,MEET.y0+.12,.22,MEET.y1-MEET.y0-.24,'rgba(213,177,94,.12)',null) },
    drawFurniture(ctx, kind, args) {
      const { g, P, box, poly, circle, rrect, text, tile, cam, LINE, BOOKS, decorAt, meetingsNow, MEET, MEET_SEATS, deskHits, POOL, POOL_PEOPLE, POOL_SIZE, ents, drawCharacter } = ctx
      if (kind === 'shelf') {
        const [x, y] = args; box(x, y, 1.05, .38, 60, '#604126')
        for (let r0=0;r0<3;r0++) { box(x+.04,y+.3,.97,.05,3,'#3d2819',12+r0*18); for(let b=0;b<6;b++){const bx=x+.08+b*.145,c=BOOKS[(b+r0*2)%BOOKS.length]; poly([P(bx,y+.39,15+r0*18),P(bx+.11,y+.39,15+r0*18),P(bx+.11,y+.39,27+r0*18),P(bx,y+.39,27+r0*18)],c,LINE,.7)} }
        for(let k=0;k<3;k++){const [sx,sy]=P(x+.18+k*.29,y+.39,55);g.strokeStyle='#d6bd7d';g.lineWidth=2*cam.s;g.beginPath();g.moveTo(sx-5*cam.s,sy);g.lineTo(sx+5*cam.s,sy);g.stroke()}
        return true
      }
      if (kind === 'machine') {
        const [x,y,t]=args; box(x,y,.8,.65,12,'#665a4b'); box(x+.08,y+.08,.58,.45,22,'#3a3029',12); const [fx,fy]=P(x+.38,y+.53,25); rrect(fx-12*cam.s,fy-9*cam.s,24*cam.s,16*cam.s,2*cam.s,'#7b2f24'); g.save();g.globalAlpha=.55;circle(fx,fy-3*cam.s,(6+Math.sin(t*7)*1.5)*cam.s,'#ff9a3c',null);g.restore(); const [ax,ay]=P(x+.68,y+.2,38);poly([[ax-10*cam.s,ay],[ax+10*cam.s,ay],[ax+6*cam.s,ay-5*cam.s],[ax-5*cam.s,ay-5*cam.s]],'#47484b');box(x+.64,y+.17,.08,.08,20,'#4d3525');return true
      }
      if (kind === 'coffee') {
        const [x,y,t]=args; box(x,y,.62,.55,34,'#74451f'); for(let k=0;k<3;k++)box(x-.03,y+.1+k*.16,.68,.04,3,'#484047',8+k*9); const [mx,my]=P(x+.3,y+.54,40);rrect(mx-6*cam.s,my-7*cam.s,12*cam.s,8*cam.s,2*cam.s,'#cfaa61');for(let k=0;k<2;k++){const q=(t*.5+k/2)%1;g.save();g.globalAlpha=1-q;circle(mx+Math.sin(q*5)*3*cam.s,my-10*cam.s-q*12*cam.s,(2+q*2)*cam.s,'#fff1d0',null);g.restore()}return true
      }
      if (kind === 'sofa') {
        const [x,y]=args; box(x,y,2.3,.75,13,'#744b2c');box(x,y,2.3,.18,31,'#604126');box(x-.14,y,.18,.75,23,'#604126');box(x+2.28,y,.18,.75,23,'#604126');for(let k=0;k<3;k++)box(x+.13+k*.7,y+.18,.58,.46,8,k%2?'#7d4140':'#6f3738',13);return true
      }
      if (kind === 'plant') { const [x,y]=args;box(x,y,.42,.42,15,'#75502e');const [px,py]=P(x+.21,y+.21,32);for(let k=0;k<5;k++){const a=k*1.25;g.save();g.translate(px,py);g.rotate(a);g.fillStyle=k%2?'#618746':'#769b53';g.beginPath();g.ellipse(0,-8*cam.s,4*cam.s,10*cam.s,0,0,Math.PI*2);g.fill();g.restore()}return true }
      if (kind === 'readingTable') { const t=args[0],x=.6,y=.85;for(const lx of[x+.05,x+2.62])box(lx,y+.05,.07,.36,17,'#4d301d');box(x,y,2.7,.45,5,'#765033',17);for(let k=0;k<3;k++){box(x+.32+k*.84,y+.15,.48,.23,2,'#dbc48d',22);const[sx,sy]=P(x+.55+k*.84,y+.19,31);circle(sx,sy,3*cam.s,'#f0bd58',null);if(ctx.inRoom('library').length){g.save();g.globalAlpha=.14;circle(sx,sy,15*cam.s,'#ffd66d',null);g.restore()}}return true }
      if (kind === 'workbench') { const t=args[0],x=4,y=.9;for(const lx of[x+.05,x+1.6])box(lx,y+.05,.07,.32,20,'#4b3121');box(x,y,1.7,.4,5,'#745035',20);const[sx,sy]=P(x+.4,y+.3,34);poly([[sx-10*cam.s,sy],[sx+11*cam.s,sy],[sx+7*cam.s,sy-5*cam.s],[sx-6*cam.s,sy-5*cam.s]],'#535256');const[fx,fy]=P(x+1.25,y+.25,30);g.save();g.globalAlpha=.18;circle(fx,fy,(9+Math.sin(t*6))*cam.s,'#ff9b42',null);g.restore();circle(fx,fy,4*cam.s,'#f0ad48','#4f2b20',1);return true }
      if (kind === 'cafeTable') { const[x,y]=args;box(x+.27,y+.27,.07,.07,16,'#51351f');const[cx,cy]=P(x+.3,y+.3,18);g.fillStyle='#704a2c';g.beginPath();g.ellipse(cx,cy,21*cam.s,10*cam.s,0,0,Math.PI*2);g.fill();g.strokeStyle=LINE;g.stroke();for(let k=0;k<3;k++)circle(cx-8*cam.s+k*8*cam.s,cy-3*cam.s,3*cam.s,['#d5a64a','#9b493e','#d5c37d'][k],null);return true }
      if (kind === 'vending') { const[x,y]=args;box(x,y,.65,.52,21,'#674321');box(x+.04,y+.04,.57,.44,4,'#8b5d2f',21);for(let k=0;k<3;k++)box(x+.1+k*.16,y+.13,.1,.1,6,['#7ca05b','#b36b3d','#6a789c'][k],25);const[sx,sy]=P(x+.32,y+.51,35);rrect(sx-11*cam.s,sy-5*cam.s,22*cam.s,8*cam.s,2*cam.s,'#d2b26f',LINE,1);return true }
      if (kind === 'radiator') {
        // A low stone ember-box under the window. The old heraldic panel rose
        // through the glass and looked like the modern blind it replaced.
        const [y0] = args
        poly(ctx.leftQuad(y0 - .06, y0 + 1.16, 6, 21), '#696158', '#35291f', 1)
        poly(ctx.leftQuad(y0, y0 + 1.1, 8, 18), '#3a3028', '#211914', 1)
        for (let y = y0 + .12; y < y0 + 1; y += .18) poly(ctx.leftQuad(y, y + .04, 9, 17), '#1f1a16', null)
        const [a, b] = P(-.32, y0 + .55, 13); g.save(); g.globalAlpha = .14; circle(a, b, 12 * cam.s, '#ff9f45', null); g.restore(); text('✦', a, b, 8, '#dc9c45')
        return true
      }
      if (kind === 'chair') { const[x,y]=args;box(x+.5,y-.43,.45,.34,10,'#6a4428');box(x+.53,y-.39,.07,.07,22,'#49301f');box(x+.85,y-.39,.07,.07,22,'#49301f');return true }
      if (kind === 'decor') { const[w,t]=args,[x,y]=decorAt(w);if(w.decor==='plant'){box(x+.28,y+.18,.6,.45,18,'#76502d');for(let k=0;k<4;k++){const[sx,sy]=P(x+.38+k*.13,y+.43,35+k%2*7);circle(sx,sy,6*cam.s,k%2?'#668c4a':'#8daa5d')}}else if(w.decor==='shelf'){box(x+.08,y+.08,1.12,.34,48,'#644326');for(let k=0;k<5;k++)box(x+.15+k*.18,y+.15,.12,.18,4,BOOKS[k%BOOKS.length],48)}else if(w.decor==='beanbag'){box(x+.22,y+.16,.85,.52,20,'#704526');for(let k=0;k<3;k++)box(x+.3+k*.22,y+.25,.16,.18,6,['#8c3f3b','#667a47','#b18a43'][k],20)}else if(w.decor==='board'){box(x+.52,y+.25,.1,.1,24,'#604020');box(x+.23,y+.18,.68,.12,28,'#786145');const[sx,sy]=P(x+.57,y+.24,36);circle(sx,sy,8*cam.s,'#8e794d','#39291e',1.5)}else if(w.decor==='cat'){box(x+.22,y+.15,.85,.48,13,'#75502e');const[sx,sy]=P(x+.64,y+.4,21);circle(sx,sy,9*cam.s,'#d6944c');poly([[sx-6*cam.s,sy-6*cam.s],[sx-5*cam.s,sy-14*cam.s],[sx,sy-8*cam.s]],'#d6944c')}else{for(let k=0;k<3;k++)box(x+.24+k*.22,y+.18,.18,.32,22+k*7,['#794229','#6b824b','#96703e'][k])}return true }
      if (kind === 'meeting') {
        const[add,t]=args,m=meetingsNow[0],[tx0,tx1,ty0,ty1]=MEET.table
        add(MEET.x0+MEET.y0,()=>{box(MEET.x0,MEET.y0,.1,MEET.y1-MEET.y0,42,'#51331f');box(MEET.x1-.1,MEET.y0,.1,MEET.y1-MEET.y0,42,'#51331f');box(MEET.x0,MEET.y0,MEET.x1-MEET.x0,.1,6,'#6d482a',42)},[MEET.x0,MEET.x1,MEET.y0,MEET.y0+.1])
        add(tx1+ty1,()=>{for(const[lx,ly]of[[tx0+.1,ty0+.1],[tx1-.15,ty0+.1],[tx0+.1,ty1-.15],[tx1-.15,ty1-.15]])box(lx,ly,.06,.06,17,'#49301f');box(tx0,ty0,tx1-tx0,ty1-ty0,5,'#754c2d',17);const[cx,cy]=P((tx0+tx1)/2,(ty0+ty1)/2,23);text('◆',cx,cy,19,'#d1aa55');if(m){deskHits.push({sx:cx,sy:cy,r:30*cam.s,sid:m.lead,kind:'meeting',n:m.sids.length,meeting:m});text(m.sids.length+'명',cx,cy-9*cam.s,9,'#fff1c8')}},[tx0,tx1,ty0,ty1]);return true
      }
      if (kind === 'partition') {
        // A low timber balustrade with turned posts and a carved rail, the
        // section's colour as a pennant cloth instead of cubicle fabric.
        const [x0, x1, y, hue] = args
        box(x0, y, x1 - x0, .1, 6, '#5a3a22')
        for (let px = x0; px <= x1 + 1e-6; px += .45) box(Math.min(px, x1 - .08), y + .01, .08, .08, 22, '#6e4a2b', 6)
        box(x0, y - .01, x1 - x0, .12, 4, '#8a5f36', 26)
        for (let px = x0 + .9; px < x1 - .3; px += 1.8) { const [a1, b1] = P(px, y + .1, 26), [a2, b2] = P(px + .5, y + .1, 26); poly([[a1, b1], [a2, b2], [(a1 + a2) / 2, (b1 + b2) / 2 + 12 * cam.s]], ctx.hsl2hex(hue, 45, 48), '#2e1d12', .8) }
        return true
      }
      if (kind === 'exit') {
        // The great door: an arched oak gate in stone, a lantern for a sign.
        const [t] = args, { leftQuad, exitAt } = ctx
        const [d0, d1] = exitAt(), open = [...ents.values()].some((e) => e.leaving && e.kind === 'session')
        poly(leftQuad(d0 - .1, d1 + .1, 0, 54), '#7a7268', '#3b3329', 1)
        const arch = (y0, y1, z0, z1, fill, stroke) => { const pts = []; for (let i = 0; i <= 12; i++) { const a = Math.PI * i / 12, yy = (y0 + y1) / 2 - Math.cos(a) * (y1 - y0) / 2, zz = z1 + Math.sin(a) * 8; pts.push(P(-.3, yy, zz)) } poly([P(-.3, y0, z0), ...pts, P(-.3, y1, z0)], fill, stroke, 1) }
        arch(d0 - .1, d1 + .1, 0, 50, '#8a8175', '#3b3329')
        arch(d0, d1, 0, 46, open ? '#22180f' : '#6b4424', '#2e1d12')
        if (open) { g.save(); g.globalAlpha = .35; poly(leftQuad(d0 + .1, d1 - .02, 0, 44), '#ffcf7a', null); g.restore() }
        else { for (const yy of [d0 + .22, d0 + .45]) poly(leftQuad(yy, yy + .02, 0, 46), '#3d2615', null); for (const zz of [14, 34]) poly(leftQuad(d0 + .04, d1 - .04, zz, zz + 2.5), '#2b2b2e', null); const [kx, ky] = P(-.3, d1 - .14, 24); circle(kx, ky, 2 * cam.s, '#c99a3a', '#2e1d12', 1) }
        const [lx, ly] = P(-.3, d1 + .02, 60), fl = Math.sin(t * 8) * cam.s
        g.save(); g.globalAlpha = .16; circle(lx, ly, 18 * cam.s, '#ffb347', null); g.restore()
        rrect(lx - 4 * cam.s, ly - 6 * cam.s, 8 * cam.s, 10 * cam.s, 2 * cam.s, '#3a2a1a', '#1d130b', 1); circle(lx, ly - 1 * cam.s + fl * .3, 2.6 * cam.s, '#ffd36b', null)
        return true
      }
      if (kind === 'pool') return false
      return false
    },
    drawBooth(ctx, bx, t) {
      const { g, P, box, poly, circle, rrect, text, cam, inRoom, LINE } = ctx
      const y0 = .05, caller = inRoom('phone').find((e) => Math.abs(e.x - (bx + .3)) < .2 && e.y < 1.3)
      // An open carved alcove: stone plinth, timber uprights and a floating
      // crystal orb. There is no handset or phone icon in this skin.
      box(bx - .04, y0, .68, .65, 7, '#71695e')
      for (const sx of [bx, bx + .58]) { box(sx, y0, .08, .62, 62, '#49301e'); box(sx - .03, y0, .14, .2, 8, '#8d8374') }
      box(bx, y0, .66, .08, 8, '#50331e', 62)
      const [cx, cy] = P(bx + .31, y0 + .24, 39), pulse = 1 + Math.sin(t * 3 + bx) * .08
      g.save(); g.globalAlpha = caller ? .22 : .1; circle(cx, cy, 18 * pulse * cam.s, caller ? '#8ce7ef' : '#7b91a7', null); g.restore()
      circle(cx, cy, 8 * pulse * cam.s, caller ? '#8ce7ef' : '#7389a0', '#27344c', 1.2)
      circle(cx - 2 * cam.s, cy - 3 * cam.s, 2.5 * cam.s, '#e8ffff', null)
      const [lx, ly] = P(bx + .31, y0 + .67, 68)
      rrect(lx - 16 * cam.s, ly - 6 * cam.s, 32 * cam.s, 10 * cam.s, 3 * cam.s, caller ? '#d5bd68' : '#50402e', LINE, 1)
      text(caller ? 'LINK' : '✦', lx, ly - cam.s, 7, caller ? '#2c2417' : '#c6b278')
      // Orbiting runes make an active call visible without modern hardware.
      if (caller) for (let i = 0; i < 4; i++) { const a = t * 1.8 + i * Math.PI / 2; text('·', cx + Math.cos(a) * 14 * cam.s, cy + Math.sin(a) * 7 * cam.s, 9, '#d8ffff') }
    },
    drawWindow(ctx, w) {
      const { g, poly, circle, cam, sky } = ctx
      const { quad, at, a0, a1, z0, z1, t, seed } = w
      const am = (a0 + a1) / 2, shoulder = z1 - 9
      const pt = (a, z) => at(a, z)
      // A pointed stone opening with open oak shutters. The shared office
      // blind is not drawn in this skin.
      poly([pt(a0 - .12, z0 - 4), pt(a1 + .12, z0 - 4), pt(a1 + .12, shoulder), pt(am, z1 + 5), pt(a0 - .12, shoulder)], '#81786a', '#36281d', 1.2)
      const sk = sky(), pane = [pt(a0, z0), pt(a1, z0), pt(a1, shoulder), pt(am, z1 + 1), pt(a0, shoulder)]
      const gr = g.createLinearGradient(0, pane[3][1], 0, pane[0][1]); gr.addColorStop(0, sk.night ? '#28345f' : '#6195b1'); gr.addColorStop(1, sk.night ? '#56608c' : '#b9d5ce')
      poly(pane, gr, '#342b27', 1)
      // A little living sky remains behind the leaded glass.
      if (sk.night) {
        for (let k = 0; k < 4; k++) { const u = ((seed * 11 + k * 31) % 100) / 100, v = ((seed * 17 + k * 47) % 100) / 100; const [sx, sy] = pt(a0 + (a1 - a0) * (.1 + .8 * u), z0 + (shoulder - z0) * (.2 + .7 * v)); g.save(); g.globalAlpha = .55 + .35 * Math.sin(t * 2 + k); circle(sx, sy, 1.1 * cam.s, '#fff0ad', null); g.restore() }
      } else {
        const u = ((t * .018 + seed * .29) % 1.4) - .2
        if (u > 0 && u < 1) { const [cx, cy] = pt(a0 + (a1 - a0) * u, z1 - 15); g.save(); g.globalAlpha = .55; circle(cx, cy, 4.5 * cam.s, '#fff5dc', null); circle(cx + 4 * cam.s, cy + cam.s, 3.5 * cam.s, '#fff5dc', null); g.restore() }
      }
      // Lead bars make small diamond panes, including the pointed crown.
      const lead = '#3f3530', stroke = (a, z, b, zz, width = 1) => { const [x0, y0] = pt(a, z), [x1, y1] = pt(b, zz); g.strokeStyle = lead; g.lineWidth = width * cam.s; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke() }
      stroke(am, z0, am, z1 + 1, 1.3)
      for (let z = z0 + 8; z < shoulder; z += 9) stroke(a0, z, a1, z, 1)
      for (let z = z0; z < shoulder; z += 18) { stroke(a0, z, am, Math.min(shoulder, z + 9), .7); stroke(am, Math.min(shoulder, z + 9), a1, z, .7); stroke(a0, Math.min(shoulder, z + 9), am, z, .7); stroke(am, z, a1, Math.min(shoulder, z + 9), .7) }
      // Open shutters sit against the wall, with iron strap hinges.
      for (const [s0, s1] of [[a0 - .34, a0 - .13], [a1 + .13, a1 + .34]]) {
        poly(quad(s0, s1, z0 - 2, shoulder + 1), '#654020', '#2d1c12', 1)
        for (const z of [z0 + 5, z0 + 21]) poly(quad(s0, s1, z, z + 2), '#30251e', null)
      }
      poly(quad(a0 - .16, a1 + .16, z0 - 6, z0 - 3), '#6d6254', '#36281d', 1)
      return true
    },
    drawDeskGear(ctx, d) {
      const { g, P, box, poly, circle, cam, BOOKS } = ctx
      const { x, y, top, job, on, t } = d
      const aura = (gx, gy, z, color, r = 9) => { if (!on) return; const [sx, sy] = P(gx, gy, z); g.save(); g.globalAlpha = .18 + Math.sin(t * 5) * .05; circle(sx, sy, r * cam.s, color, null); g.restore() }
      if (job === 'code' || job === 'shell') {
        box(x + .9, y + .16, .36, .26, 3, '#474650', top); const [sx, sy] = P(x + 1.08, y + .29, top + 5); poly([[sx, sy - 11 * cam.s],[sx + 8 * cam.s,sy],[sx,sy + 5 * cam.s],[sx - 8 * cam.s,sy]], '#78c6df', '#2d4450', 1); aura(x + 1.08, y + .29, top + 9, '#75d8f0', 12)
        box(x + 1.36, y + .18, .08, .08, 18, '#6a452b', top); const [cx, cy] = P(x + 1.4, y + .22, top + 25); circle(cx, cy, 6 * cam.s, '#75bfe4', '#2b3045', 1); aura(x + 1.4, y + .22, top + 25, '#6fd7f2', 9)
      } else if (job === 'write') {
        box(x + .83, y + .18, .55, .34, 2, '#dfc98e', top); const [a,b] = P(x + 1.0,y + .34,top+3),[c,d2]=P(x + 1.3,y + .25,top+13); g.strokeStyle='#5c3524';g.lineWidth=1.5*cam.s;g.beginPath();g.moveTo(a,b);g.lineTo(c,d2);g.stroke(); circle(c,d2,2.2*cam.s,'#f5e3a6',null)
      } else if (job === 'watch') {
        box(x + .82, y + .18, .55, .1, 11, '#55422e', top); const [sx,sy]=P(x+1.1,y+.28,top+19); circle(sx,sy,11*cam.s,'#20253d','#ba9a62',2); circle(sx,sy,7*cam.s,'rgba(92,186,201,.75)',null); aura(x+1.1,y+.28,top+19,'#75d9e8',14)
      } else if (job === 'ops') {
        box(x + .95,y+.18,.4,.32,5,'#50483e',top); for(let i=0;i<3;i++){const [sx,sy]=P(x+1.02+i*.12,y+.48,top+9+i*4);circle(sx,sy,2.2*cam.s,['#e9b94d','#75d6c4','#d76d59'][i],null)} aura(x+1.15,y+.32,top+13,'#e2b94e',10)
      } else if (job === 'read') {
        for(let k=0;k<4;k++) box(x+.72+k*.12,y+.24,.32,.25,3,BOOKS[(k+2)%BOOKS.length],top+k*3)
      } else {
        box(x + .82,y+.22,.52,.28,2,'#d9c184',top); box(x+1.2,y+.18,.08,.08,14,'#72442b',top); const [sx,sy]=P(x+1.24,y+.22,top+20); circle(sx,sy,4*cam.s,'#c84f43','#4b2d29',1)
      }
    },
    addScene(ctx, add, t) {
      const { g, box, P, poly, circle, cam, text } = ctx
      // Deep timber posts and stone feet make the shared isometric shell read
      // as a rendered guild interior instead of a recoloured modern office.
      for (const x of [0.18, 3.72, 5.83, 8.12, 12.68, 17.52]) {
        add(x + .32, () => { box(x, .18, .18, .22, 58, '#49301e'); box(x - .06, .12, .3, .34, 7, '#777066'); box(x - .03, .15, .24, .28, 4, '#9a9081', 7) }, [x - .06, x + .24, .12, .46])
      }
      add(18.1, () => { box(.2, .12, 17.45, .13, 8, '#51321e', 56); box(.2, .13, 17.45, .09, 4, '#b88645', 64) }, [.2, 17.65, .12, .25])
      // Two wall torches with stepped brackets and light pools.
      for (const x of [5.2, 11.9]) add(x + .3, () => {
        const [sx, sy] = P(x, -.28, 43), flicker = Math.sin(t * 9 + x) * 2 * cam.s
        poly([[sx - 4 * cam.s, sy + 7 * cam.s], [sx + 4 * cam.s, sy + 7 * cam.s], [sx + 2 * cam.s, sy + 15 * cam.s], [sx - 2 * cam.s, sy + 15 * cam.s]], '#5a3824')
        g.save(); g.globalAlpha = .12; circle(sx, sy - 2 * cam.s, 32 * cam.s, '#ffb347', null); g.restore()
        circle(sx, sy + flicker, 6 * cam.s, '#f08b32', '#5a2b1a', 1); circle(sx, sy - 3 * cam.s + flicker, 3.5 * cam.s, '#ffe275', null)
      }, [x - .1, x + .1, -.3, -.2])
      // A guild crest projected over the meeting-room floor.
      add(14.7 + 3.9, () => { const [cx, cy] = P(15.15, 3.85, 1); g.save(); g.globalAlpha = .48; text('◆', cx, cy, 25, '#d6b45b'); text('⚔', cx, cy - 1 * cam.s, 11, '#5d3540'); g.restore() }, [14.8, 15.5, 3.55, 4.15])
    },
    // The shared accounts as the guild's mana ledger: the same board and rows
    // (office/resources.js), on parchment in a timber frame.
    drawResources(ctx, board, items, t) {
      if (typeof drawResourceBoard !== 'function') return true
      drawResourceBoard(ctx, board, items, t, { bg: '#e7d3a6', ink: '#3b2a1e', dim: '#7a6447', title: '#5a2f1c', frame: '#4a2f1e', heading: '🔮 마나 장부' })
      return true
    },
    afterFrame({ g, width, height }, t) {
      const alpha = 0.035 + Math.sin(t * 1.7) * 0.008
      g.save()
      g.globalCompositeOperation = 'screen'
      g.fillStyle = 'rgba(255,186,84,' + alpha + ')'
      g.fillRect(0, 0, width, height)
      g.restore()
    },
    drawCharacter(ctx, e, t, z0 = 0) {
      const { g, P, cam, hashOf, hsl2hex, picked, isZipped } = ctx
      const p = e.data, h = hashOf(e.id), sub = e.kind === 'sub', walking = !!e.walking
      let [x, y] = P(e.x, e.y, z0)
      const frame = walking && Math.sin(t * 10) > 0 ? 1 : 0
      y -= (walking ? Math.abs(Math.sin(t * 10)) * 2 : Math.sin(t * 2 + h) * .55) * cam.s
      e.sx = x; e.sy = y
      const job = p.job || 'shell'
      const armor = { shell: '#5c4b9b', read: '#6d8f46', code: '#3d6f91', write: '#985a78', watch: '#4f817d', talk: '#b06d3c', lead: '#7c596f', ops: '#a17a32' }[job] || '#6d628e'
      const trim = { shell: '#d9b95d', read: '#d9d18b', code: '#8ed0d8', write: '#e5aac2', watch: '#9fd1bd', talk: '#f0c16c', lead: '#d8b8d4', ops: '#f3c864' }[job] || '#d4c58d'
      const race = sub ? 'fairy' : GUILD_RACES[(h >>> 3) % GUILD_RACES.length]
      const hairs = GUILD_HAIR[race] || GUILD_HAIR.human, skins = GUILD_SKINS[race] || GUILD_SKINS.human
      const hair = hairs[(h >>> 6) % hairs.length], skinColor = sub ? '#ffe9d6' : skins[(h >>> 9) % skins.length]
      // A fairy flaps its wings all the time, not only when it walks.
      const flap = sub ? (Math.sin(t * 16 + h) > 0 ? 1 : 0) : frame
      const sprite = guildSprite({ job, hair, skin: skinColor, armor, trim, back: walking && !!e.back, frame: flap, zipped: isZipped(e.id), rank: p.rank || 0, sub, hairVariant: h % 2, race })
      // Halflings and dwarves stand shorter; a fairy hovers above its shadow.
      const tall = sub ? .78 : race === 'halfling' ? 1.3 : race === 'dwarf' ? 1.4 : 1.55
      const scale = cam.s * tall, w = sprite.width * scale, hh = sprite.height * scale
      if (sub) { y -= (6 + Math.sin(t * 3 + h) * 2) * cam.s; g.save(); g.globalAlpha = .22 + Math.sin(t * 4 + h) * .06; g.fillStyle = '#c9f3ff'; g.beginPath(); g.arc(x, y - hh * .45, 11 * cam.s, 0, Math.PI * 2); g.fill(); g.restore() }
      g.save(); g.imageSmoothingEnabled = false
      g.fillStyle = 'rgba(25,16,12,.26)'; g.beginPath(); g.ellipse(x, y + cam.s, 9 * cam.s, 3.2 * cam.s, 0, 0, Math.PI * 2); g.fill()
      if (picked.has(e.id)) { g.strokeStyle = '#78d7ec'; g.lineWidth = 2 * cam.s; g.setLineDash([3 * cam.s, 2 * cam.s]); g.beginPath(); g.ellipse(x, y, 12 * cam.s, 4 * cam.s, 0, 0, Math.PI * 2); g.stroke(); g.setLineDash([]) }
      if (e.sel) { const pulse = 1 + Math.sin(t * 5) * .08; g.strokeStyle = '#ffd35e'; g.lineWidth = 2 * cam.s; g.beginPath(); g.ellipse(x, y, 13 * cam.s * pulse, 4.5 * cam.s * pulse, 0, 0, Math.PI * 2); g.stroke() }
      if (walking && (e.faceX || 1) < 0) { g.translate(x, 0); g.scale(-1, 1); g.translate(-x, 0) }
      g.drawImage(sprite, Math.round(x - w / 2), Math.round(y - hh + 2 * cam.s), Math.round(w), Math.round(hh))
      if (walking && (e.faceX || 1) < 0) g.restore(); else g.restore()
      const icon = p.doing === 'alert' ? '!' : p.doing === 'asking' ? '?' : p.doing === 'done' ? '✓' : null
      if (icon) { const u = Math.max(1, Math.round(cam.s * 1.4)), by = y - hh - 4 * u; g.fillStyle = '#fff1c8'; g.fillRect(Math.round(x - 5 * u), Math.round(by), 10 * u, 7 * u); g.fillRect(Math.round(x - 2 * u), Math.round(by + 7 * u), 2 * u, 2 * u); g.fillStyle = '#38271d'; g.font = 'bold ' + Math.max(8, 5 * u) + 'px ui-monospace, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(icon, x, by + 3.5 * u) }
    },
  },
}
