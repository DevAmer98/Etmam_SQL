import express from 'express';

const router = express.Router();

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

// GET /api/medad/suppliers?search=
router.get('/medad/suppliers', async (req, res) => {
  try {
    const token = await getMedadToken();
    const search = (req.query.search || '').toString().trim().toLowerCase();
    const accountType = (process.env.MEDAD_SUPPLIER_ACCOUNT_TYPE ?? '1').toString();
    const PAGE_SIZE = 100;

    let page = 1;
    const seen = new Set();
    const suppliers = [];

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
        throw new Error(text || 'Failed to fetch Medad suppliers');
      }

      const data = await response.json();
      const raw =
        data?.customers ||
        data?.items ||
        data?.data ||
        (Array.isArray(data) ? data : []);
      const batch = Array.isArray(raw) ? raw : [];

      const normalized = batch
        .map((item, idx) => {
          const id = item.id?.toString() || item.customerId?.toString() || `${page}-${idx}`;
          if (seen.has(id)) return null;
          seen.add(id);

          const supplierName =
            item.name ||
            item.supplier_name ||
            item.company_name ||
            'Supplier';
          const companyName =
            item.company_name ||
            item.name ||
            item.supplier_name ||
            '';
          const phoneNumber = item.phone || item.contact1Phone || '';
          const blob = `${supplierName} ${companyName} ${phoneNumber}`.toLowerCase();
          if (search && !blob.includes(search)) return null;

          return {
            id,
            supplier_name: supplierName,
            company_name: companyName,
            phone_number: phoneNumber,
          };
        })
        .filter(Boolean);

      suppliers.push(...normalized);

      const totalPages = data.total_pages || data.totalPages || data.totalpages;
      const noMore = batch.length < PAGE_SIZE || page >= 50;
      if (noMore || (totalPages && page >= totalPages)) break;
      page += 1;
    }

    return res.status(200).json({
      success: true,
      suppliers,
      total: suppliers.length,
    });
  } catch (error) {
    console.error('Medad suppliers fetch error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Medad suppliers',
    });
  }
});

export default router;
