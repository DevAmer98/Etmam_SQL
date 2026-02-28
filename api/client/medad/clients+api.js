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

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff\s]/g, ' ')
    .replace(/\s+/g, ' ');

const resolveCurrentUserSalesmanScope = async ({ clerkId, explicitSalesmanId, clerkName }) => {
  const scope = {
    salesmanIds: new Set(),
    salesmanNames: new Set(),
    hasScope: false,
    mode: 'none',
  };

  const requestedSalesmanId = String(explicitSalesmanId || '').trim();
  if (requestedSalesmanId) {
    scope.hasScope = true;
    scope.salesmanIds.add(requestedSalesmanId);
    scope.mode = 'id';
    return scope;
  }

  const requestedName = normalizeName(clerkName);
  if (requestedName) {
    scope.hasScope = true;
    scope.salesmanNames.add(requestedName);
    scope.mode = 'name';
    return scope;
  }

  if (!clerkId) return scope;
  scope.hasScope = true;
  scope.mode = 'id';

  const tables = ['salesreps', 'managers', 'supervisors'];
  const client = await pool.connect();
  try {
    for (const table of tables) {
      const byClerk = await client.query(
        `SELECT medad_salesman_id FROM ${table} WHERE clerk_id = $1 LIMIT 1`,
        [clerkId]
      );
      const row = byClerk.rows[0];
      if (row?.medad_salesman_id) scope.salesmanIds.add(String(row.medad_salesman_id).trim());
    }
  } finally {
    client.release();
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
    const clerkId = (req.query.clerkId || req.query.clerk_id || '').toString().trim();
    const clerkName = (req.query.clerkName || req.query.clerk_name || '').toString().trim();
    const explicitSalesmanId = (req.query.medadSalesmanId || req.query.medad_salesman_id || '').toString().trim();
    const userScope = await resolveCurrentUserSalesmanScope({ clerkId, explicitSalesmanId, clerkName });

    // Strict rule:
    // - id mode requires at least one salesman ID
    // - name mode requires at least one normalized name
    if (
      userScope.hasScope &&
      ((userScope.mode === 'id' && userScope.salesmanIds.size === 0) ||
        (userScope.mode === 'name' && userScope.salesmanNames.size === 0))
    ) {
      return res.status(200).json({
        success: true,
        clients: [],
      });
    }

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
            if (userScope.mode === 'name') {
              const salesmanName = normalizeName(pickSalesmanName(c));
              if (!salesmanName || !userScope.salesmanNames.has(salesmanName)) return null;
            } else {
              const salesmanId = pickSalesmanId(c).trim();
              if (!salesmanId || !userScope.salesmanIds.has(salesmanId)) return null;
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
