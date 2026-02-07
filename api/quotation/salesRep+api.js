import express from 'express';
import moment from 'moment-timezone'; // Ensure moment-timezone is installed
import admin from '../../firebase-init.js';
import pkg from 'pg'; // New
import { resolveUserDefaults } from '../../utils/resolveUserDefaults.js';
const { Pool } = pkg; // Destructure Pool

const router = express.Router();


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,  
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

router.use(express.json()); // Middleware to parse JSON bodies

// Utility function to retry database operations
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

// Utility function to add timeout to database queries
const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

const generateCustomId = async (client) => {
  const year = new Date().getFullYear();
  const result = await client.query(
    `SELECT MAX(SUBSTRING(custom_id FROM 10 FOR 5)::int) AS last_id 
     FROM quotations 
     WHERE custom_id LIKE $1`,
    [`NPQ-${year}-%`]
  );
  const lastId = result.rows[0].last_id || 0;
  const newId = `NPQ-${year}-${String(lastId + 1).padStart(5, '0')}`; // Format: NPQ-YYYY-XXXXX
  return newId;
};

async function sendNotificationToManager(message, title = 'Notification') {
  const client = await pool.connect();
  try {
    // Fetch FCM tokens for storekeepers
    const query = 'SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE';
    const result = await executeWithRetry(async () => {
      return await withTimeout(client.query(query, ['manager']), 10000); // 10-second timeout
    });
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to managers:`, tokens);

    // Check if tokens array is empty
    if (tokens.length === 0) {
      console.warn('No FCM tokens found for managers. Skipping notification.');
      return;
    }

    // Prepare the messages for Firebase
    const messages = tokens.map((token) => ({
      notification: {
        title: title,
        body: message,
      },
      data: {
        role: 'manager', // Add role information to the payload
      },
      token,
    }));
 
    // Send the notifications
    const response = await admin.messaging().sendEach(messages);
    console.log('Successfully sent messages:', response);
    return response;
  } catch (error) {
    console.error('Failed to send FCM messages:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Function to send notifications to supervisors
async function sendNotificationToSupervisor(message, title = 'Notification') {
  const client = await pool.connect();
  try {
    // Fetch FCM tokens for supervisors
    const query = 'SELECT fcm_token FROM Supervisors WHERE role = $1 AND active = TRUE';
    const result = await client.query(query, ['supervisor']);
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to supervisor:`, tokens);

    // Check if tokens array is empty
    if (tokens.length === 0) {
      console.warn('No FCM tokens found for supervisors. Skipping notification.');
      return;
    }

    // Prepare the messages for Firebase
    const messages = tokens.map((token) => ({
      notification: {
        title: title,
        body: message,
      },
      data: {
        role: 'supervisor', // Add role information to the payload
      },
      token,
    }));

    // Send the notifications
    const response = await admin.messaging().sendEach(messages);
    console.log('Successfully sent messages:', response);
    return response;
  } catch (error) {
    console.error('Failed to send FCM messages:', error);
    throw error;
  } finally {
    client.release();
  }
}

router.post('/quotations/salesRep', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { client_id, username, sales_rep_id, delivery_date, delivery_type, products, notes, manager_notes, condition = 'نقدي - كاش', status = 'not Delivered', warehouse_no, medad_salesman_id, clerkId, clerk_id } = req.body;

    // Validate required fields
    if (!client_id || !username || !sales_rep_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      throw new Error('Missing required fields');
    }

    // Format delivery date
    const formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
    const customId = await generateCustomId(client); // Generate custom_id without RevX

    const resolvedDefaults = await resolveUserDefaults({
      client,
      role: 'salesRep',
      clerkId: clerkId || clerk_id || null,
      username
    });
    const resolvedWarehouseNo = warehouse_no || resolvedDefaults.warehouse_no || null;
    const resolvedMedadSalesmanId = medad_salesman_id || resolvedDefaults.medad_salesman_id || null;

    // Insert main quotation
    const insertQuery = `
      INSERT INTO quotations (client_id, username, sales_rep_id, warehouse_no, medad_salesman_id, delivery_date, delivery_type, notes, manager_notes, status, total_price, total_vat, total_subtotal, custom_id, condition)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id
    `;
    const insertParams = [client_id, username, sales_rep_id, resolvedWarehouseNo, resolvedMedadSalesmanId, formattedDate, delivery_type, notes || null,  manager_notes || null, status, 0, 0, 0, customId, condition];
    const quotationResult = await client.query(insertQuery, insertParams);
    const quotationId = quotationResult.rows[0].id;

    let totalPrice = 0, totalVat = 0, totalSubtotal = 0;
    // Insert products
    for (const product of products) {
      const { description, quantity, price } = product;
      if (!quantity || !price) {
        throw new Error('Missing product details or price');
      }
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice)) { throw new Error('Invalid price format'); }
      const vat = numericPrice * 0.15;
      const subtotal = numericPrice + vat;
      totalPrice += numericPrice * quantity;
      totalVat += vat * quantity;
      totalSubtotal += subtotal * quantity;
      await client.query(
        `INSERT INTO quotation_products (quotation_id,description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quotationId,description, quantity, numericPrice, vat, subtotal]
      );
    }

    // Update the quotation totals
    await client.query(
      `UPDATE quotations SET total_price = $1, total_vat = $2, total_subtotal = $3 WHERE id = $4`,
      [totalPrice, totalVat, totalSubtotal, quotationId]
    );

    await client.query('COMMIT');
    await sendNotificationToSupervisor(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');
    await sendNotificationToManager(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');

    return res.status(201).json({
      quotationId,
      customId,
      status: 'success',
      totalPrice,
      totalVat,
      totalSubtotal,
      condition,
    });
  } catch (error) {
    console.error('Transaction Error:', error);
    await client.query('ROLLBACK');
    return res.status(500).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});



// GET endpoint to fetch orders
router.get('/quotations/salesRep', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = req.query.query || '';
    const username = req.query.username || '';
    const filter = req.query.filter || 'all';
    const offset = (page - 1) * limit;

    // ✅ Make baseQuery and countQuery mutable (let, not const)
    let baseQuery = `
      SELECT 
        quotations.*, 
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
        clients.username AS client_added_by,
        quotations.status,
        quotations.storekeeperaccept,
        quotations.actual_delivery_date,
        quotations.total_price,
        quotations.total_vat,
        quotations.total_subtotal
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE clients.username = $4
        AND (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
    `;

    if (filter === 'ready') {
      baseQuery += ` AND quotations.ready = TRUE`;
    }

    baseQuery += ` ORDER BY quotations.created_at DESC LIMIT $1 OFFSET $2`;

    let countQuery = `
      SELECT COUNT(*) AS total
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE clients.username = $2
        AND (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
    `;

    if (filter === 'ready') {
      countQuery += ` AND quotations.ready = TRUE`;
    }

    const baseQueryParams = [limit, offset, `%${query}%`, username];
    const countQueryParams = [`%${query}%`, username];

    const [quotationsResult, countResult] = await executeWithRetry(async () => {
      return await Promise.all([
        withTimeout(client.query(baseQuery, baseQueryParams), 10000),
        withTimeout(client.query(countQuery, countQueryParams), 10000),
      ]);
    });

    const orders = quotationsResult.rows;
    const totalCount = parseInt(countResult.rows[0]?.total || 0, 10);
    const hasMore = page * limit < totalCount;

    return res.status(200).json({
      orders,
      hasMore,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching quotations:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching quotations',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});


export default router;
