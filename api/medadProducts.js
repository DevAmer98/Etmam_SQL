let cachedToken = null;
let tokenExpiry = 0;

/* ================= TOKEN HANDLER ================= */
async function getMedadToken() {
  // Reuse token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  // Build payload safely (year is OPTIONAL)
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
    body: JSON.stringify(payload), // ✅ USE PAYLOAD
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Medad token request failed: ${text}`);
  }

  const data = await response.json();

  // Token may come in different shapes
  const token =
    data.token ||
    data.access_token ||
    data?.data?.token;

  if (!token) {
    throw new Error('Medad token not found in response');
  }

  // Expiry handling (default 1 hour)
  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);

  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000; // refresh 1 min early

  return cachedToken;
}

/* ================= PRODUCTS ENDPOINT ================= */
export default async function medadProducts(req, res) {
  try {
    const token = await getMedadToken();

    const PAGE_SIZE = 200; // try to grab everything in a few calls (Medad defaults to 10)
    let page = 1;
    const all = [];
    const seen = new Set();

    // fetch pages until no new items arrive (covers APIs that ignore pagination too)
    while (true) {
      const url = `${process.env.MEDAD_BASE_URL}/products?page=${page}&limit=${PAGE_SIZE}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('Medad products error:', text);
        return res.status(500).json({
          error: 'Failed to fetch products from Medad',
        });
      }

      const data = await response.json();

      // Normalize response
      const items =
        data.items ||
        data.data ||
        (Array.isArray(data) ? data : []);

      const totalPages = data.total_pages || data.totalPages || data.totalpages;

      const fresh = items.filter(p => {
        const key = p.productNo || p.id || JSON.stringify(p);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      all.push(...fresh);

      // stop if:
      // - we reached the reported total pages
      // - fewer than requested page size returned
      // - no new items (duplicate-only)
      if (
        (totalPages && page >= totalPages) ||
        items.length < PAGE_SIZE ||
        fresh.length === 0 ||
        page >= 200 // absolute safety cap
      ) {
        break;
      }
      page += 1;
    }

    return res.status(200).json({ items: all });
  } catch (error) {
    console.error('Medad integration error:', error);
    return res.status(500).json({
      error: 'Medad integration error',
    });
  }
}
