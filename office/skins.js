// Visual packs for the same office state machine. A skin can rename rooms,
// replace HTML chrome through scoped CSS, change the canvas palette, and draw
// before or after a frame. Geometry, routing and hit boxes remain in office.html.
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
#card .cfoot { background: #f1dfb4; box-shadow: 0 -8px 14px rgba(241,223,180,.94); border-color: #a47a45; }
canvas { filter: sepia(.24) saturate(.88) contrast(1.08) brightness(.9); image-rendering: auto; }
#hint kbd, kbd { border-radius: 3px; background: #4a3420; color: #ffeab0; border-color: #25170e; }
#ask .q { background: #d7a63e; color: #2c1c11; }
#ask .x { background: #963f30; color: #fff0ce; }
`,
    afterFrame({ g, width, height }, t) {
      const alpha = 0.035 + Math.sin(t * 1.7) * 0.008
      g.save()
      g.globalCompositeOperation = 'screen'
      g.fillStyle = 'rgba(255,186,84,' + alpha + ')'
      g.fillRect(0, 0, width, height)
      g.restore()
    },
  },
}
