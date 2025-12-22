let cachedToken = null;
let tokenExpiry = 0;

/* ================= TOKEN HANDLER ================= */
async function getMedadToken() {
  // Reuse token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const response = await fetch(`${process.env.MEDAD_BASE_URL}/getToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      username: process.env.MEDAD_USERNAME,
      password: process.env.MEDAD_PASSWORD,
      year: process.env.MEDAD_YEAR,
      subscriptionId: process.env.MEDAD_SUBSCRIPTION_ID,
      branch: Number(process.env.MEDAD_BRANCH),
    }),
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

  // Expiry handling (default 1 hour if not provided)
  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);

  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000; // refresh 1 min early

  return cachedToken;
}

/* ================= PRODUCTS ENDPOINT ================= */
export default async function medadProducts(req, res) {
  try {
    const token = await getMedadToken();

    const response = await fetch(`${process.env.MEDAD_BASE_URL}/products`, {
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

    // Normalize response (Medad is not always consistent)
    const items =
      data.items ||
      data.data ||
      (Array.isArray(data) ? data : []);

    return res.status(200).json({ items });
  } catch (error) {
    console.error('Medad integration error:', error);
    return res.status(500).json({
      error: 'Medad integration error',
    });
  }
}
