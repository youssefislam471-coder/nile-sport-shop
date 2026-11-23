import { put, get, list, BlobPreconditionFailedError } from '@vercel/blob';
import crypto from 'node:crypto';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

const DATA_FILENAME = 'nile-store-data.json';
const DEFAULT_PHONE = '201009171678';
const TOKEN_HOURS = 8;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_WRITE_ATTEMPTS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Best effort only: this memory lives per server instance and resets on cold start.
const failures = new Map();

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.socket?.remoteAddress || 'unknown';
}

function isLocked(key) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > FAIL_WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}

function recordFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > FAIL_WINDOW_MS) {
    failures.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count += 1;
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sign(exp, secret) {
  return crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
}

function makeToken(secret) {
  const exp = Date.now() + TOKEN_HOURS * 3600 * 1000;
  return `${exp}.${sign(exp, secret)}`;
}

function tokenValid(token, secret) {
  if (!secret || typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp, secret));
}

function normalizeData(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  if (!Array.isArray(data.products)) data.products = [];
  data.products = data.products.map((p, i) => ({ ...p, id: p.id ? String(p.id) : `legacy-${i}` }));
  if (!data.phone) data.phone = DEFAULT_PHONE;
  return data;
}

// Reads the store file together with its ETag. useCache:false reads from origin so the
// body and the ETag always belong to the same version (a CDN copy could be older).
async function readSnapshot(fresh) {
  const r = await get(DATA_FILENAME, { access: 'public', useCache: !fresh ? true : false });
  if (!r || r.statusCode !== 200) return { data: normalizeData(null), etag: null };
  const text = await new Response(r.stream).text();
  return { data: normalizeData(JSON.parse(text)), etag: r.blob.etag };
}

// Conditional write: only succeeds if the file still has the ETag we read.
// Without an ETag (file does not exist yet) it only succeeds if the file is still absent.
async function writeSnapshot(data, etag) {
  const opts = { access: 'public', addRandomSuffix: false, contentType: 'application/json' };
  if (etag) { opts.ifMatch = etag; opts.allowOverwrite = true; } else { opts.allowOverwrite = false; }
  await put(DATA_FILENAME, JSON.stringify(data), opts);
}

function isConflict(err) {
  return err instanceof BlobPreconditionFailedError || /precondition|already exists/i.test(String(err && err.message));
}

function publicView(data) {
  return { ...data, products: data.products.filter((p) => !p.hidden) };
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validateFields(payload) {
  const name = cleanText(payload?.name, 70);
  const desc = cleanText(payload?.desc, 200);
  const priceNum = Number(payload?.price);
  if (!name) return { error: 'اكتب اسم المنتج' };
  if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > 1000000) return { error: 'السعر غير صحيح' };
  return { name, desc, price: String(Math.round(priceNum * 100) / 100) };
}

function looksLikeImage(buffer, type) {
  if (type === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (type === 'image/png') return buffer.slice(0, 4).toString('hex') === '89504e47';
  if (type === 'image/webp') return buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP';
  return false;
}

async function uploadImage(payload) {
  if (!payload?.imageBase64) return { url: '' };
  const matches = String(payload.imageBase64).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!matches) return { error: 'نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WebP' };
  const contentType = matches[1];
  const buffer = Buffer.from(matches[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) return { error: 'حجم الصورة كبير' };
  if (!looksLikeImage(buffer, contentType)) return { error: 'ملف الصورة غير صالح' };
  const safeName = `products/${Date.now()}-${cleanText(payload.imageName, 60).replace(/[^a-zA-Z0-9._-]/g, '') || 'photo.jpg'}`;
  const blob = await put(safeName, buffer, { access: 'public', contentType });
  return { url: blob.url };
}

function findIndex(data, id) {
  return data.products.findIndex((p) => p.id === String(id));
}

export default async function handler(req, res) {
  const secret = process.env.ADMIN_PASSWORD;
  const token = req.headers['x-admin-token'];
  const isAdmin = tokenValid(token, secret);

  if (req.method === 'GET') {
    try {
      let data;
      try {
        ({ data } = await readSnapshot(isAdmin));
      } catch (e) {
        // Safety net for the public shop: if the new read path fails, fall back to the old one.
        const { blobs } = await list({ prefix: DATA_FILENAME });
        const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
        data = normalizeData(latest ? await (await fetch(latest.url, { cache: 'no-store' })).json() : null);
      }
      return res.status(200).json(isAdmin ? { ...data, admin: true } : publicView(data));
    } catch (err) {
      return res.status(500).json({ error: 'فشل تحميل البيانات' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, password, payload } = req.body || {};

  if (action === 'login') {
    const key = clientKey(req);
    if (isLocked(key)) {
      return res.status(429).json({ error: 'محاولات كتيرة. جرّب بعد شوية' });
    }
    if (!secret || typeof password !== 'string' || !safeEqual(password, secret)) {
      recordFailure(key);
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'الرقم السري غير صحيح' });
    }
    failures.delete(key);
    return res.status(200).json({ ok: true, token: makeToken(secret) });
  }

  if (!isAdmin) {
    return res.status(401).json({ error: 'سجّل الدخول من جديد' });
  }

  try {
    // Validate and upload any image once, before the (retryable) write.
    let fields = null;
    let image = { url: '' };
    if (action === 'addProduct' || action === 'updateProduct') {
      fields = validateFields(payload);
      if (fields.error) return res.status(400).json({ error: fields.error });
      image = await uploadImage(payload);
      if (image.error) return res.status(400).json({ error: image.error });
    }
    const newId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // Applies the action to a fresh copy of the data. Returns null on success,
    // or { status, error } when the action cannot be applied. Every action is keyed
    // by product id (or sets an explicit value), so re-applying it to newer data is safe.
    const apply = (data) => {
      const fail = (status, error) => ({ status, error });
      let extra = {};
      if (action === 'addProduct') {
        data.products.unshift({ id: newId, name: fields.name, price: fields.price, desc: fields.desc, image: image.url });
      } else if (action === 'updateProduct') {
        const i = findIndex(data, payload?.id);
        if (i < 0) return fail(404, 'المنتج مش موجود');
        data.products[i] = {
          ...data.products[i],
          name: fields.name,
          price: fields.price,
          desc: fields.desc,
          image: image.url || data.products[i].image,
        };
      } else if (action === 'deleteProduct') {
        const i = findIndex(data, payload?.id);
        if (i < 0) return fail(404, 'المنتج مش موجود');
        const [removed] = data.products.splice(i, 1);
        extra = { removed, removedIndex: i };
      } else if (action === 'restoreProduct') {
        const p = payload?.product;
        const f = validateFields(p);
        if (!p || !p.id || f.error) return fail(400, 'تعذر التراجع');
        if (findIndex(data, p.id) >= 0) return { ok: true, extra };
        const img = typeof p.image === 'string' && /^https:\/\//.test(p.image) ? p.image : '';
        const at = Math.min(Math.max(Number(payload.index) || 0, 0), data.products.length);
        data.products.splice(at, 0, { id: String(p.id), name: f.name, price: f.price, desc: f.desc, image: img, hidden: !!p.hidden });
      } else if (action === 'toggleHidden') {
        const i = findIndex(data, payload?.id);
        if (i < 0) return fail(404, 'المنتج مش موجود');
        data.products[i].hidden = typeof payload.hidden === 'boolean' ? payload.hidden : !data.products[i].hidden;
      } else if (action === 'moveProduct') {
        const i = findIndex(data, payload?.id);
        if (i < 0) return fail(404, 'المنتج مش موجود');
        const j = payload.direction === 'up' ? i - 1 : payload.direction === 'down' ? i + 1 : i;
        if (j >= 0 && j < data.products.length && j !== i) {
          [data.products[i], data.products[j]] = [data.products[j], data.products[i]];
        }
      } else if (action === 'updatePhone') {
        const digits = String(payload?.phone ?? '').replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 15) return fail(400, 'رقم الواتساب غير صحيح');
        data.phone = digits;
      } else {
        return fail(400, 'عملية غير معروفة');
      }
      return { ok: true, extra };
    };

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const snap = await readSnapshot(true);
      const result = apply(snap.data);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      try {
        await writeSnapshot(snap.data, snap.etag);
        return res.status(200).json({ ok: true, data: snap.data, ...result.extra });
      } catch (err) {
        if (!isConflict(err)) throw err;
        // Someone else saved first. Their data is untouched; re-read and re-apply.
      }
    }
    const latest = await readSnapshot(true);
    return res.status(409).json({
      error: 'اتغيّرت البيانات من جهاز تاني. حدّثنا الصفحة، جرّب تاني',
      data: latest.data,
    });
  } catch (err) {
    return res.status(500).json({ error: 'حدث خطأ في السيرفر' });
  }
}
