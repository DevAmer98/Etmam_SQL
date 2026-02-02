import express from 'express';
import pkg from 'pg'; 
const { Pool } = pkg; 

const router = express.Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json());

const executeWithRetry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(fn, retries - 1, delay * 2);
    }
    throw error;
  }
};

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

router.get('/orders/forAccountant', async (req, res) => {
  const client = await pool.connect();
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const query = `%${url.searchParams.get('query') || ''}%`;
    const mark = url.searchParams.get('mark'); // ✅ only filtering by mark now
    const offset = (page - 1) * limit;

    const whereClauses = [
      `(clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)`,
      `orders.storekeeperaccept = 'accepted'`
    ];
    const values = [query];
    let paramIndex = 2;

    if (mark && mark !== 'all') {
      whereClauses.push(`orders.mark = $${paramIndex++}`);
      values.push(mark);
    }

    const whereSQL = `WHERE ${whereClauses.join(' AND ')}`;

    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      ${whereSQL}
    `;

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, values)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    const baseQuery = `
      SELECT 
        orders.*, 
        clients.client_name AS client_name,
        clients.phone_number AS client_phone,
        clients.company_name AS client_company,
        clients.branch_number AS client_branch,
        clients.tax_number AS client_tax,
        clients.latitude AS client_latitude,
        clients.longitude AS client_longitude,
        clients.street AS client_street,
        clients.city AS client_city,
        clients.region AS client_region,
        orders.status,
        orders.storekeeperaccept,
        orders.supervisorAccept,
        orders.actual_delivery_date,
        orders.order_number,
        orders.total_price,
        cmc.id AS linked_medad_link_id,
        cmc.medad_customer_id AS linked_medad_customer_id,
        CASE
          WHEN orders.client_medad_customer_id IS NOT NULL OR cmc.id IS NOT NULL THEN TRUE
          ELSE FALSE
        END AS client_synced
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      LEFT JOIN LATERAL (
        SELECT id, medad_customer_id
        FROM client_medad_customers
        WHERE CAST(client_id AS TEXT) = CAST(orders.client_id AS TEXT)
        ORDER BY id DESC
        LIMIT 1
      ) cmc ON TRUE
      ${whereSQL}
      ORDER BY orders.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    const baseParams = [...values, limit, offset];

    const ordersResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = ordersResult.rows;
    const orderIds = orders.map(order => order.id);

    let locationMap = {};
    if (orderIds.length > 0) {
      const locationQuery = `
        SELECT order_id, name, url
        FROM order_locations
        WHERE order_id = ANY($1)
      `;
      const locationResult = await client.query(locationQuery, [orderIds]);

      locationResult.rows.forEach(loc => {
        if (!locationMap[loc.order_id]) locationMap[loc.order_id] = [];
        locationMap[loc.order_id].push({ name: loc.name, url: loc.url });
      });
    }

    orders.forEach(order => {
      order.deliveryLocations = locationMap[order.id] || [];
    });

    res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});


export default router;
