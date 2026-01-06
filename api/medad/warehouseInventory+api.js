import express from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';

const router = express.Router();

// Lightweight token cache (duplicated here to avoid coupling to other handlers)
let cachedToken = null;
let tokenExpiry = 0;

async function getMedadToken() {
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
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
}

// GET /api/medad/warehouses/:warehouseNo/inventory?page=&limit=
router.get(
  '/medad/warehouses/:warehouseNo/inventory',
  asyncHandler(async (req, res) => {
    const { warehouseNo } = req.params;
    if (!warehouseNo) return res.status(400).json({ error: 'warehouseNo is required' });

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));

    const token = await getMedadToken();
    const url = `${process.env.MEDAD_BASE_URL}/warehouses/${encodeURIComponent(
      warehouseNo,
    )}/inventory?page=${page}&limit=${limit}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text || 'Failed to fetch warehouse inventory' });
    }

    const data = await response.json();

    // Normalize shape to always include items/page/limit/totalPages if present
    const items = data.items || data.data || (Array.isArray(data) ? data : []);
    const total = data.total ?? data.total_items ?? data.totalItems ?? items.length;
    const totalPages = data.total_pages ?? data.totalPages ?? (Math.ceil(total / limit) || 1);

    return res.status(200).json({
      items,
      total,
      page,
      limit,
      total_pages: totalPages,
    });
  }),
);

export default router;
