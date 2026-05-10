const admin = require('firebase-admin');
const https = require('https');

// Firebase初期化
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// GitHub Secretsで改行文字が壊れる場合の修正
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// JSTの現在時刻を取得
function getJSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

// 対象日（YYYY-MM-DD）と通知モードを決定
// 20:00 JST → 翌日の稽古を「明日のお知らせ」として通知
//  7:00 JST → 当日の稽古を「本日のお知らせ」として通知
function getTargetInfo() {
  const now = getJSTNow();
  const hour = now.getUTCHours();
  const isMorning = hour < 15; // 15時未満 = 朝リマインド（当日）

  const target = new Date(now);
  if (!isMorning) {
    target.setUTCDate(target.getUTCDate() + 1); // 翌日
  }

  const dateStr = target.toISOString().split('T')[0]; // YYYY-MM-DD
  return { dateStr, isMorning };
}

// Discord Embedカラー
const COLOR_MORNING  = 0x2f9e44; // 緑（当日）
const COLOR_EVENING  = 0x3b5bdb; // 青（前日）

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
  const { dateStr, isMorning } = getTargetInfo();
  console.log(`対象日: ${dateStr} / モード: ${isMorning ? '当日(朝)' : '前日(夜)'}`);

  // schedules から slotId → date のマップを作成
  const schedSnap = await db.collection('schedules').get();
  const slotDateMap = {};
  schedSnap.forEach(doc => {
    const s = doc.data();
    (s.slots || []).forEach(slot => {
      if (slot.id && slot.date) slotDateMap[slot.id] = slot.date;
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

  // 日付表示を整形
  const dateObj    = new Date(dateStr + 'T00:00:00+09:00');
  const month      = dateObj.getMonth() + 1;
  const day        = dateObj.getDate();
  const weekday    = WEEKDAYS[dateObj.getDay()];
  const dateLabel  = `${month}月${day}日（${weekday}）`;

  const title = isMorning
    ? `🎭 本日の稽古のお知らせ　${dateLabel}`
    : `📅 明日の稽古のお知らせ　${dateLabel}`;
  const color = isMorning ? COLOR_MORNING : COLOR_EVENING;

  // Embedフィールドを構築（稽古ごとに1フィールド）
  const fields = targets.map(r => {
    // slotLabel から時間帯部分だけ取り出す（例："5/15(金) 午前" → "午前"）
    const timeLabel = (r.slotLabel || '').replace(/^\d+\/\d+\([^)]+\)\s*/, '').trim() || '—';
    const lines = [
      `🕐 ${timeLabel}`,
      r.venue ? `📍 ${r.venue}` : null
    ].filter(Boolean).join('\n');

    return {
      name: r.scriptName || '全体稽古',
      value: lines,
      inline: false
    };
  });

  const embed = {
    title,
    color,
    fields,
    footer: { text: 'メゾン・ドゥ・ココル 稽古管理システム' },
    timestamp: new Date().toISOString()
  };

  await sendToDiscord({ embeds: [embed] });
  console.log(`✅ ${targets.length}件の稽古リマインドを送信しました`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
