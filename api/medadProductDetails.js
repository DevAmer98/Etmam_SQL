export default async function medadProductDetails(req, res) {
  try {
    const { productNo } = req.params;
    const token = await getMedadToken();

    const response = await fetch(
      `${process.env.MEDAD_BASE_URL}/products/${productNo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: text });
    }

    const data = await response.json();

    // Normalize warehouses
    const warehouses = {};
    (data.warehouses || []).forEach(w => {
      const code = w.warehouseNo.padStart(4, '0');
      warehouses[code] = {
        quantity: typeof w.quantity === 'number' ? w.quantity : 0,
      };
    });

    res.json({
      code: data.productNo,
      description: data.description,
      warehouses,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Medad product details error' });
  }
}
