import express from 'express';
import { Pool } from 'pg';

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Simple cached token helper for Medad auth
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
  if (!token) {
    throw new Error('Medad token not found in response');
  }

  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000; // refresh 1 min early
  return cachedToken;
};

const normalize = (value) =>
  (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const resolveCurrentUserSalesmanScope = async ({ clerkId, username }) => {
  const normalizedUsername = normalize(username);
  const scope = {
    salesmanIds: new Set(),
    salesmanNames: new Set(),
    hasScope: false,
    strictById: false,
  };

  if (!clerkId && !normalizedUsername) return scope;
  scope.hasScope = true;

  const tables = ['salesreps', 'managers', 'supervisors'];
  const client = await pool.connect();
  try {
    // First pass: resolve strictly by clerkId (most reliable).
    for (const table of tables) {
      if (clerkId) {
        const byClerk = await client.query(
          `SELECT medad_salesman_id, name FROM ${table} WHERE clerk_id = $1 LIMIT 1`,
          [clerkId]
        );
        const row = byClerk.rows[0];
        if (row?.medad_salesman_id) scope.salesmanIds.add(String(row.medad_salesman_id).trim());
        if (row?.name) scope.salesmanNames.add(normalize(row.name));
      }
    }

    // Second pass: fallback by name only if no salesman ID was resolved.
    if (scope.salesmanIds.size === 0 && normalizedUsername) {
      for (const table of tables) {
        const byName = await client.query(
          `SELECT medad_salesman_id, name FROM ${table} WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1`,
          [normalizedUsername]
        );
        const row = byName.rows[0];
        if (row?.medad_salesman_id) scope.salesmanIds.add(String(row.medad_salesman_id).trim());
        if (row?.name) scope.salesmanNames.add(normalize(row.name));
      }
    }
  } finally {
    client.release();
  }

  if (scope.salesmanIds.size > 0) {
    scope.strictById = true;
    // When we have a mapped salesman ID, do not widen scope by name.
    scope.salesmanNames.clear();
  } else if (normalizedUsername) {
    // Name fallback only when no mapped salesman ID exists.
    scope.salesmanNames.add(normalizedUsername);
  }

  return scope;
};

const pickSalesmanId = (customer) =>
  customer?.salesmanId?.toString?.() ||
  customer?.salesman_id?.toString?.() ||
  customer?.salesmanNo?.toString?.() ||
  customer?.salesman_no?.toString?.() ||
  customer?.salesId?.toString?.() ||
  customer?.sales_id?.toString?.() ||
  '';

const pickSalesmanName = (customer) =>
  customer?.salesmanName ||
  customer?.salesman_name ||
  customer?.salesman ||
  customer?.sales_name ||
  '';

// Lightweight Medad clients list for linking
router.get('/medad/clients', async (req, res) => {
  try {
    const username = (req.query.username || '').toString().trim();
    const clerkId = (req.query.clerkId || req.query.clerk_id || '').toString().trim();
    const userScope = await resolveCurrentUserSalesmanScope({ clerkId, username });
    const token = await getMedadToken();

    const accountType = '0'; // 0 = customers
    const PAGE_SIZE = 100;
    let page = 1;

    const clients = [];
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
        throw new Error(text || 'Failed to fetch Medad clients');
      }

      const data = await response.json();
      const raw =
        data?.customers ||
        data?.items ||
        data?.data ||
        (Array.isArray(data) ? data : []);

      const batch = Array.isArray(raw) ? raw : [];

      const normalized = batch
        .map((c) => {
          if (userScope.hasScope) {
            const salesmanId = pickSalesmanId(c).trim();
            const salesmanName = normalize(pickSalesmanName(c));
            if (userScope.strictById) {
              if (!salesmanId || !userScope.salesmanIds.has(salesmanId)) return null;
            } else {
              const matchByName = salesmanName && userScope.salesmanNames.has(salesmanName);
              if (!matchByName) return null;
            }
          }

          const id = c.id?.toString() || c.customerId?.toString();
          if (!id || seen.has(id)) return null;

          seen.add(id);

          return {
            medad_customer_id: id,
            name: c.name || c.company_name || '',
            vat_no: c.vatNo || c.vat_no || '',
            phone: c.phone || c.contact1Phone || '',
            branch: c.branch || '',
            salesman_id: pickSalesmanId(c),
            salesman_name: pickSalesmanName(c),
          };
        })
        .filter(Boolean);

      clients.push(...normalized);

      const noMore = batch.length < PAGE_SIZE;
      const totalPages = data.total_pages || data.totalPages;
      if (noMore || (totalPages && page >= totalPages)) break;

      page += 1;
    }

    return res.status(200).json({
      success: true,
      clients,
    });
  } catch (err) {
    console.error('❌ Failed to fetch Medad clients:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
