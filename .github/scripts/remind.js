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

// "5/11(月)" → "2026-05-11" に変換
function parseDateLabel(dateLabel) {
  const match = (dateLabel || '').match(/^(\d+)\/(\d+)/);
  if (!match) return null;
  const month = parseInt(match[1]);
  const day   = parseInt(match[2]);
  const now   = getJSTNow();
  let year    = now.getUTCFullYear();
  // 月が現在より小さければ来年と判定
  if (month < now.getUTCMonth() + 1) year++;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// JSTの現在時刻を取得
function getJSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// 対象日（YYYY-MM-DD）を返す（当日 12:00 JST に送信）
function getTargetInfo() {
  const now = getJSTNow();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD（JST基準）
  return { dateStr };
}

// Discord Embedカラー
const COLOR_TODAY = 0x2f9e44; // 緑

// Discord Webhookに送信
async function sendToDiscord(payload) {
  const body = JSON.stringify(payload);
  const url  = new URL(process.env.DISCORD_WEBHOOK_URL);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`Discord: HTTP ${res.statusCode}`);
        if (res.statusCode >= 400) reject(new Error(`Discord error ${res.statusCode}: ${data}`));
        else resolve();
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const { dateStr } = getTargetInfo();
  console.log(`対象日: ${dateStr}`);

  // schedules から slotId → date のマップを作成
  const schedSnap = await db.collection('schedules').get();
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

  // rehearsals を取得して対象日で絞り込み
  const rehSnap = await db.collection('rehearsals').get();
  const targets = [];
  rehSnap.forEach(doc => {
    const r = doc.data();
    if (slotDateMap[r.slotId] === dateStr) {
      targets.push(r);
    }
  });

  if (targets.length === 0) {
    console.log(`${dateStr} の稽古なし → 通知スキップ`);
    return;
  }

  // 日付表示を整形（YYYY-MM-DDから直接パースしてタイムゾーンのズレを防ぐ）
  const [y, m, d]  = dateStr.split('-').map(Number);
  const dateObj    = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const month      = m;
  const day        = d;
  const weekday    = WEEKDAYS[dateObj.getUTCDay()];
  const dateLabel  = `${month}月${day}日（${weekday}）`;

  // メッセージ本文を構築（稽古ごとに1ブロック）
  const blocks = targets.map(r => {
    const timeLabel = (r.slotLabel || '').replace(/^\d+\/\d+\([^)]+\)\s*/, '').trim() || '—';
    return [
      `本日の稽古は${timeLabel}からです！よろしくおねがいします。`,
      ``,
      `チーム：『${r.scriptName || '全体稽古'}』`,
      r.venue ? `場所：${r.venue}` : null,
      `――――――――――`
    ].filter(v => v !== null).join('\n');
  }).join('\n\n');

  const content = `@everyone\n📅 稽古のお知らせ　${dateLabel}\n\n${blocks}`;

  await sendToDiscord({ content });
  console.log(`✅ ${targets.length}件の稽古リマインドを送信しました`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
