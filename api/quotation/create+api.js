import express from 'express';
import moment from 'moment-timezone';
import admin from '../../firebase-init.js';
import pkg from 'pg';
import { resolveUserDefaults } from '../../utils/resolveUserDefaults.js';
const { Pool } = pkg;

const router = express.Router();

/*const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
});
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false, // 👈 Disables SSL
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
router.use(express.json());

const withTimeout = (promise, timeout) => {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Database query timed out')), timeout)
  );
  return Promise.race([promise, timeoutPromise]);
};

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

const hasQuotationWarehouseNoColumn = async (client) => {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'quotations' AND column_name = 'warehouse_no'
     LIMIT 1`
  );
  return result.rowCount > 0;
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




// POST endpoint to create a quotation
router.post('/quotations', async (req, res) => {
  const client = await pool.connect();
  try {
        await client.query('BEGIN');
      const {
       client_id, 
      username, 
      manager_id, 
      warehouse_no,
      medad_salesman_id,
      clerkId,
      clerk_id,
      delivery_date, 
      delivery_type, 
      products,  
      notes,  
      manager_notes,  
      condition = 'نقدي - كاش', 
      status = 'not Delivered',
      manageraccept = 'accepted' 
      } = req.body;

      // Debugging: Log the request body
      console.log('Request Body:', req.body);

      // Validate required fields
      if (!client_id || !username || !delivery_date || !delivery_type || !products || products.length === 0) {
        await client.query('ROLLBACK'); // Rollback if validation fails
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const resolvedDefaults = await resolveUserDefaults({
        client,
        role: 'manager',
        clerkId: clerkId || clerk_id || null,
        username
      });
      const resolvedWarehouseNo = warehouse_no || resolvedDefaults.warehouse_no || null;
      const resolvedMedadSalesmanId = medad_salesman_id || resolvedDefaults.medad_salesman_id || null;


      
          // Format delivery date
          const formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
          const customId = await generateCustomId(client);

                      // Fetch the max order_number currently in the DB
const { rows } = await client.query('SELECT MAX(order_number) AS max FROM orders');
const maxOrderNumber = rows[0].max || 0;
const newQuotationNumber = maxOrderNumber + 1;


const nowUtc = moment().tz('UTC').format('YYYY-MM-DD HH:mm:ss');
const manageraccept_at =
  manageraccept && manageraccept.toLowerCase() === 'accepted'
    ? nowUtc
    : null;


      const hasWarehouseNoColumn = await hasQuotationWarehouseNoColumn(client);
      const insertColumns = [
        'client_id',
        'username',
        'manager_id',
        ...(hasWarehouseNoColumn ? ['warehouse_no'] : []),
        'medad_salesman_id',
        'delivery_date',
        'delivery_type',
        'notes',
        'manager_notes',
        'status',
        'total_price',
        'total_vat',
        'total_subtotal',
        'custom_id',
        'condition',
        'quotation_number',
        'manageraccept',
        'manageraccept_at',
      ];
      const insertParams = [
        client_id,
        username,
        manager_id || null,
        ...(hasWarehouseNoColumn ? [resolvedWarehouseNo] : []),
        resolvedMedadSalesmanId,
        formattedDate,
        delivery_type,
        notes || null,
        manager_notes || null,
        status,
        0,
        0,
        0,
        customId,
        condition,
        newQuotationNumber,
        manageraccept,
        manageraccept_at,
      ];
      const insertPlaceholders = insertParams.map((_, i) => `$${i + 1}`).join(', ');
      const insertQuery = `
        INSERT INTO quotations (${insertColumns.join(', ')})
        VALUES (${insertPlaceholders}) RETURNING id`;
    const quotationResult = await client.query(insertQuery, insertParams);
    const quotationId = quotationResult.rows[0].id;

    let totalPrice = 0, totalVat = 0, totalSubtotal = 0;
    
    // Insert products
    for (const product of products) {
      const { description, quantity, price } = product;
      
      // Double-check required fields (redundant but safe)
      if (!description || !quantity || !price) {
        throw new Error(`Missing product details for product: ${description || 'unnamed'}`);
      }
      
      const numericPrice = parseFloat(price);
      const numericQuantity = parseInt(quantity);
      
      if (isNaN(numericPrice) || numericPrice <= 0) { 
        throw new Error(`Invalid price format for product: ${description}`); 
      }
      
      if (isNaN(numericQuantity) || numericQuantity <= 0) { 
        throw new Error(`Invalid quantity for product: ${description}`); 
      }
      
      const vat = numericPrice * 0.15;
      const subtotal = numericPrice + vat;
      
      totalPrice += numericPrice * numericQuantity;
      totalVat += vat * numericQuantity;
      totalSubtotal += subtotal * numericQuantity;
      
      await client.query(
        `INSERT INTO quotation_products (quotation_id, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quotationId, description, numericQuantity, numericPrice, vat, subtotal]
      );
    }

    // Update the quotation totals
    await client.query(
      `UPDATE quotations SET total_price = $1, total_vat = $2, total_subtotal = $3 WHERE id = $4`,
      [totalPrice, totalVat, totalSubtotal, quotationId]
    );

    await client.query('COMMIT');
    
    // Send notifications
    //await sendNotificationToSupervisor(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');
    await sendNotificationToSupervisor(`تم إنشاء عرض سعر جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار عرض سعر جديد');

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


router.get('/quotations', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = `%${req.query.query || ''}%`;
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    const hasStatus = status !== 'all';
    const countParams = hasStatus ? [query, status] : [query];
    const countCondition = hasStatus
      ? `(quotations.status = $2 OR quotations.manageraccept = $2)`
      : 'TRUE';

    // COUNT query
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND ${countCondition}
    `;

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Build pagination query
    const baseParams = hasStatus
      ? [limit, offset, query, status]
      : [limit, offset, query];

    const filterCondition = hasStatus
      ? `(quotations.status = $4 OR quotations.manageraccept = $4)`
      : 'TRUE';

    const baseQuery = `
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
        clients.username AS client_added_by
      FROM quotations
      JOIN clients ON quotations.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${filterCondition}
      ORDER BY quotations.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const quotationsResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = quotationsResult.rows;

    return res.status(200).json({
      orders,
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
