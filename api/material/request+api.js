//api/material/request+api.js
import express from 'express';
import { Pool } from 'pg';
import admin from '../../firebase-init.js';

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const ensureTable = async client => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS material_requests (
      id SERIAL PRIMARY KEY,
      products JSONB NOT NULL,
      request_all BOOLEAN DEFAULT FALSE,
      requested_by TEXT,
      note TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await executeWithRetry(() => withTimeout(client.query(createSql), 10000));
  const alterStatements = [
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS assigned_driver_id TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS assigned_driver_name TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS assigned_driver_email TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS manager_note TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS assigned_quantity NUMERIC",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS supplier_id TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS supplier_name TEXT",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS storekeeper_total_quantity NUMERIC",
    "ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS manager_quantities JSONB"
  ];
  for (const sql of alterStatements) {
    await executeWithRetry(() => withTimeout(client.query(sql), 10000));
  }

  const createItemsSql = `
    CREATE TABLE IF NOT EXISTS material_request_items (
      id SERIAL PRIMARY KEY,
      request_id INT REFERENCES material_requests(id) ON DELETE CASCADE,
      product_id TEXT,
      product_code TEXT,
      product_name TEXT,
      section TEXT,
      supplier TEXT,
      company TEXT,
      requested_quantity NUMERIC,
      status TEXT DEFAULT 'pending',
      assigned_driver_id TEXT,
      assigned_driver_name TEXT,
      assigned_driver_email TEXT,
      assigned_quantity NUMERIC,
      supplier_id TEXT,
      supplier_name TEXT,
      selection_key TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_material_request_items_request ON material_request_items(request_id);
  `;
  await executeWithRetry(() => withTimeout(client.query(createItemsSql), 10000));
};

const sendNotificationToManagers = async (summary, count) => {
  const client = await pool.connect();
  try {
    const result = await executeWithRetry(() =>
      withTimeout(
        client.query('SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE', ['manager']),
        10000
      )
    );

    const tokens = result.rows.map(r => r.fcm_token).filter(Boolean);
    if (!tokens.length) {
      console.warn('⚠️ No FCM tokens found for managers. Skipping notification.');
      return;
    }

    const body = `${summary}${count ? ` (${count})` : ''} بانتظار موافقتك.`;
    const messages = tokens.map(token => ({
      notification: {
        title: 'طلب مواد جديد',
        body,
      },
      data: {
        role: 'manager',
        type: 'material_request',
      },
      token,
    }));

    await admin.messaging().sendEach(messages);
  } catch (err) {
    console.error('🚨 Failed to send FCM messages to managers:', err);
  } finally {
    client.release();
  }
};

// Medad token helper (used to fetch suppliers from Medad API)
let cachedToken = null;
let tokenExpiry = 0;
const getMedadToken = async () => {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const payload = {
    username: process.env.MEDAD_USERNAME,
    password: process.env.MEDAD_PASSWORD,
    subscriptionId: process.env.MEDAD_SUBSCRIPTION_ID,
    branch: Number(process.env.MEDAD_BRANCH),
    year: process.env.MEDAD_YEAR,
  };

  const response = await fetch(`${process.env.MEDAD_BASE_URL}/getToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Medad token request failed: ${text}`);
  }

  const data = await response.json();
  const token = data.token || data.access_token || data?.data?.token;
  if (!token) throw new Error('Medad token not found in response');

  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000; // refresh 1 min early
  return cachedToken;
};

router.post('/requestMaterial', async (req, res) => {
  const { products = [], requestAll = false, requestedBy = null, note = null } = req.body || {};

  const normalizedProducts = Array.isArray(products)
    ? products.map(p => ({
        id: p.id ?? p.productNo ?? p.code ?? null,
        name: p.name ?? p.description ?? 'بدون اسم',
        code: p.code ?? p.productNo ?? '',
        quantity: Number(p.quantity ?? p.availableQuantity ?? p.qty ?? 0) || 0,
        section: p.section_name ?? p.category ?? '',
        supplier: p.supplier_name ?? p.vendorName ?? '',
        company: p.company_name ?? p.vendorId ?? '',
        requested_quantity: (() => {
          const qty = Number(p.requestedQuantity ?? p.requested_quantity ?? p.request_qty ?? p.requestQty ?? 0);
          return Number.isFinite(qty) && qty > 0 ? qty : 0;
        })(),
        requestedQuantity: (() => {
          const qty = Number(p.requestedQuantity ?? p.requested_quantity ?? p.request_qty ?? p.requestQty ?? 0);
          return Number.isFinite(qty) && qty > 0 ? qty : 0;
        })(),
      }))
    : [];

  if (!requestAll && normalizedProducts.length === 0) {
    return res.status(400).json({ error: 'No products provided for material request' });
  }

  const storekeeperTotalQuantity = normalizedProducts.reduce((sum, p) => sum + (p.requested_quantity || 0), 0);
  const storekeeperTotalQuantityValue = Number.isFinite(storekeeperTotalQuantity) ? storekeeperTotalQuantity : null;

  const client = await pool.connect();
  try {
    await ensureTable(client);

    const insertSql = `
      INSERT INTO material_requests (products, request_all, requested_by, note, status, storekeeper_total_quantity)
      VALUES ($1, $2, $3, $4, 'pending', $5)
      RETURNING id, created_at
    `;
    const insertParams = [JSON.stringify(normalizedProducts), requestAll, requestedBy, note, storekeeperTotalQuantityValue];
    const result = await executeWithRetry(() => withTimeout(client.query(insertSql, insertParams), 10000));
    const requestId = result.rows[0]?.id;

    // also insert per-product rows for granular assignment
    if (requestId && Array.isArray(normalizedProducts)) {
      const itemValues = normalizedProducts.map(p => [
        requestId,
        p.id || p.code || null,
        p.code || null,
        p.name || 'بدون اسم',
        p.section || null,
        p.supplier || null,
        p.company || null,
        Number(p.requested_quantity || p.requestedQuantity || 0) || 0,
        'pending',
        p.code || p.id || null,
      ]);

      const valuesSql = itemValues
        .map(
          (_, idx) =>
            `($${idx * 10 + 1}, $${idx * 10 + 2}, $${idx * 10 + 3}, $${idx * 10 + 4}, $${idx * 10 + 5}, $${idx * 10 + 6}, $${idx * 10 + 7}, $${idx * 10 + 8}, $${idx * 10 + 9}, $${idx * 10 + 10})`,
        )
        .join(', ');

      const flatParams = itemValues.flat();
      const insertItemsSql = `
        INSERT INTO material_request_items
        (request_id, product_id, product_code, product_name, section, supplier, company, requested_quantity, status, selection_key)
        VALUES ${valuesSql}
      `;
      if (itemValues.length) {
        await executeWithRetry(() => withTimeout(client.query(insertItemsSql, flatParams), 10000));
      }
    }

    const summary = requestAll ? 'طلب جميع المنتجات' : 'طلب مواد محددة';
    await sendNotificationToManagers(summary, normalizedProducts.length);

    return res.status(201).json({
      success: true,
      requestId,
      message: 'تم إرسال طلب المواد للمدير للموافقة',
    });
  } catch (err) {
    console.error('❌ Failed to create material request:', err);
    return res.status(500).json({ error: err.message || 'Failed to create material request' });
  } finally {
    client.release();
  }
});

// Fetch material requests
router.get('/requestMaterial', async (_req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const selectSql = `
      SELECT
        mr.id,
        mr.products,
        mr.request_all,
        mr.requested_by,
        mr.note,
        mr.status,
        mr.created_at,
        mr.assigned_driver_id,
        mr.assigned_driver_name,
        mr.assigned_driver_email,
        mr.assigned_at,
        mr.manager_note,
        mr.assigned_quantity,
        mr.supplier_id,
        mr.supplier_name,
        mr.storekeeper_total_quantity,
        mr.manager_quantities,
        COALESCE(json_agg(mri.*) FILTER (WHERE mri.id IS NOT NULL), '[]') AS items
      FROM material_requests mr
      LEFT JOIN material_request_items mri ON mri.request_id = mr.id
      GROUP BY mr.id
      ORDER BY mr.created_at DESC
    `;
    const result = await executeWithRetry(() => withTimeout(client.query(selectSql), 10000));
    return res.status(200).json({
      success: true,
      requests: result.rows || [],
    });
  } catch (err) {
    console.error('❌ Failed to fetch material requests:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch material requests' });
  } finally {
    client.release();
  }
});

// Lightweight suppliers list for assignment dropdowns
router.get('/suppliers', async (_req, res) => {
  try {
    const token = await getMedadToken();
    // Medad expects accountType as string, allowed values per docs: 0=Customer, 1=Vendor
    const accountType = (process.env.MEDAD_SUPPLIER_ACCOUNT_TYPE ?? '1').toString();
    const PAGE_SIZE = 100;
    let page = 1;
    const suppliers = [];
    const seen = new Set();

    while (true) {
      const url = `${process.env.MEDAD_BASE_URL}/customers?accountType=${accountType}&page=${page}&limit=${PAGE_SIZE}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Failed to fetch suppliers');
      }

      const data = await response.json();
      const raw =
        data?.customers ||
        data?.items ||
        data?.data ||
        (Array.isArray(data) ? data : []);

      const batch = Array.isArray(raw) ? raw : [];
      const normalized = batch
        .map((s, idx) => {
          const id = s.id?.toString() || s.customerId?.toString() || `${page}-${idx}`;
          if (seen.has(id)) return null;
          seen.add(id);
          return {
            id,
            supplier_name: s.name || s.company_name || 'Supplier',
            company_name: s.company_name || s.name || '',
            phone_number: s.phone || s.contact1Phone || '',
          };
        })
        .filter(Boolean);

      suppliers.push(...normalized);

      const noMore = batch.length < PAGE_SIZE || normalized.length === 0 || page >= 50;
      const totalPages = data.total_pages || data.totalPages || data.totalpages;
      if (noMore || (totalPages && page >= totalPages)) break;
      page += 1;
    }

    return res.status(200).json({
      success: true,
      suppliers,
    });
  } catch (err) {
    console.error('❌ Failed to fetch suppliers for material requests:', err);
    return res.status(500).json({ error: err.message || 'Failed to fetch suppliers' });
  }
});

// Assign one or more material requests to a driver
router.post('/requestMaterial/assign', async (req, res) => {
  const {
    requestIds = [],
    driverId = null,
    driverName = null,
    driverEmail = null,
    managerNote = null,
    quantity = null,
    supplierId = null,
    supplierName = null,
    productQuantities = null,
  } = req.body || {};

  const ids = Array.isArray(requestIds)
    ? requestIds
        .map(id => parseInt(id, 10))
        .filter(id => Number.isInteger(id) && id > 0)
    : [];

  if (!ids.length) {
    return res.status(400).json({ error: 'No request IDs provided to assign' });
  }

  const client = await pool.connect();
  try {
    await ensureTable(client);

    const normalizedManagerQuantities = (() => {
      if (Array.isArray(productQuantities)) {
        return productQuantities.reduce((acc, p) => {
          const id = p?.selectionKey ?? p?.id ?? p?.code ?? p?.productNo ?? p?.product_id ?? null;
          const qty = Number(p?.quantity ?? p?.qty ?? p?.requestedQuantity ?? p?.managerQuantity ?? null);
          if (id && Number.isFinite(qty) && qty > 0) acc[id] = qty;
          return acc;
        }, {});
      }
      if (productQuantities && typeof productQuantities === 'object') {
        return Object.entries(productQuantities).reduce((acc, [key, val]) => {
          const qty = Number(val);
          if (Number.isFinite(qty) && qty > 0) acc[key] = qty;
          return acc;
        }, {});
      }
      return {};
    })();

    const managerQuantitiesJson =
      Object.keys(normalizedManagerQuantities).length > 0 ? JSON.stringify(normalizedManagerQuantities) : null;
    const managerQuantitiesSum = Object.values(normalizedManagerQuantities).reduce((sum, v) => sum + Number(v || 0), 0);
    const assignedQuantityValue =
      quantity != null && Number.isFinite(Number(quantity))
        ? Number(quantity)
        : managerQuantitiesJson
        ? managerQuantitiesSum || null
        : null;

    const updateSql = `
      UPDATE material_requests
      SET
        assigned_driver_id = $2,
        assigned_driver_name = $3,
        assigned_driver_email = $4,
        manager_note = $5,
        assigned_quantity = $6,
        supplier_id = $7,
        supplier_name = $8,
        manager_quantities = COALESCE($9, manager_quantities),
        status = 'assigned',
        assigned_at = CURRENT_TIMESTAMP
      WHERE id = ANY($1::int[])
      RETURNING id, status, assigned_driver_id, assigned_driver_name, assigned_driver_email, assigned_at, manager_note, assigned_quantity, supplier_id, supplier_name, manager_quantities
    `;

    const result = await executeWithRetry(() =>
      withTimeout(
        client.query(updateSql, [
          ids,
          driverId,
          driverName,
          driverEmail,
          managerNote,
          assignedQuantityValue,
          supplierId,
          supplierName,
          managerQuantitiesJson,
        ]),
        10000
      )
    );

    // Update child items with per-product quantities and assignment metadata
    if (Array.isArray(productQuantities) && productQuantities.length) {
      for (const pq of productQuantities) {
        const selectionKey = pq.selectionKey ?? pq.id ?? pq.code ?? pq.productNo ?? pq.product_id ?? null;
        if (!selectionKey) continue;
        const qty = Number(pq.quantity ?? pq.qty ?? pq.requestedQuantity ?? pq.managerQuantity ?? null);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const reqId = pq.requestId || pq.request_id || (ids.length === 1 ? ids[0] : null);
        if (!reqId) continue;
        const updateItemSql = `
          UPDATE material_request_items
          SET
            status = 'assigned',
            assigned_driver_id = $4,
            assigned_driver_name = $5,
            assigned_driver_email = $6,
            assigned_quantity = $3,
            supplier_id = $7,
            supplier_name = $8
          WHERE request_id = $1 AND (selection_key = $2 OR product_code = $2 OR product_id = $2)
        `;
        await executeWithRetry(() =>
          withTimeout(
            client.query(updateItemSql, [
              reqId,
              selectionKey,
              qty,
              driverId,
              driverName,
              driverEmail,
              supplierId,
              supplierName,
            ]),
            10000
          )
        );
      }
    }

    return res.status(200).json({
      success: true,
      updated: result.rows || [],
      message: 'تم تعيين طلبات المواد للسائق بنجاح',
    });
  } catch (err) {
    console.error('❌ Failed to assign material requests:', err);
    return res.status(500).json({ error: err.message || 'Failed to assign material requests' });
  } finally {
    client.release();
  }
});

export default router;
