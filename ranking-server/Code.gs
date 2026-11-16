/**
 * EKG 리듬 트레이너 — 공유 랭킹 서버 (Google Apps Script + 구글 시트)
 * 설치 방법은 같은 폴더의 README.md 를 보세요.
 * 시트에서 연 Apps Script 에 붙여넣어도 되고, script.google.com 새 프로젝트에 붙여넣어도 됩니다(시트를 스스로 만듦).
 *
 *   GET  ?action=top&limit=50&me=<플레이어 id>&sort=best|total|games  → 상위 랭킹 + 내 순위
 *        (best = 1회 최고 득점, total = 누적 점수, games = 플레이 횟수)
 *   POST {action:'submit', id, token, nickname, points, best, answered, correct}  → 점수 누적
 *   POST {action:'nick',   id, token, nickname}                                   → 닉네임 변경 (중복이면 error:'taken')
 *   GET  ?action=check&nickname=…&me=<id>                                          → 닉네임 사용 가능 여부
 *
 * 시트 'scores' 한 줄 = 플레이어 한 명. 이상한 기록은 시트에서 그 줄을 지우면 됩니다.
 * 토큰은 원문이 아니라 해시만 저장합니다 (같은 브라우저만 그 기록에 점수를 더할 수 있게).
 */
var SHEET_NAME = 'scores';
var HEAD = ['id', 'tokenHash', 'nickname', 'total', 'best', 'games', 'answered', 'correct', 'updatedAt'];
var LIMITS = {points: 60000, nick: 12, top: 100, answered: 400};

// ───────── 웹 요청 ─────────
function doGet(e){
  var p = (e && e.parameter) || {};
  if(p.action === 'top') return json_(top_(readRows_(), Number(p.limit) || 50, String(p.me || ''), String(p.sort || 'total')));
  if(p.action === 'check'){
    var nick = cleanNick_(p.nickname);
    return json_({ok: true, nickname: nick, available: !!nick && !nickTaken_(readRows_(), nick, String(p.me || ''))});
  }
  return json_({ok: true, service: 'ekg-trainer-leaderboard'});
}

function doPost(e){
  var body;
  try{ body = JSON.parse(e.postData.contents); }catch(err){ return json_({ok: false, error: 'bad_json'}); }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    var rows = readRows_();
    var out = body.action === 'submit' ? submit_(rows, body, Date.now())
            : body.action === 'nick' ? rename_(rows, body, Date.now())
            : {result: {ok: false, error: 'unknown_action'}};
    if(out.row) writeRow_(out.index, out.row);
    return json_(out.result);
  }finally{
    lock.releaseLock();
  }
}

// ───────── 규칙 (시트와 무관한 순수 함수) ─────────
function cleanNick_(s){
  // 제어문자 제거, 수식으로 해석될 수 있는 첫 글자(= + - @) 제거, 12자
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^[=+\-@\s]+/, '').slice(0, LIMITS.nick);
}
// 닉네임 중복 판단용: 띄어쓰기 · 대소문자 무시 ('응급실 김간호' = '응급실김간호')
function nickKey_(s){ return cleanNick_(s).toLowerCase().replace(/\s+/g, ''); }
function nickTaken_(rows, nick, id){
  var k = nickKey_(nick);
  if(!k) return false;
  for(var i = 0; i < rows.length; i++) if(rows[i].id !== id && nickKey_(rows[i].nickname) === k) return true;
  return false;
}
function validId_(s){ return typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s); }
function int_(v, max){ var n = Math.floor(Number(v)); return isFinite(n) && n >= 0 ? Math.min(n, max) : 0; }

function submit_(rows, b, now){
  if(!validId_(b.id) || !validId_(b.token)) return {result: {ok: false, error: 'bad_id'}};
  var pts = int_(b.points, LIMITS.points), answered = int_(b.answered, LIMITS.answered);
  var correct = Math.min(int_(b.correct, LIMITS.answered), answered), best = int_(b.best, LIMITS.points);
  var i = indexOf_(rows, b.id), hash = hash_(b.token), nick = cleanNick_(b.nickname);
  // 다른 사람이 쓰는 닉네임이면 점수는 받되 닉네임은 바꾸지 않음
  var taken = !!nick && nickTaken_(rows, nick, b.id);
  if(taken) nick = '';
  var row;
  if(i < 0){
    row = {id: b.id, tokenHash: hash, nickname: nick || ('익명-' + b.id.slice(1, 7)), total: pts, best: best, games: 1, answered: answered, correct: correct, updatedAt: now};
  }else{
    var r = rows[i];
    if(r.tokenHash !== hash) return {result: {ok: false, error: 'token'}};
    row = {id: r.id, tokenHash: r.tokenHash, nickname: nick || r.nickname, total: Number(r.total) + pts, best: Math.max(Number(r.best), best),
      games: Number(r.games) + 1, answered: Number(r.answered) + answered, correct: Number(r.correct) + correct, updatedAt: now};
  }
  return {index: i, row: row, result: {ok: true, total: row.total, nickname: row.nickname, nickTaken: taken}};
}

function rename_(rows, b, now){
  if(!validId_(b.id) || !validId_(b.token)) return {result: {ok: false, error: 'bad_id'}};
  var nick = cleanNick_(b.nickname);
  if(!nick) return {result: {ok: false, error: 'empty'}};
  var i = indexOf_(rows, b.id), hash = hash_(b.token);
  if(i >= 0 && rows[i].tokenHash !== hash) return {result: {ok: false, error: 'token'}};
  if(nickTaken_(rows, nick, b.id)) return {result: {ok: false, error: 'taken'}};
  var base = i >= 0 ? rows[i] : {id: b.id, tokenHash: hash, total: 0, best: 0, games: 0, answered: 0, correct: 0};
  var row = {id: base.id, tokenHash: base.tokenHash, nickname: nick, total: Number(base.total), best: Number(base.best),
    games: Number(base.games), answered: Number(base.answered), correct: Number(base.correct), updatedAt: now};
  return {index: i, row: row, result: {ok: true, nickname: nick}};
}

var SORTS = {best: true, total: true, games: true};
function top_(rows, limit, me, sort){
  var key = SORTS[sort] ? sort : 'total';
  // 정렬 기준이 같으면 누적 점수, 그다음 먼저 기록한 사람
  var sorted = rows.filter(function(r){ return r.id; }).sort(function(a, b){
    return Number(b[key]) - Number(a[key]) || Number(b.total) - Number(a.total) || Number(a.updatedAt) - Number(b.updatedAt);
  });
  var pub = function(r, i){
    return {rank: i + 1, nickname: String(r.nickname), total: Number(r.total), best: Number(r.best), games: Number(r.games),
      answered: Number(r.answered), correct: Number(r.correct), isMe: !!me && r.id === me};
  };
  var n = Math.max(1, Math.min(LIMITS.top, limit));
  var mi = me ? indexOf_(sorted, me) : -1;
  return {ok: true, sort: key, players: sorted.length, rows: sorted.slice(0, n).map(pub), me: mi >= 0 ? pub(sorted[mi], mi) : null};
}

function indexOf_(rows, id){
  for(var i = 0; i < rows.length; i++) if(rows[i].id === id) return i;
  return -1;
}

// ───────── 시트 · 해시 · 응답 ─────────
// 스프레드시트: 시트에서 연 스크립트면 그 시트, 따로 만든 스크립트(script.google.com)면 처음 한 번 'EKG 랭킹' 시트를 만들어 기억
function spreadsheet_(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if(ss) return ss;
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('SHEET_ID');
  if(id){ try{ return SpreadsheetApp.openById(id); }catch(e){ /* 지워졌으면 새로 만듦 */ } }
  ss = SpreadsheetApp.create('EKG 랭킹');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

// 편집기에서 한 번 실행하면 권한 승인 + 랭킹 시트 생성 (로그에 시트 주소 출력)
function setup(){
  var ss = spreadsheet_();
  sheet_();
  Logger.log('랭킹 시트: ' + ss.getUrl());
}

function sheet_(){
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if(sh.getLastRow() === 0) sh.appendRow(HEAD);
  return sh;
}
function readRows_(){
  var values = sheet_().getDataRange().getValues();
  return values.slice(1).map(function(v){ var o = {}; HEAD.forEach(function(h, k){ o[h] = v[k]; }); return o; });
}
function writeRow_(index, row){
  var sh = sheet_(), values = HEAD.map(function(h){ return row[h]; });
  if(index < 0) sh.appendRow(values);
  else sh.getRange(index + 2, 1, 1, HEAD.length).setValues([values]);
}
function hash_(token){
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token)));
}
function json_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
