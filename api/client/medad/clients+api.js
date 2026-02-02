import express from 'express';

const router = express.Router();

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

// Lightweight Medad clients list for linking
router.get('/medad/clients', async (_req, res) => {
  try {
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
          const id = c.id?.toString() || c.customerId?.toString();
          if (!id || seen.has(id)) return null;

          seen.add(id);

          return {
            medad_customer_id: id,
            name: c.name || c.company_name || '',
            vat_no: c.vatNo || c.vat_no || '',
            phone: c.phone || c.contact1Phone || '',
            branch: c.branch || '',
            salesman_id:
              c.salesmanId?.toString?.() ||
              c.salesman_id?.toString?.() ||
              c.salesmanNo?.toString?.() ||
              c.salesman_no?.toString?.() ||
              c.salesId?.toString?.() ||
              c.sales_id?.toString?.() ||
              '',
            salesman_name: c.salesman || c.salesmanName || '',
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
