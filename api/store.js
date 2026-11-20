import { put, list } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};

const DATA_FILENAME = 'nile-store-data.json';

async function getStoreData() {
  const { blobs } = await list({ prefix: DATA_FILENAME });
  if (!blobs || blobs.length === 0) {
    return { products: [], phone: '201009171678' };
  }
  const latest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
  const res = await fetch(latest.url, { cache: 'no-store' });
  if (!res.ok) return { products: [], phone: '201009171678' };
  return await res.json();
}

async function saveStoreData(data) {
  await put(DATA_FILENAME, JSON.stringify(data), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const data = await getStoreData();
      return res.status(200).json(data);
    } catch (err) {
      return res.status(500).json({ error: 'فشل تحميل البيانات', details: err.message });
    }
  }

  if (req.method === 'POST') {
    const adminPassword = process.env.ADMIN_PASSWORD;
    const { action, password, payload } = req.body || {};

    if (!adminPassword || password !== adminPassword) {
      return res.status(401).json({ error: 'الرقم السري غير صحيح' });
    }

    try {
      if (action === 'login') {
        return res.status(200).json({ ok: true });
      }

      const currentData = await getStoreData();

      if (action === 'addProduct') {
        let imageUrl = '';
        if (payload.imageBase64 && payload.imageName) {
          const matches = payload.imageBase64.match(/^data:(.+);base64,(.+)$/);
          if (matches) {
            const contentType = matches[1];
            const buffer = Buffer.from(matches[2], 'base64');
            const safeName = `products/${Date.now()}-${payload.imageName.replace(/[^a-zA-Z0-9._-]/g, '')}`;
            const blob = await put(safeName, buffer, {
              access: 'public',
              contentType,
            });
            imageUrl = blob.url;
          }
        }

        const newProduct = {
          id: Date.now().toString(),
          name: payload.name,
          price: payload.price,
          desc: payload.desc || '',
          image: imageUrl,
        };

        currentData.products.unshift(newProduct);
        await saveStoreData(currentData);
        return res.status(200).json({ ok: true, data: currentData });
      }

      if (action === 'deleteProduct') {
        currentData.products = currentData.products.filter((_, idx) => idx !== payload.index);
        await saveStoreData(currentData);
        return res.status(200).json({ ok: true, data: currentData });
      }

      if (action === 'updatePhone') {
        currentData.phone = payload.phone;
        await saveStoreData(currentData);
        return res.status(200).json({ ok: true, data: currentData });
      }

      return res.status(400).json({ error: 'عملية غير معروفة' });
    } catch (err) {
      return res.status(500).json({ error: 'حدث خطأ في السيرفر', details: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
