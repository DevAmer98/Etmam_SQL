import express from 'express';
import pkg from 'pg';

const { Pool } = pkg;
const router = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
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
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
};

const pickSalesmanId = (customer) =>
  customer?.salesmanId ??
  customer?.salesman_id ??
  customer?.salesmanNo ??
  customer?.salesman_no ??
  customer?.salesId ??
  customer?.sales_id ??
  null;

const pickSalesmanName = (customer) =>
  customer?.salesmanName ??
  customer?.salesman_name ??
  customer?.salesman ??
  customer?.sales_name ??
  customer?.salesName ??
  null;

// Medad in this tenant may not expose a distinct salesman ID.
// Fall back to normalized salesman name as a stable string key.
const buildSalesmanKey = (customer) => {
  const idRaw = pickSalesmanId(customer);
  const id = idRaw != null ? idRaw.toString().trim() : '';
  if (id) return { key: id, source: 'id' };

  const nameRaw = pickSalesmanName(customer);
  const name = nameRaw != null ? nameRaw.toString().trim() : '';
  if (name) return { key: name, source: 'name_fallback' };

  return { key: '', source: 'none' };
};

const normalize = (value) =>
  (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

// GET /api/medad/salesmen?search=
router.get('/medad/salesmen', async (req, res) => {
  try {
    const token = await getMedadToken();
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const PAGE_SIZE = 100;
    let page = 1;

    const byId = new Map();

    while (true) {
      const url = `${process.env.MEDAD_BASE_URL}/customers?accountType=0&page=${page}&limit=${PAGE_SIZE}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Failed to fetch Medad customers');
      }

      const data = await response.json();
      const raw =
        data?.customers ||
        data?.items ||
        data?.data ||
        (Array.isArray(data) ? data : []);
      const batch = Array.isArray(raw) ? raw : [];

      for (const c of batch) {
        const salesmanKey = buildSalesmanKey(c);
        const salesmanNameRaw = pickSalesmanName(c);
        const salesmanId = salesmanKey.key;
        const salesmanName = salesmanNameRaw != null ? salesmanNameRaw.toString().trim() : '';

        // Keep rows with either true ID or fallback name key.
        if (!salesmanId) continue;

        const existing = byId.get(salesmanId) || {
          medad_salesman_id: salesmanId,
          salesman_name: salesmanName || null,
          id_source: salesmanKey.source,
          customers_count: 0,
        };
        existing.customers_count += 1;
        if (!existing.salesman_name && salesmanName) existing.salesman_name = salesmanName;
        byId.set(salesmanId, existing);
      }

      const noMore = batch.length < PAGE_SIZE;
      const totalPages = data.total_pages || data.totalPages;
      if (noMore || (totalPages && page >= totalPages)) break;
      page += 1;
    }

    let salesmen = Array.from(byId.values());
    if (search) {
      salesmen = salesmen.filter((s) => {
        const blob = `${s.medad_salesman_id} ${s.salesman_name || ''}`.toLowerCase();
        return blob.includes(search);
      });
    }

    salesmen.sort((a, b) => {
      const na = (a.salesman_name || '').toLowerCase();
      const nb = (b.salesman_name || '').toLowerCase();
      if (na && nb) return na.localeCompare(nb);
      if (na) return -1;
      if (nb) return 1;
      return a.medad_salesman_id.localeCompare(b.medad_salesman_id);
    });

    return res.status(200).json({ success: true, salesmen, total: salesmen.length });
  } catch (error) {
    console.error('Medad salesmen fetch error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to fetch salesmen' });
  }
});

// POST /api/medad/salesmen/assign
// Body: { role: "manager" | "salesRep" | "supervisor", userId: number, medad_salesman_id: string }
router.post('/medad/salesmen/assign', async (req, res) => {
  const client = await pool.connect();
  try {
    const role = (req.body.role || '').toString();
    const userId = Number(req.body.userId);
    const medadSalesmanId = (req.body.medad_salesman_id || req.body.medadSalesmanId || '').toString().trim();

    if (!['manager', 'salesRep', 'supervisor'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Invalid userId' });
    }
    if (!medadSalesmanId) {
      return res.status(400).json({ success: false, error: 'medad_salesman_id is required' });
    }

    const table =
      role === 'manager' ? 'managers' :
      role === 'salesRep' ? 'salesreps' :
      'supervisors';

    const query = `
      UPDATE ${table}
      SET medad_salesman_id = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, name, email, medad_salesman_id
    `;

    const result = await client.query(query, [medadSalesmanId, userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    return res.status(200).json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Medad salesman assignment error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Assignment failed' });
  } finally {
    client.release();
  }
});

// POST /api/medad/salesmen/auto-match
// Matches by normalized name when unique on Medad side.
router.post('/medad/salesmen/auto-match', async (req, res) => {
  const client = await pool.connect();
  try {
    const role = (req.body.role || '').toString();
    const dryRun = Boolean(req.body.dryRun ?? true);

    if (!['manager', 'salesRep', 'supervisor'].includes(role)) {
      return res.status(400).json({ success: false, error: 'Invalid role' });
    }

    const table =
      role === 'manager' ? 'managers' :
      role === 'salesRep' ? 'salesreps' :
      'supervisors';

    const token = await getMedadToken();
    const PAGE_SIZE = 100;
    let page = 1;
    const medadByName = new Map();

    while (true) {
      const url = `${process.env.MEDAD_BASE_URL}/customers?accountType=0&page=${page}&limit=${PAGE_SIZE}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(await response.text());

      const data = await response.json();
      const raw =
        data?.customers ||
        data?.items ||
        data?.data ||
        (Array.isArray(data) ? data : []);
      const batch = Array.isArray(raw) ? raw : [];

      for (const c of batch) {
        const sid = buildSalesmanKey(c).key;
        const sname = pickSalesmanName(c);
        const idStr = sid != null ? sid.toString().trim() : '';
        const nameNorm = normalize(sname);
        if (!idStr || !nameNorm) continue;

        if (!medadByName.has(nameNorm)) medadByName.set(nameNorm, new Set());
        medadByName.get(nameNorm).add(idStr);
      }

      const noMore = batch.length < PAGE_SIZE;
      const totalPages = data.total_pages || data.totalPages;
      if (noMore || (totalPages && page >= totalPages)) break;
      page += 1;
    }

    const localsResult = await client.query(
      `SELECT id, name, medad_salesman_id FROM ${table} WHERE active = TRUE`
    );

    const candidates = [];
    for (const row of localsResult.rows) {
      if (row.medad_salesman_id) continue;
      const key = normalize(row.name);
      if (!key) continue;
      const set = medadByName.get(key);
      if (!set || set.size !== 1) continue;
      const matchedId = Array.from(set)[0];
      candidates.push({ id: row.id, name: row.name, medad_salesman_id: matchedId });
    }

    if (!dryRun) {
      for (const c of candidates) {
        await client.query(
          `UPDATE ${table} SET medad_salesman_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [c.medad_salesman_id, c.id]
        );
      }
    }

    return res.status(200).json({
      success: true,
      role,
      dryRun,
      matchedCount: candidates.length,
      matches: candidates,
    });
  } catch (error) {
    console.error('Medad auto-match error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Auto-match failed' });
  } finally {
    client.release();
  }
});

export default router;
