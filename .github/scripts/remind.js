const admin = require('firebase-admin');
const https = require('https');

// Firebase初期化（base64デコード）
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// JSTの現在時刻を取得
function getJSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// "5/11(月)" → "2026-05-11" に変換
function parseDateLabel(dateLabel) {
  const match = (dateLabel || '').match(/^(\d+)\/(\d+)/);
  if (!match) return null;
  const month = parseInt(match[1]);
  const day   = parseInt(match[2]);
  const now   = getJSTNow();
  let year    = now.getUTCFullYear();
  if (month < now.getUTCMonth() + 1) year++;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// 対象日（YYYY-MM-DD）を返す
function getTargetDate() {
  const now = getJSTNow();
  return now.toISOString().split('T')[0];
}

// LINE Messaging APIに送信
async function sendToLine(message) {
  const token   = process.env.LINE_CHANNEL_TOKEN;
  const groupId = process.env.LINE_GROUP_ID;
  if (!token || !groupId) {
    console.log('LINE_CHANNEL_TOKEN or LINE_GROUP_ID未設定 → スキップ');
    return;
  }

  const body = JSON.stringify({
    to: groupId,
    messages: [{ type: 'text', text: message }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.line.me',
      path: '/v2/bot/message/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`LINE: HTTP ${res.statusCode}`);
        if (res.statusCode >= 400) reject(new Error(`LINE error ${res.statusCode}: ${data}`));
        else resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const dateStr = getTargetDate();
  console.log(`対象日: ${dateStr}`);

  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj   = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday   = WEEKDAYS[dateObj.getUTCDay()];
  const dateLabel = `${m}月${d}日（${weekday}）`;

  const targets = [];

  // ① takenoko_schedules → takenoko_rehearsals（日程調整ルート）
  const schedSnap = await db.collection('takenoko_schedules').get();
  const slotDateMap = {};
  schedSnap.forEach(doc => {
    const s = doc.data();
    (s.slots || []).forEach(slot => {
      if (slot.id && slot.dateLabel) {
        const parsed = parseDateLabel(slot.dateLabel);
        if (parsed) slotDateMap[slot.id] = parsed;
      }
    });
  });

  const rehSnap = await db.collection('takenoko_rehearsals').get();
  rehSnap.forEach(doc => {
    const r = doc.data();
    // 直接登録（direct:true）は date フィールドで判定
    if (r.direct) {
      if (r.date === dateStr) targets.push(r);
    } else {
      if (slotDateMap[r.slotId] === dateStr) targets.push(r);
    }
  });

  if (targets.length === 0) {
    console.log(`${dateStr} の稽古なし → 通知スキップ`);
    return;
  }

  // メッセージ組み立て
  const lines = [`📅 本日の稽古　${dateLabel}\n`];
  targets.forEach(r => {
    const scriptLabel = (r.scripts && r.scripts.length > 0)
      ? r.scripts.map(s => s.name).join('・')
      : (r.scriptName || '全体稽古');

    let timeLabel = '—';
    if (r.direct) {
      if (r.startTime) timeLabel = r.endTime ? `${r.startTime}〜${r.endTime}` : `${r.startTime}〜`;
    } else {
      timeLabel = (r.slotLabel || '').replace(/^\d+\/\d+\([^)]+\)\s*/, '').trim() || '—';
    }

    lines.push(`🎭 ${scriptLabel}`);
    lines.push(`🕐 ${timeLabel}`);
    lines.push(`📍 ${r.venue || '未定'}`);
    if (r.notes) lines.push(`📝 ${r.notes}`);
    lines.push('');
  });
  lines.push('たけのっ子劇場 稽古管理システム');

  const message = lines.join('\n');
  await sendToLine(message);
  console.log(`✅ LINE: ${targets.length}件の稽古リマインドを送信しました`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
