async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
function genToken() { const arr = new Uint8Array(24); crypto.getRandomValues(arr); return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function getSession(db, token) { if (!token) return null; return await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first(); }
async function getConfig(db) {
  const rows = await db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  (rows.results || []).forEach(r => { try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; } });
  return cfg;
}
async function setConfig(db, key, value) {
  const v = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  await db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, v).run();
}
function parseUser(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, nickname: row.nickname,
    credit: row.credit, income: row.income, deposit: row.deposit,
    payMethod: row.pay_method ? JSON.parse(row.pay_method) : null,
    inviteCode: row.invite_code || null,
    invitedBy: row.invited_by || null,
    createdAt: row.created_at
  };
}
function parseOrder(row) {
  if (!row) return null;
  return { id: row.id, orderNo: row.order_no, amount: row.amount, commission: row.commission, payType: row.pay_type, desc: row.description, status: row.status, publisherId: row.publisher_id, publisherName: row.publisher_name, credit: row.credit, takers: JSON.parse(row.takers || '[]'), createdAt: row.created_at };
}
function parseRefund(row) {
  if (!row) return null;
  return { id: row.id, userId: row.user_id, userName: row.user_name, amount: row.amount, address: row.address, status: row.status, createdAt: row.created_at };
}

const TARGET_COUNT = 30;
const FRESH_COUNT = 10;
const FRESH_WINDOW_MS = 30 * 60 * 1000;
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const ROOT_INVITE_CODE = '888888';

function randomAmount() {
  const raw = Math.floor(Math.random() * 4501 + 500);
  return Math.round(raw / 50) * 50;
}

async function createRandomOrder(db, forceFresh = false) {
  const id = uid();
  const orderNo = '2026' + Math.floor(100000000000 + Math.random() * 900000000000);
  const amount = randomAmount();
  const commission = Math.round(amount * 0.08);
  const payTypes = ['支付宝固定小额', '银行转账', '微信收款码', '其他方式'];
  const payType = payTypes[Math.floor(Math.random() * payTypes.length)];
  const desc = '按订单要求完成收款操作，审核通过后返佣。';
  const createdAt = forceFresh ? Date.now() - Math.floor(Math.random() * 5 * 60 * 1000) : Date.now() - Math.floor(Math.random() * 24 * 60 * 60 * 1000);
  await db.prepare('INSERT INTO orders (id, order_no, amount, commission, pay_type, description, status, publisher_id, publisher_name, credit, takers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, orderNo, amount, commission, payType, desc, 'pending', 'admin', '官方发布', 100, '[]', createdAt).run();
}

async function createFinishedOrder(db) {
  const id = uid();
  const orderNo = '2026' + Math.floor(100000000000 + Math.random() * 900000000000);
  const amount = randomAmount();
  const commission = Math.round(amount * 0.08);
  const fakeNames = ['张**', '李**', '王**', '陈**', '刘**', '赵**', '孙**', '周**', '吴**', '郑**', '冯**', '黄**'];
  const fakeName = fakeNames[Math.floor(Math.random() * fakeNames.length)];
  const createdAt = Date.now() - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000);
  const takers = JSON.stringify([{ userId: 'fake_' + id, userName: fakeName, payMethod: { type: 'alipay', realName: fakeName, account: '138****8888' }, at: createdAt, status: 'done', doneAt: createdAt + 120000 }]);
  await db.prepare('INSERT INTO orders (id, order_no, amount, commission, pay_type, description, status, publisher_id, publisher_name, credit, takers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, orderNo, amount, commission, '支付宝固定小额', '系统已完成订单', 'paid', 'admin', '官方发布', 100, takers, createdAt).run();
}

async function refreshFinishedOrderTimes(db) {
  const rows = await db.prepare("SELECT id FROM orders WHERE status = 'paid'").all();
  const list = rows.results || [];
  if (!list.length) return;
  for (const row of list) {
    if (Math.random() < 0.7) {
      const newTs = Date.now() - Math.floor(Math.random() * 6 * 60 * 60 * 1000) - 60000;
      await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(newTs, row.id).run();
    }
  }
}

async function autoFillOrders(db) {
  const countRow = await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").first();
  const current = Number(countRow.c) || 0;
  const need = Math.max(0, TARGET_COUNT - current);
  for (let i = 0; i < need; i++) { await createRandomOrder(db, false); }

  const freshRow = await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending' AND created_at >= ?").bind(Date.now() - FRESH_WINDOW_MS).first();
  const freshCount = Number(freshRow.c) || 0;
  if (freshCount < FRESH_COUNT) {
    const needFresh = FRESH_COUNT - freshCount;
    const oldest = await db.prepare("SELECT id FROM orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?").bind(needFresh).all();
    for (const row of (oldest.results || [])) {
      const newTs = Date.now() - Math.floor(Math.random() * 20 * 60 * 1000);
      await db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(newTs, row.id).run();
    }
  }

  const paidRow = await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'paid'").first();
  const paidCount = Number(paidRow.c) || 0;
  const needPaid = Math.max(0, 15 - paidCount);
  for (let i = 0; i < needPaid; i++) { await createFinishedOrder(db); }

  try { await refreshFinishedOrderTimes(db); } catch(e) {}

  return { added: need, total: current + need, fresh: freshCount, paid: paidCount + needPaid };
}

async function checkUsdtDeposit(db, toAddress, expectedAmount) {
  const minTimestamp = Date.now() - 30 * 60 * 1000;
  const url = `https://api.trongrid.io/v1/accounts/${toAddress}/transactions/trc20?limit=50&only_to=true&min_timestamp=${minTimestamp}`;
  let data = null;
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    data = await res.json();
  } catch (e) {
    return { ok: false, error: '链上查询失败：' + e.message };
  }
  const list = (data && data.data) || [];
  const expectedUnits = Math.round(Number(expectedAmount) * 1e6);
  for (const tx of list) {
    if (tx.type !== 'Transfer') continue;
    if (!tx.token_info || tx.token_info.address !== USDT_CONTRACT) continue;
    const value = Number(tx.value);
    if (value !== expectedUnits) continue;
    const used = await db.prepare('SELECT tx_hash FROM deposits WHERE tx_hash = ?').bind(tx.transaction_id).first();
    if (used) continue;
    return { ok: true, txHash: tx.transaction_id, from: tx.from, amount: value / 1e6, timestamp: tx.block_timestamp };
  }
  return { ok: false, error: '未检测到匹配的到账记录，请确认转账已完成或稍后再试' };
}

async function generateInviteCode(db) {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const exist = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(code).first();
    if (!exist) return code;
  }
  return null;
}

/* =========================================================
   充值播报记录：自动维护 200 条，随机刷新时间+金额
   ========================================================= */
const PAY_USERNAMES = ['李**','王**','张**','陈**','刘**','赵**','孙**','周**','吴**','郑**','冯**','黄**','林**','何**','马**','朱**','胡**','郭**','罗**','高**','梁**','宋**','谢**','唐**','许**','韩**','冯**','邓**','曹**','彭**'];

async function createPayRecord(db) {
  const id = uid();
  const username = PAY_USERNAMES[Math.floor(Math.random() * PAY_USERNAMES.length)];
  const amount = Math.floor(Math.random() * 9501 + 500);
  const createdAt = Date.now() - Math.floor(Math.random() * 24 * 60 * 60 * 1000);
  await db.prepare('INSERT INTO pay_records (id, username, amount, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, username, amount, createdAt).run();
}

async function ensurePayRecords(db) {
  // 1. 补足到 200 条
  const countRow = await db.prepare("SELECT COUNT(*) as c FROM pay_records").first();
  const current = Number(countRow.c) || 0;
  if (current < 200) {
    const need = 200 - current;
    for (let i = 0; i < need; i++) {
      await createPayRecord(db);
    }
  }

  // 2. 每次请求，随机挑 25-45 条记录
  //    → 时间改成最近 60 分钟内
  //    → 金额也重新随机生成（500-10000）
  //    这样"近1小时笔数"和"近1小时金额"都会实时变动
  const pickCount = 25 + Math.floor(Math.random() * 21); // 25 ~ 45
  const rows = await db.prepare("SELECT id FROM pay_records ORDER BY created_at ASC LIMIT ?")
    .bind(pickCount).all();
  for (const row of (rows.results || [])) {
    const newTs = Date.now() - Math.floor(Math.random() * 60 * 60 * 1000);
    const newAmount = Math.floor(Math.random() * 9501 + 500); // 500 ~ 10000
    await db.prepare('UPDATE pay_records SET created_at = ?, amount = ? WHERE id = ?')
      .bind(newTs, newAmount, row.id).run();
  }
}export async function onRequest(context) {
  const { request, env, params } = context;
  const path = '/' + (params.path || []).join('/');
  const method = request.method;
  const db = env.DB;

  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (!db) return json({ error: '数据库未绑定，请检查 D1 配置' }, 500);

  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  const session = token ? await getSession(db, token) : null;

  try {
    if (path.startsWith('/video/') && method === 'GET') {
      if (!env.VIDEO_BUCKET) return json({ error: '未绑定 R2 存储（VIDEO_BUCKET）' }, 500);
      const key = path.slice('/video/'.length);
      const obj = await env.VIDEO_BUCKET.get(key);
      if (!obj) return json({ error: '视频不存在' }, 404);
      return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'video/mp4', 'Cache-Control': 'public, max-age=31536000', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' } });
    }

    /* ============ 充值播报记录（200 条） ============ */
    if (path === '/pay-records' && method === 'GET') {
      try { await ensurePayRecords(db); } catch(e) {}
      const rows = await db.prepare('SELECT * FROM pay_records ORDER BY created_at DESC LIMIT 200').all();
      return json({
        records: (rows.results || []).map(r => ({
          id: r.id, username: r.username, amount: r.amount, createdAt: r.created_at
        }))
      });
    }

    if (path === '/auth/register' && method === 'POST') {
      const { username, nickname, password, inviteCode } = await request.json();
      if (!username || !password) return json({ error: '参数不完整' }, 400);
      if (!inviteCode) return json({ error: '请输入邀请码' }, 400);
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json({ error: '用户名需为 3-20 位字母/数字' }, 400);
      if (password.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const exist = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exist) return json({ error: '用户名已被占用' }, 400);

      let inviterId = null;
      const code = String(inviteCode).trim();
      if (code === ROOT_INVITE_CODE) {
        inviterId = 'root';
      } else {
        const inviter = await db.prepare('SELECT id FROM users WHERE invite_code = ?').bind(code).first();
        if (!inviter) return json({ error: '邀请码无效' }, 400);
        inviterId = inviter.id;
      }

      const id = uid();
      const hash = await sha256(password);
      const nick = String(nickname || username).slice(0, 12);
      const newInviteCode = await generateInviteCode(db);
      if (!newInviteCode) return json({ error: '邀请码生成失败，请重试' }, 500);

      await db.prepare('INSERT INTO users (id, username, nickname, password, invite_code, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, username, nick, hash, newInviteCode, inviterId, Date.now()).run();

      const newToken = genToken();
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(newToken, id, 'user', Date.now()).run();
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
      try { await autoFillOrders(db); } catch(e) {}
      return json({ token: newToken, user: parseUser(u) });
    }

    if (path === '/auth/login' && method === 'POST') {
      const { username, password } = await request.json();
      if (!username || !password) return json({ error: '参数不完整' }, 400);
      const u = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
      if (!u) return json({ error: '用户不存在' }, 400);
      const hash = await sha256(password);
      if (hash !== u.password) return json({ error: '密码错误' }, 400);
      const newToken = genToken();
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(newToken, u.id, 'user', Date.now()).run();
      return json({ token: newToken, user: parseUser(u) });
    }

    if (path === '/auth/logout' && method === 'POST') {
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    if (path === '/admin/login' && method === 'POST') {
      const { password } = await request.json();
      if (password !== env.ADMIN_PASSWORD) return json({ error: '密码错误' }, 400);
      const newToken = genToken();
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(newToken, 'admin', 'admin', Date.now()).run();
      return json({ token: newToken });
    }

    if (path === '/me' && method === 'GET') {
      if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
      return json({ user: parseUser(u) });
    }

    if (path === '/me' && method === 'PATCH') {
      if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
      const body = await request.json();
      const updates = [], values = [];
      if (body.nickname !== undefined) { updates.push('nickname = ?'); values.push(String(body.nickname).slice(0, 12)); }
      if (body.payMethod !== undefined) { updates.push('pay_method = ?'); values.push(JSON.stringify(body.payMethod)); }
      if (updates.length) { values.push(session.user_id); await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run(); }
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
      return json({ user: parseUser(u) });
    }

    if (path === '/config' && method === 'GET') return json({ config: await getConfig(db) });

    if (path === '/orders' && method === 'GET') {
      try {
        const c = await db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").first();
        const need = Math.max(0, TARGET_COUNT - (Number(c.c) || 0));
        if (need > 0) await autoFillOrders(db);
      } catch(e) {}
      const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
      return json({ orders: (rows.results || []).map(parseOrder) });
    }if (path.startsWith('/orders/') && method === 'POST') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const parts = path.split('/');
  const orderId = parts[2];
  const action = parts[3];
  const order = await db.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!order) return json({ error: '订单不存在' }, 404);

  if (action === 'grab') {
    if (order.status !== 'pending') return json({ error: '订单已被抢或已完成' }, 400);
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
    const cfg = await getConfig(db);
    const ratio = Number(cfg.ratio) || 0.1;
    const minDep = Number(cfg.minDeposit) || 10;
    const required = Math.max(minDep, Math.round(Number(order.amount) * ratio));
    if (Number(u.deposit) < required) return json({ error: `押金不足，需 ${required} USDT` }, 400);
    const userPm = u.pay_method ? JSON.parse(u.pay_method) : null;
    if (!userPm) return json({ error: '请先绑定收款方式' }, 400);
    const body = await request.json().catch(() => ({}));
    const selected = body.payMethod;
    let chosen;
    if (userPm.type) { chosen = userPm; } else {
      if (selected && selected.type) {
        if (selected.type === 'alipay' && !userPm.alipay) return json({ error: '未绑定支付宝' }, 400);
        if (selected.type === 'bank' && !userPm.bank) return json({ error: '未绑定银行卡' }, 400);
        chosen = { type: selected.type, ...(selected.type === 'alipay' ? userPm.alipay : userPm.bank) };
      } else {
        if (userPm.alipay && userPm.bank) return json({ error: '请指定收款方式' }, 400);
        chosen = userPm.alipay ? { type: 'alipay', ...userPm.alipay } : { type: 'bank', ...userPm.bank };
      }
    }
    const takers = JSON.parse(order.takers || '[]');
    if (takers.some(t => t.userId === session.user_id)) return json({ error: '你已接过此单' }, 400);
    takers.push({ userId: u.id, userName: u.nickname || u.username, payMethod: chosen, at: Date.now(), status: 'working' });
    await db.prepare('UPDATE orders SET status = ?, takers = ? WHERE id = ?').bind('confirm', JSON.stringify(takers), orderId).run();
    try { await autoFillOrders(db); } catch(e) {}
    return json({ ok: true });
  }

  if (action === 'work') {
    const takers = JSON.parse(order.takers || '[]');
    const idx = takers.findIndex(t => t.userId === session.user_id && t.status === 'working');
    if (idx < 0) return json({ error: '无权操作' }, 403);
    takers[idx].status = 'done';
    takers[idx].doneAt = Date.now();
    await db.prepare('UPDATE orders SET status = ?, takers = ? WHERE id = ?').bind('paid', JSON.stringify(takers), orderId).run();
    await db.prepare('UPDATE users SET income = income + ? WHERE id = ?').bind(Number(order.commission), session.user_id).run();
    return json({ ok: true });
  }
}

if (path === '/deposit' && method === 'POST') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const { amount } = await request.json();
  if (!amount || amount <= 0) return json({ error: '金额错误' }, 400);

  const cfg = await getConfig(db);
  const toAddress = cfg.trc20;
  if (!toAddress) return json({ error: '收款地址未配置' }, 400);

  const check = await checkUsdtDeposit(db, toAddress, amount);
  if (!check.ok) return json({ error: check.error }, 400);

  try {
    await db.prepare('INSERT INTO deposits (tx_hash, user_id, amount, created_at) VALUES (?, ?, ?, ?)')
      .bind(check.txHash, session.user_id, check.amount, Date.now()).run();
  } catch (e) {
    return json({ error: '该笔交易已被使用' }, 400);
  }

  await db.prepare('UPDATE users SET deposit = deposit + ? WHERE id = ?')
    .bind(Number(check.amount), session.user_id).run();
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  return json({ user: parseUser(u), txHash: check.txHash, credited: check.amount });
}

if (path === '/refund' && method === 'POST') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const { amount, address } = await request.json();
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  if (!amount || amount <= 0 || amount > u.deposit) return json({ error: '金额错误' }, 400);
  if (!address) return json({ error: '请填写接收地址' }, 400);
  const id = uid();
  await db.prepare('INSERT INTO refunds (id, user_id, user_name, amount, address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, u.id, u.nickname, amount, address, 'pending', Date.now()).run();
  await db.prepare('UPDATE users SET deposit = deposit - ? WHERE id = ?').bind(Number(amount), u.id).run();
  return json({ ok: true });
}

if (path === '/refunds/mine' && method === 'GET') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const rows = await db.prepare('SELECT * FROM refunds WHERE user_id = ? ORDER BY created_at DESC').bind(session.user_id).all();
  return json({ refunds: (rows.results || []).map(parseRefund) });
}    if (path.startsWith('/admin/')) {
      if (!session || session.role !== 'admin') return json({ error: '无权限' }, 403);

      if (path === '/admin/orders' && method === 'GET') {
        const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        return json({ orders: (rows.results || []).map(parseOrder) });
      }

      if (path === '/admin/orders' && method === 'POST') {
        const body = await request.json();
        if (!body.amount) return json({ error: '请填写金额' }, 400);
        const amount = Number(body.amount);
        const commission = body.commission !== undefined && body.commission !== '' ? Number(body.commission) : Math.round(amount * 0.08);
        const id = uid();
        const orderNo = '2026' + Math.floor(100000000000 + Math.random() * 900000000000);
        await db.prepare('INSERT INTO orders (id, order_no, amount, commission, pay_type, description, status, publisher_id, publisher_name, credit, takers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, orderNo, amount, commission, body.payType || '', body.desc || '', 'pending', 'admin', '官方发布', 100, '[]', Date.now()).run();
        return json({ ok: true, id });
      }

      if (path.startsWith('/admin/orders/') && method === 'PATCH') {
        const orderId = path.split('/')[3];
        const { status } = await request.json();
        await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, orderId).run();
        return json({ ok: true });
      }

      if (path.startsWith('/admin/orders/') && method === 'DELETE') {
        const orderId = path.split('/')[3];
        await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run();
        return json({ ok: true });
      }

      if (path === '/admin/auto-fill' && method === 'POST') {
        try { const r = await autoFillOrders(db); return json({ ok: true, ...r }); } catch (e) { return json({ error: '补单失败：' + e.message }, 500); }
      }

      if (path === '/admin/upload-video' && method === 'POST') {
        if (!env.VIDEO_BUCKET) return json({ error: '未绑定 R2 存储（变量名需为 VIDEO_BUCKET）' }, 500);
        const formData = await request.formData();
        const file = formData.get('video');
        if (!file || typeof file === 'string') return json({ error: '未选择文件' }, 400);
        const ext = (file.name || 'video.mp4').split('.').pop().toLowerCase();
        const key = `videos/${uid()}.${ext}`;
        await env.VIDEO_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'video/mp4' } });
        return json({ ok: true, key, url: `/api/video/${key}` });
      }

      if (path === '/admin/refunds' && method === 'GET') {
        const rows = await db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all();
        return json({ refunds: (rows.results || []).map(parseRefund) });
      }

      if (path.startsWith('/admin/refunds/') && method === 'POST') {
        const parts = path.split('/');
        const refundId = parts[3];
        const action = parts[4];
        const r = await db.prepare('SELECT * FROM refunds WHERE id = ?').bind(refundId).first();
        if (!r || r.status !== 'pending') return json({ error: '状态错误' }, 400);
        if (action === 'approve') {
          await db.prepare('UPDATE refunds SET status = ? WHERE id = ?').bind('approved', refundId).run();
        } else if (action === 'reject') {
          await db.prepare('UPDATE refunds SET status = ? WHERE id = ?').bind('rejected', refundId).run();
          await db.prepare('UPDATE users SET deposit = deposit + ? WHERE id = ?').bind(Number(r.amount), r.user_id).run();
        } else { return json({ error: '未知操作' }, 400); }
        return json({ ok: true });
      }

      if (path === '/admin/users' && method === 'GET') {
        const rows = await db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
        return json({ users: (rows.results || []).map(parseUser) });
      }

      if (path === '/admin/config' && method === 'POST') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) { await setConfig(db, k, v); }
        return json({ config: await getConfig(db) });
      }
    }

    return json({ error: 'Not found: ' + path }, 404);
  } catch (e) {
    return json({ error: e.message || '服务器错误' }, 500);
  }
}
