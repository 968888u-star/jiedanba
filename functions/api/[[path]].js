/* =========================================================
   Cloudflare Pages Functions - 众包接单 API
   路由前缀：/api/*
   ========================================================= */

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

function genToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSession(db, token) {
  if (!token) return null;
  return await db.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
}

async function getConfig(db) {
  const rows = await db.prepare('SELECT key, value FROM config').all();
  const cfg = {};
  (rows.results || []).forEach(r => {
    try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; }
  });
  return cfg;
}

async function setConfig(db, key, value) {
  const v = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
  await db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').bind(key, v).run();
}

function parseUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    credit: row.credit,
    income: row.income,
    deposit: row.deposit,
    payMethod: row.pay_method ? JSON.parse(row.pay_method) : null,
    createdAt: row.created_at,
  };
}

function parseOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    orderNo: row.order_no,
    amount: row.amount,
    commission: row.commission,
    payType: row.pay_type,
    desc: row.description,
    status: row.status,
    publisherId: row.publisher_id,
    publisherName: row.publisher_name,
    credit: row.credit,
    takers: JSON.parse(row.takers || '[]'),
    createdAt: row.created_at,
  };
}

function parseRefund(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    amount: row.amount,
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
  };
}export async function onRequest(context) {
  const { request, env, params } = context;
  const path = '/' + (params.path || []).join('/');
  const method = request.method;
  const db = env.DB;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (!db) return json({ error: '数据库未绑定，请检查 D1 配置' }, 500);

  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  const session = token ? await getSession(db, token) : null;

  try {
    /* ============ 用户认证 ============ */
    if (path === '/auth/register' && method === 'POST') {
      const { username, nickname, password } = await request.json();
      if (!username || !password) return json({ error: '参数不完整' }, 400);
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json({ error: '用户名需为 3-20 位字母/数字' }, 400);
      if (password.length < 6) return json({ error: '密码至少 6 位' }, 400);
      const exist = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (exist) return json({ error: '用户名已被占用' }, 400);
      const id = uid();
      const hash = await sha256(password);
      const nick = String(nickname || username).slice(0, 12);
      await db.prepare('INSERT INTO users (id, username, nickname, password, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(id, username, nick, hash, Date.now()).run();
      const newToken = genToken();
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(newToken, id, 'user', Date.now()).run();
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
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
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(newToken, u.id, 'user', Date.now()).run();
      return json({ token: newToken, user: parseUser(u) });
    }

    if (path === '/auth/logout' && method === 'POST') {
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    /* ============ 管理员登录 ============ */
    if (path === '/admin/login' && method === 'POST') {
      const { password } = await request.json();
      if (password !== env.ADMIN_PASSWORD) return json({ error: '密码错误' }, 400);
      const newToken = genToken();
      await db.prepare('INSERT INTO sessions (token, user_id, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(newToken, 'admin', 'admin', Date.now()).run();
      return json({ token: newToken });
    }

    /* ============ 当前用户 ============ */
    if (path === '/me' && method === 'GET') {
      if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
      return json({ user: parseUser(u) });
    }

    if (path === '/me' && method === 'PATCH') {
      if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
      const body = await request.json();
      const updates = [];
      const values = [];
      if (body.nickname !== undefined) {
        updates.push('nickname = ?');
        values.push(String(body.nickname).slice(0, 12));
      }
      if (body.payMethod !== undefined) {
        updates.push('pay_method = ?');
        values.push(JSON.stringify(body.payMethod));
      }
      if (updates.length) {
        values.push(session.user_id);
        await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
      }
      const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
      return json({ user: parseUser(u) });
    }

    /* ============ 系统配置 ============ */
    if (path === '/config' && method === 'GET') {
      return json({ config: await getConfig(db) });
    }

    /* ============ 订单列表 ============ */
    if (path === '/orders' && method === 'GET') {
      const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
      return json({ orders: (rows.results || []).map(parseOrder) });
    }/* ============ 抢单 / 提交完成 ============ */
if (path.startsWith('/orders/') && method === 'POST') {
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

    // 兼容旧格式（单个 type）和新格式（alipay + bank）
    let chosen;
    if (userPm.type) {
      chosen = userPm;
    } else {
      if (selected && selected.type) {
        if (selected.type === 'alipay' && !userPm.alipay) return json({ error: '未绑定支付宝' }, 400);
        if (selected.type === 'bank' && !userPm.bank) return json({ error: '未绑定银行卡' }, 400);
        chosen = { type: selected.type, ...(selected.type === 'alipay' ? userPm.alipay : userPm.bank) };
      } else {
        if (userPm.alipay && userPm.bank) return json({ error: '请指定收款方式' }, 400);
        chosen = userPm.alipay
          ? { type: 'alipay', ...userPm.alipay }
          : { type: 'bank', ...userPm.bank };
      }
    }

    const takers = JSON.parse(order.takers || '[]');
    if (takers.some(t => t.userId === session.user_id)) return json({ error: '你已接过此单' }, 400);
    takers.push({
      userId: u.id,
      userName: u.nickname || u.username,
      payMethod: chosen,
      at: Date.now(),
      status: 'working',
    });
    await db.prepare('UPDATE orders SET status = ?, takers = ? WHERE id = ?')
      .bind('confirm', JSON.stringify(takers), orderId).run();
    return json({ ok: true });
  }

  if (action === 'work') {
    const takers = JSON.parse(order.takers || '[]');
    const idx = takers.findIndex(t => t.userId === session.user_id && t.status === 'working');
    if (idx < 0) return json({ error: '无权操作' }, 403);
    takers[idx].status = 'done';
    takers[idx].doneAt = Date.now();
    await db.prepare('UPDATE orders SET status = ?, takers = ? WHERE id = ?')
      .bind('paid', JSON.stringify(takers), orderId).run();
    await db.prepare('UPDATE users SET income = income + ? WHERE id = ?')
      .bind(Number(order.commission), session.user_id).run();
    return json({ ok: true });
  }
}

/* ============ 充值（用户确认后立即到账，生产环境应改为链上监听） ============ */
if (path === '/deposit' && method === 'POST') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const { amount } = await request.json();
  if (!amount || amount <= 0) return json({ error: '金额错误' }, 400);
  await db.prepare('UPDATE users SET deposit = deposit + ? WHERE id = ?')
    .bind(Number(amount), session.user_id).run();
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  return json({ user: parseUser(u) });
}

/* ============ 退款 ============ */
if (path === '/refund' && method === 'POST') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const { amount, address } = await request.json();
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(session.user_id).first();
  if (!amount || amount <= 0 || amount > u.deposit) return json({ error: '金额错误' }, 400);
  if (!address) return json({ error: '请填写接收地址' }, 400);
  const id = uid();
  await db.prepare('INSERT INTO refunds (id, user_id, user_name, amount, address, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, u.id, u.nickname, amount, address, 'pending', Date.now()).run();
  await db.prepare('UPDATE users SET deposit = deposit - ? WHERE id = ?')
    .bind(Number(amount), u.id).run();
  return json({ ok: true });
}

if (path === '/refunds/mine' && method === 'GET') {
  if (!session || session.role !== 'user') return json({ error: '未登录' }, 401);
  const rows = await db.prepare('SELECT * FROM refunds WHERE user_id = ? ORDER BY created_at DESC')
    .bind(session.user_id).all();
  return json({ refunds: (rows.results || []).map(parseRefund) });
}    /* ============ 管理端 ============ */
    if (path.startsWith('/admin/')) {
      if (!session || session.role !== 'admin') return json({ error: '无权限' }, 403);

      if (path === '/admin/orders' && method === 'GET') {
        const rows = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        return json({ orders: (rows.results || []).map(parseOrder) });
      }

      if (path === '/admin/orders' && method === 'POST') {
        const body = await request.json();
        if (!body.amount || !body.commission) return json({ error: '请填写金额' }, 400);
        const id = uid();
        const orderNo = '2026' + Math.floor(100000000000 + Math.random() * 900000000000);
        await db.prepare('INSERT INTO orders (id, order_no, amount, commission, pay_type, description, status, publisher_id, publisher_name, credit, takers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, orderNo, Number(body.amount), Number(body.commission), body.payType || '', body.desc || '', 'pending', 'admin', '官方发布', 100, '[]', Date.now()).run();
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
          await db.prepare('UPDATE users SET deposit = deposit + ? WHERE id = ?')
            .bind(Number(r.amount), r.user_id).run();
        } else {
          return json({ error: '未知操作' }, 400);
        }
        return json({ ok: true });
      }

      if (path === '/admin/users' && method === 'GET') {
        const rows = await db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
        return json({ users: (rows.results || []).map(parseUser) });
      }

      if (path === '/admin/config' && method === 'POST') {
        const body = await request.json();
        for (const [k, v] of Object.entries(body)) {
          await setConfig(db, k, v);
        }
        return json({ config: await getConfig(db) });
      }
    }

    return json({ error: 'Not found: ' + path }, 404);
  } catch (e) {
    return json({ error: e.message || '服务器错误' }, 500);
  }
}
