# 네트워크가 나쁠 때 Claude Code harness가 만드는 부하 조사

- 조사 시각: 2026-10-24 11:42–12:00 KST
- 대상: 이 Mac의 Claude Code 세션 약 37개, cc-mods(`4f1ad19`), `~/.claude/hooks`, ccproxy(`0249970`), office, tweb, narwhal
- 방법: 읽기 전용 관찰, 코드 정적 분석, 기존 로그·transcript 분석. 네트워크를 끊거나 packet loss를 주입하지 않았다. 다른 세션·pane은 건드리지 않았다.
- 줄 번호: cc-mods는 커밋 `4f1ad19` 기준이다. 조사 도중 다른 세션이 작업 트리의 `hooks/register.ts`를 수정했으므로(+15줄) 작업 트리와 줄 번호가 다를 수 있다.

## 첫 화면 요약

**한 줄 결론:** 네트워크 오류가 tight loop를 만들지는 않는다. 부하는 세션 약 37개가 같은 외부 호출을 각자 반복하면서 생긴다. 이 반복은 세션 간 dedup이 실패 시 꺼지거나 처음부터 약해서 생긴다. 회복 직후에는 burst가 생긴다.

**가장 강한 증거 (측정값)**

| 증거 | 값 | 가리키는 결함 |
|---|---|---|
| 정상 네트워크에서 2분 동안 cc-mods `gh api graphql` 실행 | 16회, claude 세션 8개에서 각자 실행 (공유 캐시가 막는다면 기대값 약 3회) | H1 `pollPrs` dedup 실패 |
| ccproxy가 만든 `while kill -0 …; sleep 10` 셸 | 51개, 그중 38개가 이미 죽은 child를 지킴. 56초 동안 `sleep 10` 272회 (약 5 fork/s 상시) | H7 orphan guard 누수 |
| ccproxy fd | `CLOSED` TCP 312개(전체), pid 6660 하나가 195개 | H8 codex WS fd 누수 |
| 시스템 fork 속도 | 약 135 process/s, `opendirectoryd` 상시 약 90% CPU, 보안 에이전트가 exec마다 검사 | subprocess 1개의 비용이 커서 모든 증폭이 체감 부하로 이어짐 |
| 코드: `watchCredentials`(10초, 세션별) → `runRadar(force)` → module-local `mcpList` | credential 파일 1회 변경에 세션마다 `gh auth status` 2회와 `claude mcp list`(90초) 1개 | H2 회복 직후 최대 burst |

**우선 수정 후보**

1. **F5 ccproxy guard** (`internal/cursoracp/acp_backend.go:2077`): 루프 조건에 `kill -0 <child>`를 추가하는 한 줄 수정이다. 상시 약 5 fork/s를 없애고, PID 재사용 시 잘못된 SIGKILL을 막는다.
2. **F1 cc-mods `pollPrs`** (`hooks/register.ts:971,1007,1010`): `$.store`에 공유 lease와 실패 backoff(90초→15분)를 둔다. 실패한 tick에서 2.5MB store를 다시 쓰지 않는다. `gh auth token`을 캐시한다.
3. **F2 credential herd** (`:1093`, `:1142`): 강제 radar를 lease 하나로 묶는다. `mcpList`를 `$.store`로 옮겨 기계 전체에서 10분에 1회로 줄인다.
4. **F3 resume jitter** (`hooks/lib/resume.ts`): 세션별 `hash(sid) % 30s` jitter를 준다. 회복 직후 "keep going"이 한꺼번에 나가지 않는다.

**적용 상태 (2026-10-24 13:xx, 로컬 커밋, push 전)**

| 수정 | 위치 | 커밋 | 검증 |
|---|---|---|---|
| F1, F2, F3, F4 | `keyolk/cc-mods` branch `fix/net-degraded-dedup` (worktree `~/src/keyolk/cc-mods-netfix`) | `d33e467` | `claude plugin test` 170/170 통과, tsc·eslint 깨끗. lease를 끄는 mutation을 넣으면 새 테스트 4개 실패 |
| F5 | `sendbird/ccproxy` branch `fix/cursoracp-orphan-guard-child` (worktree `~/src/sendbird/ccproxy-guardfix`) | `89edba3` | 실제 프로세스로 하는 guard 테스트 3개와 `cursoracp` 패키지 전체 통과. 옛 스크립트로 되돌리면 누수 테스트 실패 |
| F6, F7 | 미적용 | – | – |

설계에서 바뀐 점: 세션 간 조율은 `$.store`가 아니라 `~/.claude/state/cc-mods/lease/*.json` 파일 lease로 한다(`$.fs`로 매번 읽음). `$.store.get`이 다른 세션의 쓰기를 바로 보는지 문서에 없고, 측정에서 공유 캐시가 신선한데도 8개 세션이 각자 poll했기 때문이다. guard는 리더 pid가 아니라 프로세스 그룹(`kill -0 -<pgid>`)을 본다. 그래야 `worker-server` helper가 남은 동안 계속 지킨다.

추가로 발견한 잠재 결함: `$.store`는 전체 JSON이 4 MiB를 넘으면 `set`을 reject한다(엔진 타입 정의). cc-mods store는 2.47MB이고 `outputs:*` 키 169개를 정리하지 않는다. 한도를 넘으면 모든 공유 캐시 쓰기가 실패한다.

**Claude Code 본체 vs harness:** 증폭 경로는 전부 harness(cc-mods, hooks, ccproxy)에 있다. 본체에서 확인한 것은 API 재시도와 `ps -A -o pid= -o ppid=`뿐이고, 둘 다 상한이 있다.

## 1. 결론

1. **네트워크 장애 자체가 tight retry loop를 만드는 경로는 찾지 못했다.** cc-mods, hooks, ccproxy의 timer와 retry는 모두 timeout과 주기가 있다. 장애 중 부하는 "폭주"가 아니라 **세션 수(N≈37)만큼 곱해지는 정상 주기 작업**이다.
2. **증폭의 핵심은 세션 간 dedup이 실패 시 꺼진다는 점이다.** cc-mods의 PR poll(`pollPrs`)과 credential radar(`runRadar`)는 공유 `$.store` 캐시로 중복을 줄인다. 그런데 실패하면 캐시 시각을 갱신하지 않거나(PR), 캐시를 우회하는 강제 경로(radar)가 있다. 이 경우 N개 세션이 각자 같은 외부 호출을 한다.
3. **회복 직후 burst 경로가 두 개 있다.** (a) `resumeProbe`가 모든 대기 세션에서 15초 안에 jitter 없이 "keep going"을 보낸다. (b) 로그인으로 credential 파일이 바뀌면 10초 안에 모든 세션이 `runRadar(force)`를 돌리고, 대부분이 `claude mcp list`(최대 90초, 모든 MCP 서버 health-check)를 띄운다.
4. **이 Mac은 subprocess 1개의 비용이 크다.** 시스템 전체가 약 135 process/s를 fork한다. `opendirectoryd`가 상시 약 90% CPU를 쓰고, endpoint security 클라이언트(Cyberhaven, Kandji ESF, xprotectd)가 exec마다 검사한다. 그래서 "N × 몇 개의 subprocess"가 체감 부하로 바로 이어진다.
5. **확실한 결함은 네 개다.** cc-mods `pollPrs` dedup 실패(측정), cc-mods credential-change herd(코드), ccproxy orphan guard 누수(코드+측정), ccproxy codex WebSocket fd 누수(코드+측정). 수정안과 hermetic test는 7절에 있다.
6. **Claude Code 본체 문제로 볼 증거는 약하다.** 본체에서 확인한 것은 API 재시도(약 10회, backoff+jitter)와 Bash 도구의 `ps -A -o pid= -o ppid=` 호출뿐이다. 처음에 본체 것으로 보였던 `while kill -0 …; sleep 10` 셸 51개는 ccproxy가 만든 것이다(6절).

## 2. 원인 후보 요약

| # | 후보 | 소유 | 판정 | 장애 중 증폭 | 회복 burst |
|---|---|---|---|---|---|
| H1 | `pollPrs` 실패 시 공유 캐시 미갱신, 평상시에도 dedup 약함 | cc-mods | **결함(측정)** | 약 N/2배 → N배 | 없음 |
| H2 | credential 파일 변경 → 전 세션 `runRadar(force)` + `claude mcp list` | cc-mods | **결함(코드)** | gh 실패가 "expired"로 보여 호출 추가 | **있음 (N개 동시)** |
| H3 | `resumeProbe` 회복 시 전 세션 동시 "keep going" | cc-mods | 설계 위험(코드) | 없음 (15초당 curl 1회/세션) | **있음 (대기 세션 수만큼)** |
| H4 | `pollSlack` in-flight 가드 없음, `$.mcp.call` timeout 없음 | cc-mods | 위험(코드, 추정) | MCP가 멈추면 3분마다 겹침 1개 추가 | 겹친 poll이 한꺼번에 끝남 |
| H5 | Stop 훅 `gh_pr_followup_stop_guard.py` 매 턴 gh 최대 4회 | `~/.claude/hooks` | 위험(코드) | 턴 종료가 최대 약 80초 지연 | 없음 |
| H6 | ccproxy 1회 재시도 × Claude Code 약 10회 재시도 | ccproxy + 본체 | 정상 설계 | 턴당 upstream 시도 최대 약 22회 | 세션 간 동시 재시도 |
| H7 | ccproxy orphan guard 셸 누수 | ccproxy | **결함(코드+측정)** | cursor-agent 재spawn마다 영구 셸 1개 | 없음 |
| H8 | ccproxy codex WS fd 누수 (`CLOSED` 소켓) | ccproxy | **결함(코드+측정)** | 재연결이 잦으면 누수가 빨라짐(추정) | 없음 |
| H9 | ccproxy 로그·stats flock 직렬화, 5MB 로그 전체 재작성 | ccproxy | 위험(코드) | 오류 로그가 몰리면 lock 경합 | 없음 |
| B1 | 상시 부하: office canvas 30fps, narwhal poll, neighbors, `$.store` 재작성 | cc-mods 외 | 네트워크와 무관 | 1배 | 없음 |

N은 cc-mods timer를 돌리는 interactive 세션 수다. 이번 측정에서 PR poll을 실제로 돌린 세션은 2분 동안 8개였다.

## 3. Baseline (11:42–12:00 KST)

### 3.1 프로세스와 CPU

| 항목 | 값 | 비고 |
|---|---|---|
| load average | 13.4 (11:42) → 47.0 (11:54) → 15.7 (11:59) | 14코어. 11:54 급등 때 CyberhavenSystemMonitor가 재시작 직후 139% CPU였고, 이 조사의 subagent 3개도 돌고 있었다 |
| 프로세스 수 | 1,135 | `claude` 37, `ccproxy` 38, `narwhal` 38, `sleep` 52, `sh` 51 |
| tmux | session 4, window 34, pane 58 | |
| `opendirectoryd` | 상시 약 90% CPU (누적 448분) | 대량 fork/exec의 user·group 조회로 추정 |
| 상위 CPU | ccproxy 49897 79%(일시 스파이크), claude 7525 50%, claude 36645 40%, Ghostty 30%, WindowServer 30% | ccproxy 49897은 `sample` 결과 idle이었다 |
| tweb host + helper | 합계 약 45% CPU, host RSS 650–920MB | office 페이지를 30fps로 그린다 (B1) |

### 3.2 fork 속도와 귀속 (56초 샘플, 0.1초 간격 `ps`)

시스템 전체 PID 증가는 56초에 7,557이다(약 135/s). 샘플로 잡은 새 프로세스 2,160개를 조상별로 나누면 다음과 같다. 짧게 사는 프로세스는 놓치므로 하한값이다.

| 조상 | 관측 수 | 주요 자식 |
|---|---|---|
| claude 세션 (이 조사 세션 제외) | 865 | `tmux`, `ps`, `curl`(narwhal poll), `git`, `security`, `python3 cc-bridge.py neighbors`, `gh api graphql`, `gh auth status`, `cship` |
| ccproxy wrapper | 352 | `sleep 10` 272, `sh -c while kill -0` 43 (H7) |
| 이 조사 세션 | 160 | 측정용 `ps`/`sleep` |
| tmux 서버 | 73 | `fish` 등 |
| `secure-mesh-enforcer.sh` | 56 | `dig`, `grep`, `date` |
| Spotlight, Iru(Kandji), SetStoreUpdateService, Chrome, office.py, tweb | 각 17–35 | |

Claude 세션 아래 1단계 자식 상위: `tmux` 47, `ps` 47, `curl` 45, `narwhal mcp` 37, `rea-agents mcp` 37, `curl -s -m 5`(narwhal) 28, `cc-bridge.py neighbors` 25, `ps -A -o pid=`(본체) 25, `npm exec codex-mcp-server` 22, `gh api graphql` 8, `gh auth status` 6.

### 3.3 fd

| 프로세스 | 열린 fd | TCP |
|---|---|---|
| ccproxy 38개 합계 | 1,300 | ESTABLISHED 307, **CLOSED 312**, LISTEN 38 |
| claude 37개 합계 | 1,244 | ESTABLISHED 114 |
| ccproxy 6660 (4일 21시간) | 216 | **CLOSED 195** (H8) |
| ccproxy 39670 / 8814 / 3552 | 85 / 42 / 39 | CLOSED 64 / 23 / 20 |

### 3.4 로그·transcript·저장소 증가

| 대상 | 측정 | 판단 |
|---|---|---|
| `~/.claude/projects/*.jsonl` | 10분 동안 2.4MB (3.9KB/s), 대부분 이 조사 세션 | 정상 |
| `~/.claude/plugins/store/cc-mods_inline-9b2f2af42aa2.json` | 2.47MB. 30초 동안 39번 바뀜(≥1회/s 재작성). `outputs:*` 키 169개(1.58MB), `prs` 588개(0.31MB) | 정리(prune)가 없다. 네트워크와 무관하지만 매 쓰기 비용이 계속 커진다 |
| `~/.ccproxy/ccproxy.log` | 5MB 상한, 4.5MB/22,217줄이 08:28–11:50만 덮음. 시간당 2.4k→8.9k줄 | 24–48시간 분석 불가 |
| `~/.ccproxy/monitor` | 4.1GB. 10-21에 `no space left on device` 기록 | 디스크 |
| `~/.claude/snapshots` | 4.2GB, 7일에 1.2GB 증가 (`pre_compact.py`) | 디스크 |
| 디스크 | Data 볼륨 95% 사용, 22GiB 남음 | 별도 정리 필요 (읽기 전용 범위라 정리하지 않음) |
| `~/.claude/debug`, `daemon.log` | 10-15/10-16 이후 변화 없음. daemon은 꺼져 있음 | 무관 |

### 3.5 과거 장애 흔적 (최근 7일 transcript)

- API Error 68개 파일. network 계열은 `dial tcp … operation timed out` 6건, `Connection lost mid-response` 6건, sleep 관련 8건, `stream error … CANCEL` 3건이다. 나머지는 quota·정책·모델 오류다.
- 10-23 16시–10-24 02시의 5xx 급증은 cursor-acp quota 거절 812건이었다. 네트워크 장애가 아니다.
- cc-mods가 보낸 "keep going"은 67건이다. 10분 구간에 최대 2건이었다. 즉 **과거에는 회복 burst가 작았다.** 장애가 짧았거나, 장애 시점에 턴이 진행 중인 세션이 적었기 때문으로 추정한다.
- ccproxy monitor turn 기록(50시간, 10,539 turn): `dial tcp` timeout 26건, `context canceled` 106건, stream cut 2건.

## 4. Timer·poll 루프 목록 (cc-mods, 세션마다)

`$.clock.every`는 콜백을 한 주기에 한 번 부른다. 콜백이 `() => void f($)`이므로 엔진은 `f`의 완료를 기다리지 않는다. 그래서 `f`가 주기보다 오래 걸리면 다음 실행과 겹친다. `$.process.run`의 기본 timeout은 30초, 최대 10분이다(plugin-authoring 타입 정의).

| 루프 (`register.ts`) | 주기 | 1회 작업 | timeout | 겹침 | 세션 간 dedup | 실패 시 |
|---|---|---|---|---|---|---|
| `runRadar` :2898 | 5분 | `gh auth status`, expired 계정마다 `gh api user`, `ccproxy status`, 조건부 `claude mcp list` | 8s/8s/8s/90s | 가능 (가드 없음) | `K.radar` 150초. 강제 경로는 우회 | 캐시를 그대로 기록. gh 실패는 "expired"로 보임 |
| `watchCredentials` :2899 | 10초 | `stat` 5개 | – | – | **없음 (세션마다 stamp)** | 변경 시 `runRadar(force)` |
| `pollPrs` :2900 | 90초 | 계정마다 `gh auth token` + `gh api graphql`, GitOps PR마다 `gh` comment | 5s/20s/20s | 드묾 | `K.prs` 45초 freshness | **캐시 시각 미갱신 → 모든 세션이 poll** |
| `pollSlack` :2901 | 3분 | 스레드 최대 10개 `slack_read_thread` 순차, 채널명 조회 | **없음** | **가능** | 없음 (세션 소유 스레드) | `continue` |
| `pollNarwhal` :2902 | 20초 | localhost `curl` 2개 | 5s(-m)/8s | 없음 | 없음 | 무시. 네트워크 무관 |
| `resumeProbe` :2904 | 15초 | 대기 중일 때만 `curl -I https://api.anthropic.com/` | 6s/9s | 없음 | 없음 | 회복 시 "keep going" |
| `refreshNeighbors` :2911 | 60초 | `tmux list-windows`, `python3 cc-bridge.py neighbors`, 5분마다 exp sums | 3s/8s/20s | 드묾 | 없음 | 무시. 네트워크 무관 |
| `officeInbox` :2912 | 2초 | `fs.exists` 1회 | – | 가드 있음 | – | – |
| redraw :2915 | 5초 | 상태 읽기 | – | – | – | – |
| `refreshMcpList` :459 | radar 안에서 10분 | `claude mcp list` | 90s | 세션 안 가드만 | **없음 (module-local `mcpList`)** | 결과가 비면 다음 radar에서 다시 실행 |

턴마다 도는 작업(네트워크 관련): `turn.complete`의 `bridge('attention')`(Jev HTTPS, bridge 8초), `loadUsage`(로컬 ccproxy 2–3개), Stop 훅들(H5).

## 5. 원인 후보 상세

### H1. `pollPrs`: 실패 시 dedup이 꺼지고, 평상시에도 dedup이 거의 안 된다 — 결함

**코드 (`register.ts`):**
- :971 `fresh`는 선택된 PR **전부**의 `cache[k].at`이 45초 이내일 때만 참이다.
- :980 계정마다 매 tick `ghEnv`가 `gh auth token --user`를 새로 띄운다(캐시 없음).
- :1005–1008 `catch {}`: 네트워크 오류면 `cache[k]`를 갱신하지 않는다. 그래서 `fresh`가 계속 거짓이다.
- :1010 그래도 `$.store.set(K.prs, cache)`는 매번 실행한다. 2.5MB 공유 store 재작성이 따라온다.

**관측 증거:**
- 정상 네트워크에서 2분 동안 `gh api graphql`(cc-mods argv)이 16회, 서로 다른 claude 부모 8개에서 떴다.
- 공유 캐시가 제대로 막는다면 기대값은 2분에 약 3회다. 한 poll 뒤 45초 동안 나머지가 쉬기 때문이다.
- 같은 시점에 store의 선택 PR 7개는 모두 15초 이내로 신선했다. 그래서 "실패로 인한 미갱신" 외에도 세션 사이 `$.store` 읽기가 서로의 쓰기를 늦게 보거나, 다른 호출 경로가 있다고 추정한다. 원인은 확정하지 못했다(9절).

**재현 조건:** `gh api graphql`이 실패하거나 20초 timeout에 걸린다(DNS 실패, packet loss, GitHub 장애, rate limit).

**예상 증폭:**
- 장애 중: 세션마다 90초에 계정 수 × (`gh auth token` + `gh api graphql`)를 실행한다. `gh`는 `~/.local/shims/gh`를 거친다. 다만 `GH_TOKEN`이 있으면 `pass`를 건너뛴다.
- N=37, 계정 2개면 90초에 148 프로세스(≈1.6/s)이다. 각 graphql은 최대 20초 매달린다. 동시에 매달린 `gh`는 평균 약 16개다.
- 정상 대비 약 N/2배다(정상에서도 이미 dedup이 약하므로 실측 대비로는 2–4배).

### H2. credential 변경 herd와 `claude mcp list` — 결함

**코드:**
- :1087–1093 `watchCredentials`는 세션마다 10초마다 SSO 캐시, argocd config, gh `hosts.yml`, `daemon-auth-status.json`의 mtime을 본다. 하나라도 바뀌면 `runRadar($, true)`를 부른다.
- :1108 `force`이면 공유 radar 캐시를 무시한다.
- :1118–1135 `gh auth status`(8초)는 API 확인이 실패하면 계정을 "expired"로 표시한다(주석이 직접 이렇게 설명한다). 그러면 계정마다 `sh -c 'GH_TOKEN=$(gh auth token …) gh api user'`(8초)를 추가로 띄운다.
- :1142 `mcpList`와 `mcpListRunning`은 module-local이다. 각 세션의 `mcpList`는 대개 비어 있거나 10분보다 오래됐다. 공유 radar 캐시 덕분에 그 세션이 full radar를 거의 돌리지 않기 때문이다. 그래서 강제 radar에서 거의 모든 세션이 `claude mcp list`(:462, 90초)를 띄운다.
- :465–466 성공하면 `runRadar(true)`를 한 번 더 부른다. 그래서 `gh auth status`가 세션당 2회가 된다.

**`claude mcp list`가 무거운 이유:** 새 claude(node) 프로세스가 설정된 모든 MCP 서버에 health-check를 한다. stdio 서버는 실제로 띄운다(`narwhal mcp`, `bunx rea-agents@latest`, `npm exec codex-mcp-server` 등). `@latest`와 `npm exec`는 레지스트리 조회를 할 수 있다. 그래서 네트워크가 나쁘면 오래 걸린다(추정, 미검증). claude.ai 원격 connector도 수십 개 연결한다.

**재현 조건 (회복 burst):** 장애 뒤 사용자가 `aws sso login`이나 `gh auth refresh`를 한다. 또는 aws CLI가 SSO 캐시를 갱신한다. 그러면 10초 안에 모든 세션이 같은 변화를 본다. 최근 SSO 캐시 변경은 10-24 08:40, `hosts.yml`은 10-21이었다. 하루 몇 번 생기는 이벤트다.

**예상 증폭:** 이벤트 1번에 N × (`gh auth status` 2 + 계정당 `gh api user` + `ccproxy status` + `claude mcp list` 1개와 그 stdio 서버들)이 10초 안에 몰린다. N=37이면 `claude mcp list` 최대 37개(각 RSS 수백 MB)와 MCP 서버 수백 개가 동시에 뜬다. 장애가 계속되면 `mcpList`가 채워지지 않아 다음 radar에서 다시 시도한다.

### H3. `resumeProbe`: 회복 직후 동시 "keep going" — 설계 위험

**코드:** `lib/resume.ts`의 `backoff`는 network 클래스에 고정 10초다. jitter가 없다. `register.ts:1309–1335`는 15초 tick마다 `apiReachable`(curl `-m 6`)를 확인한다. 도달 가능하면 바로 `$.prompt.submit('keep going')`을 보낸다. 세션 간 조율이 없다. ccproxy auto-continue(세션당 최대 2회)와 Claude Code 자체 재시도도 따로 돈다.

**재현 조건:** 여러 세션이 턴 도중 network 오류로 멈춘다. 네트워크가 돌아온다.

**예상 증폭:** 대기 세션 K개가 15초 안에 동시에 새 턴을 시작한다. 각 턴은 전체 context를 다시 보낸다. 장애가 길어 prompt cache가 식었으면 비용과 지연이 커진다. 과거 7일 최대치는 10분에 2건이었다(3.5절). K가 큰 장애는 아직 없었다.

### H4. `pollSlack`: 겹침 가능 — 위험(추정)

**코드:** :583–600. in-flight 플래그가 없다. `$.mcp.call(SLACK_SERVER, 'slack_read_thread', …)`에 timeout이 없다. 스레드 최대 10개를 순차 호출하고, 채널명 조회(:567)도 같다.

**재현 조건:** Slack MCP(claude.ai connector)가 응답하지 않고 매달린다. `$.mcp.call`의 엔진 기본 timeout은 확인하지 못했다.

**예상 증폭:** 매달린 동안 3분마다 겹친 poll이 1개씩 늘어난다(세션당). CPU 비용은 작다. 회복 순간 겹친 poll이 동시에 끝나 같은 toast와 `followUpSlack`이 중복될 수 있다(:621–624, `followDue` 가드가 일부 막는다).

### H5. Stop 훅의 동기 `gh` — 위험

(`~/.claude/hooks` 감사 결과, 코드 확인)
- `gh_pr_followup_stop_guard.py`(Stop, 조건 없음): cwd가 GitHub repo이면 매 턴 `gh pr view`를 실행한다. PR이 있으면 최대 4회이고, 각 20초 timeout이다(:31, :80, :91, :105, :148). `settings.json`에 훅 timeout이 없다.
- `stop_phrase_guard.sh` → `jev_dodge_check.py`: Jev HTTPS 호출, urlopen 3초. 이 timeout은 DNS 조회에는 걸리지 않는다(추정).
- 로그: `gh pr view … timed out` 1건, Stop 훅 전체 `hook_cancelled` 2일(10-06, 10-23).
- 영향: CPU보다 **턴 종료 지연**이다(최대 약 80초). 세션 37개에서 턴이 끝날 때마다 gh 1–4회가 추가된다.
- 같은 감사에서 확인한 사실: Bash 도구 호출 1회마다 PreToolUse 17개 + PostToolUse 3개 훅이 약 29개 프로세스를 띄운다(`uv run` 9개 포함). 네트워크는 쓰지 않지만 exec 비용이 큰 이 Mac에서는 상시 부하다.

### H6. ccproxy 재시도 × Claude Code 재시도 — 정상 설계, 곱셈 주의

(ccproxy 감사 결과, 코드 확인)
- transport 오류: `CloseIdleConnections` 후 100ms 쉬고 1회 재시도한다(`internal/proxy/retry_transport.go:108-138`).
- 5xx: 다른 usable 계정으로 rotation한다(최대 계정 수 5). 503/529만 cooldown을 건다(`anthropic_upstream.go:274-305`).
- codex: network error를 200 assistant 메시지로 바꾼다. 그래서 Claude Code가 재시도하지 않는다(`codex/transport_errors.go:63-71`).
- timeout: dial 10s, TLS 10s, response header 180s, body 상한 없음(`proxy/proxy.go:263-291`).
- Claude Code 본체가 약 10회 backoff 재시도를 한다고 가정하면, network 오류 1번이 upstream 시도 약 22회가 된다. 시도마다 blackhole에서 최대 약 200초 매달린다. tight loop는 없다.

### H7. ccproxy orphan guard 누수 — 결함

**코드:** `~/src/sendbird/ccproxy/internal/cursoracp/acp_backend.go:2066-2088` `guardAgainstOrphaning`. cursor-agent를 spawn할 때마다 detached `sh`를 하나 띄운다.

```sh
while kill -0 <ccproxy pid> 2>/dev/null; do sleep 10; done; kill -9 -<child> …
```

- 주석은 "exits on its own as soon as either side disappears"라고 한다. 하지만 스크립트는 ccproxy pid만 확인한다. child가 먼저 죽어도 guard는 ccproxy가 끝날 때까지 남는다.
- 측정: guard 51개, 그중 38개가 이미 없는 child를 지킨다. guard 전체가 10초마다 `sleep`을 fork해 상시 약 5 fork/s다(56초 샘플에서 `sleep 10` 272개).
- 네트워크 관련성: 요청 실패와 rotation 때 cursor-agent를 다시 띄우면 guard가 1개씩 영구히 늘어난다(추정). 증가는 선형이고 상한이 없다.
- 추가 위험: ccproxy가 끝나면 guard가 오래된 pgid로 `kill -9 -<pgid>`를 보낸다. 그 사이 PID가 재사용됐다면 관계없는 프로세스 그룹이 SIGKILL될 수 있다.

### H8. ccproxy codex WebSocket fd 누수 — 결함

(ccproxy 감사 결과, 코드 확인)
- `internal/codex/ws_session.go`의 registry에 idle TTL과 reaper가 없다. 서버가 idle WS를 닫아도 같은 key를 다시 쓸 때까지 `conn.Close`를 부르지 않는다.
- `Register`가 기존 session을 Close하지 않고 덮어쓴다(:105-113). 이전 session의 `onClose`는 `current == session` 비교가 거짓이라 아무것도 하지 않는다(`transport_ws.go:320-328`).
- 측정: pid 6660(4일 21시간)이 chatgpt.com 계열 주소(100.97.50.165)로 `CLOSED` 소켓 195개를 쥐고 있다.
- 누수량은 네트워크 오류보다 프로세스 나이와 codex 대화 수를 따라간다(추정). 재연결이 잦으면 빨라진다.

### H9. ccproxy 로그·stats lock — 위험

- `SaveStats`가 30초마다 무조건 `stats.json`을 flock + read + write 한다. `c.Mu.RLock`을 쥔 채로 flock을 기다린다(`cmd/ccproxy/commands.go:396-408`, `config/stats.go:33-83`). 37개 프로세스면 약 1.2 write/s다.
- 로그 writer는 줄마다 flock + stat + open + write + close를 하고, 5MB를 넘으면 파일 전체를 읽어 절반을 다시 쓴다(`cmd/ccproxy/log_writer.go:24-56`).
- 장애 중 오류 로그가 몰리면 37개 프로세스가 같은 lock을 두고 다툰다(추정).

### B1. 네트워크와 무관한 상시 부하 (참고)

| 항목 | 비용 | 근거 |
|---|---|---|
| office 페이지를 tweb pane이 30fps로 렌더링 | tweb host + GPU + renderer 약 45% CPU | `office.html:2633` rAF, tweb frame-rate 정책 |
| office JS `/state` 2초 poll | 2초마다 `tmux list-panes` + working 세션마다 `capture-pane` | `office.html:2785`, `office.py:381,390`. 응답이 2초를 넘으면 겹친다 |
| `pollNarwhal` | 세션마다 20초에 curl 2개 (N=37이면 약 3.7 fork/s) | :1382, :1391 |
| `refreshNeighbors` | 세션마다 60초에 python3 1개 + tmux | :1522 |
| `$.store` 재작성 | 2.5MB 파일을 ≥1회/s 재작성, 키 prune 없음 | 3.4절 |
| ccproxy guard `sleep` | 약 5 fork/s | H7 |

## 6. Claude Code 본체 vs harness 구분

| 관측 | 소유 | 증거 |
|---|---|---|
| `ps -A -o pid= -o ppid= …` (56초에 25회 이상) | **Claude Code 본체** | claude 실행 파일 문자열: `S("ps",["-A","-o","pid=","-o","ppid=",…])` (Bash 도구 process tree 추적·kill) |
| API 재시도·backoff | **Claude Code 본체** | ccproxy는 `CLAUDE_CODE_MAX_RETRIES`를 바꾸지 않는다. 횟수(약 10)는 미검증 |
| stdio MCP 서버 spawn (`narwhal mcp`, `rea-agents`, `codex-mcp-server`) | 본체 동작, **설정은 harness** | 세션마다 1세트. `claude mcp list`가 1세트를 추가로 띄운다 (H2) |
| `while kill -0 …; sleep 10` 셸 51개 | **ccproxy** (본체 아님) | 부모가 ccproxy. 스크립트 문자열이 `acp_backend.go:2077`과 같다. cc-mods와 `~/.claude/hooks`에는 `kill -0`이 없다 |
| `gh api graphql`, `gh auth status`, `gh auth token`, `curl -s -m 5`, `curl -sk -m 6 -I`, `python3 cc-bridge.py`, `claude mcp list` | **cc-mods** | argv가 `register.ts`의 `$.process.run` 호출과 정확히 같다. 부모가 claude 프로세스다 |
| `/opt/homebrew/bin/gh api graphql`, `pr-watch` | `~/.claude/scripts/pr-watch`, Monitor | 부모가 `python3 ~/.claude/scripts/pr-watch` |
| Stop/PreToolUse 훅 프로세스 | `~/.claude/settings.json` 훅 | 훅 감사 |
| `opendirectoryd`, Cyberhaven, Kandji ESF, xprotectd CPU | OS·보안 에이전트 | exec 수에 비례하는 비용. harness가 exec를 줄이면 같이 준다 |

결론: 이번에 찾은 증폭 경로는 전부 harness(cc-mods, hooks, ccproxy) 쪽이다. 본체 쪽은 재시도 정책과 process tree 조회만 확인했고, 둘 다 상한이 있다.

## 7. 최소 수정안과 hermetic test

코드는 아직 수정하지 않았다. 테스트는 기존 `tests/mod.test.ts` 패턴(`on('process.run', …)` stub, `mock.clock(on)`)과 `tests/lib.test.ts`의 순수 함수 테스트를 따른다. 실제 네트워크·HOME을 쓰지 않는다.

### F1. `pollPrs`: 공유 lease와 실패 backoff (H1)

1. `lib/prs.ts`에 순수 함수 `prPollDue(gate, now, sid)`를 둔다. `gate`는 `$.store`의 `K.prsGate = { leaseBy, leaseUntil, failUntil, fails }`이다.
2. poll 전에 `failUntil > now`이거나 다른 세션의 lease가 유효하면 건너뛴다. 아니면 `leaseUntil = now + 30s`를 쓰고 poll한다.
3. 실패하면 `fails + 1`, `failUntil = now + min(90s × 2^fails, 15m)`을 쓴다. 성공하면 `fails = 0`으로 둔다.
4. 실패한 tick에서는 `$.store.set(K.prs, cache)`를 하지 않는다.
5. `ghEnv` 결과를 계정별로 10분 캐시한다.

테스트:
- `lib.test.ts`: `prPollDue`가 (a) 다른 세션 lease 중이면 false, (b) 실패 3회 뒤 360초 동안 false, (c) 15분에서 멈추는지.
- `mod.test.ts`: `process.run` stub이 `gh api graphql`에 exitCode 1과 `dial tcp … timeout`을 돌려준다. `mock.clock`으로 10분을 진행한다. graphql 호출 수가 backoff 수열(90, 180, 360…)과 맞는지, `gh auth token`이 계정당 1회인지 센다.

### F2. credential herd 제거 (H2)

1. `watchCredentials`의 강제 radar를 공유 lease 아래에서만 실행한다: `K.radarLease`를 잡은 세션 하나만 `runRadar(true)`를 돌린다. 나머지는 `K.radar.at`이 변화 시각보다 새로워질 때까지 store를 읽기만 한다.
2. `mcpList`를 module-local 변수에서 `$.store`(`K.mcpList`)로 옮긴다. `refreshMcpList`도 같은 lease를 쓴다. 기계 전체에서 10분에 최대 1회가 된다.
3. `runRadar`에 module-level in-flight promise를 둔다. 실행 중이면 그 promise를 돌려준다.
4. (선택) gh 계정이 "expired"로 보여도, 같은 실행의 `gh api user`가 network 오류면 상태를 `unknown`으로 둔다. 이렇게 하면 장애가 "로그인 필요" band로 바뀌지 않는다.

테스트(`mod.test.ts`): 같은 fake store를 공유하는 세션 3개를 시작한다. credential 파일 stat stub의 mtime을 한 번 바꾸고 `clock.advance(10_000)`을 한다. `gh auth status`가 1회, `claude mcp list`가 1회인지 확인한다. 같은 harness에서 세션 여러 개를 띄울 수 없다면, lease 판단을 `lib/auth.ts`의 순수 함수로 빼서 `lib.test.ts`에서 확인한다.

### F3. resume jitter와 동시 실행 상한 (H3)

1. `lib/resume.ts`의 `decide`에 `jitterMs`를 추가한다: `hash(sid) % 30_000`. `reachable`이 처음 참이 된 뒤 `jitterMs`가 지나야 `resume`을 돌려준다.
2. (선택) `$.store`의 `K.resumeSlots`로 30초에 최대 4개 세션만 resume한다.

테스트(`lib.test.ts`): 서로 다른 sid 20개에서 `decide`가 `resume`을 돌려주는 시각이 30초 창에 퍼지는지, 같은 sid는 결정적인지 확인한다.

### F4. `pollSlack` 가드 (H4)

1. module-level `slackPolling` 플래그를 둔다(`officeBusy`와 같은 패턴).
2. 각 `$.mcp.call`을 `Promise.race([call, $.clock.sleep(20_000).then(() => { throw … })])`로 감싼다.

테스트(`mod.test.ts`): `mcp.call` stub이 resolve하지 않는다. `clock.advance(3 × 180_000)` 동안 stub 호출이 첫 tick의 1회를 넘지 않는지 확인한다.

### F5. ccproxy orphan guard (H7)

```sh
while kill -0 <ccproxy> 2>/dev/null && kill -0 <child> 2>/dev/null; do sleep 10; done
kill -0 <ccproxy> 2>/dev/null || kill -9 -<child> 2>/dev/null || kill -9 <child> 2>/dev/null
```

child가 먼저 죽으면 guard는 아무도 죽이지 않고 끝난다. PID 재사용 SIGKILL 위험도 사라진다.

테스트(Go, `acp_backend_test.go`): poll 간격을 테스트에서 100ms로 주입한다. `sleep 0.2`를 child로 띄우고 guard를 시작한다. child 종료 뒤 1초 안에 guard 프로세스가 끝나는지, 다른 프로세스에 signal을 보내지 않는지 확인한다. 테스트는 `t.TempDir()`과 자체 child만 쓴다.

### F6. codex WS registry (H8)

1. `Register`가 기존 session이 있으면 `Close`한다.
2. 5분 주기 reaper가 idle TTL(예: 10분)을 넘은 session을 닫는다(cursor-acp reaper 패턴).

테스트(Go): fake `net.Conn`을 쓴다. 같은 key로 `Register`를 두 번 부르면 첫 conn의 `Close`가 1회 불리는지 확인한다. fake clock을 TTL만큼 진행하면 reaper가 닫는지 확인한다.

### F7. Stop 훅 timeout (H5)

`settings.json`의 `gh_pr_followup_stop_guard.py` 항목에 `"timeout": 25`를 준다. 스크립트 안에서는 branch별 "PR 없음" 결과를 짧게(예: 5분) 캐시해 PR이 없는 repo의 매 턴 `gh pr view`를 없앤다. 테스트는 `HOME`을 `tmp_path`로 바꾸고 `gh`를 PATH 앞의 fake 스크립트로 둔 pytest로, 두 번째 Stop에서 fake `gh`가 불리지 않는지 확인한다.

## 8. 우선순위

| 순위 | 수정 | 이유 |
|---|---|---|
| 1 | F5 (ccproxy guard) | 한 줄 수정. 상시 약 5 fork/s 제거. 잘못된 SIGKILL 위험 제거 |
| 2 | F1 (pollPrs) | 정상 네트워크에서도 측정상 dedup이 안 된다. 장애 중 N배 |
| 3 | F2 (credential herd) | 회복 직후 가장 큰 burst (`claude mcp list` N개) |
| 4 | F3 (resume jitter) | 회복 burst. 수정이 작고 순수 함수 테스트가 쉽다 |
| 5 | F6, F4, F7 | 누수·겹침·지연. 영향이 느리게 쌓인다 |

## 9. 확인하지 못한 것

- **`$.store`의 세션 간 일관성.** H1에서 공유 캐시가 신선한데도 8개 세션이 각자 poll했다. `$.store.get`이 프로세스 메모리 사본을 읽는지, 파일을 매번 읽는지는 엔진 문서에 없다. cc-mods에 `$.ui.log(…, { to: 'debug' })`로 poll 이유(fresh 여부, 키별 age)를 남기면 확정할 수 있다.
- **`$.mcp.call`의 기본 timeout.** H4의 크기는 이 값에 달려 있다.
- **Claude Code 본체 재시도 횟수.** 약 10회는 일반 동작 기준 추정이다.
- **`claude mcp list`의 stdio 서버가 90초 timeout 때 같이 정리되는지.** 정리되지 않으면 H2의 burst가 orphan으로 남는다.
- **실제 degraded network 재현.** 지시에 따라 네트워크를 건드리지 않았다. 재현이 필요하면 다음 방법을 쓴다: `gh`를 PATH 앞의 fake 스크립트(`sleep 20; exit 1`)로 둔 격리 subprocess에서 cc-mods mod test를 돌린다. 또는 localhost에 응답하지 않는 TCP 서버를 띄우고 `GH_HOST`/`https_proxy`를 그쪽으로 향하게 한다.
- 11:54의 load 47 급등은 CyberhavenSystemMonitor 재시작(139% CPU)과 이 조사의 subagent 3개가 겹친 시점이다. harness 원인으로 단정하지 않는다.

## 부록: 측정 원본

`/private/tmp/claude-502/-Users-gavin-jeong-src-keyolk-cc-mods/f0d74d64-2f7f-47ec-b5d9-22939836c74a/scratchpad/baseline/`
- `ps1.txt` — 11:42 전체 프로세스 목록
- `s3.txt` — 56초 0.1초 간격 `ps` 샘플 (fork 귀속)
- `lsof.txt` — claude·ccproxy·tweb·narwhal·tmux fd
- `probes.txt` — 2분간 `gh`/`claude mcp list`/`ccproxy status` 샘플
- `jsonl_t0.txt` — transcript 크기 기준점
