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
  if (!token) {
    throw new Error('Medad token not found in response');
  }

  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
};

const formatDate = (value) => {
  if (!value) return null;
  try {
    return new Date(value).toISOString().split('T')[0];
  } catch {
    return null;
  }
};

router.post('/medad/invoice/:orderId', async (req, res) => {
  const { orderId } = req.params;

  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId' });
  }

  const client = await pool.connect();
  try {
    const orderQuery = `
      SELECT 
        o.*,
        c.company_name,
        c.client_name,
        c.phone_number,
        c.street,
        c.city,
        c.region,
        c.tax_number,
        cmc.medad_customer_id,
        cmc.vat_no AS medad_vat_no,
        cmc.salesman_name,
        cmc.address1 AS medad_address1,
        cmc.address2 AS medad_address2,
        cmc.city AS medad_city,
        cmc.region AS medad_region,
        cmc.phone AS medad_phone,
        cmc.vat_type AS medad_vat_type,
        cmc.warehouse_no AS medad_warehouse_no
      FROM orders o
      JOIN clients c ON o.client_id = c.id
      LEFT JOIN client_medad_customers cmc ON o.client_medad_customer_id = cmc.id
      WHERE o.id = $1
    `;
    const orderResult = await client.query(orderQuery, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    const productsResult = await client.query(
      `SELECT id, medad_product_no, description, quantity, price, vat, subtotal
       FROM order_products
       WHERE order_id = $1
       ORDER BY id ASC`,
      [orderId]
    );

    const products = productsResult.rows;

    const missingCustomer = !order.client_medad_customer_id || !order.medad_customer_id;
    const missingWarehouse = !order.warehouse_no;
    const missingSalesman = !order.medad_salesman_id;
    const missingProduct = products.some(p => !p.medad_product_no);

    if (missingCustomer || missingWarehouse || missingSalesman || missingProduct) {
      const reasons = [];
      if (missingCustomer) reasons.push('Missing linked Medad customer');
      if (missingWarehouse) reasons.push('Missing warehouse_no');
      if (missingSalesman) reasons.push('Missing medad_salesman_id');
      if (missingProduct) reasons.push('One or more products missing medad_product_no');

      await client.query(
        `UPDATE orders 
         SET medad_sync_status = 'FAILED', medad_error = $2, medad_synced_at = NOW()
         WHERE id = $1`,
        [orderId, reasons.join('; ')]
      );

      return res.status(400).json({ error: 'Order not ready for Medad', details: reasons });
    }

    await client.query(
      `UPDATE orders 
       SET medad_sync_status = 'READY_FOR_MEDAD', medad_error = NULL
       WHERE id = $1`,
      [orderId]
    );

    const orderDate = formatDate(order.created_at);
    const dueDate = formatDate(order.delivery_date) || orderDate;

    const orderDetail = products.map((p, index) => {
      const quantity = parseFloat(p.quantity) || 0;
      const price = Number(p.price) || 0;
      const lineTotal = price * quantity;
      const tax = Number(p.vat) || 0;
      const taxPercent = lineTotal > 0 ? (tax / lineTotal) * 100 : 0;

      return {
        lineNo: index + 1,
        productNo: p.medad_product_no,
        productDesc: p.description || '',
        price,
        quantity,
        subTotal: Number(p.subtotal) || lineTotal,
        vatPrice: tax,
        tax,
        taxPercent: Number(taxPercent.toFixed(4)),
        subTotalPlusTax: Number(p.subtotal) || lineTotal + tax,
      };
    });

    const payload = {
      orderNo: order.order_number,
      orderDate,
      customerId: order.medad_customer_id,
      salesmanId: order.medad_salesman_id,
      warehouseNo: order.medad_warehouse_no || order.warehouse_no,
      note: order.notes || '',
      net: Number(order.total_price) || 0,
      total: Number(order.total_subtotal) || 0,
      totalTax: Number(order.total_vat) || 0,
      totalCost: Number(order.total_price) || 0,
      dueDate,
      address1: order.medad_address1 || order.street || '',
      address2: order.medad_address2 || order.medad_city || order.medad_region || order.city || order.region || '',
      vatType: order.medad_vat_type ?? undefined,
      vatNo: order.medad_vat_no || order.tax_number || '',
      orderTaxInPrice: 'N',
      customerName: order.company_name || order.client_name || '',
      Order_Detail: orderDetail,
    };

    const token = await getMedadToken();
    const response = await fetch(`${process.env.MEDAD_BASE_URL}/invoice`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      await client.query(
        `UPDATE orders 
         SET medad_sync_status = 'FAILED', medad_error = $2, medad_synced_at = NOW()
         WHERE id = $1`,
        [orderId, text]
      );
      return res.status(502).json({ error: 'Medad invoice failed', details: text });
    }

    const result = await response.json();

    await client.query(
      `UPDATE orders 
       SET medad_sync_status = 'SENT_TO_MEDAD',
           medad_order_no = $2,
           medad_invoice_no = $3,
           medad_error = NULL,
           medad_synced_at = NOW()
       WHERE id = $1`,
      [
        orderId,
        result.orderNo || result.order_no || null,
        result.invoiceNo || result.invoice_no || null,
      ]
    );

    return res.status(200).json({ success: true, medad: result, payload });
  } catch (error) {
    console.error('Medad invoice error:', error);
    return res.status(500).json({ error: 'Medad invoice error', details: error.message });
  } finally {
    client.release();
  }
});

export default router;
