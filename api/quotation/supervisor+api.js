import express from 'express';
import moment from 'moment-timezone';
import admin from '../../firebase-init.js';
import pkg from 'pg';
import { resolveUserDefaults } from '../../utils/resolveUserDefaults.js';
const { Pool } = pkg;


const router = express.Router();

// PostgreSQL connection pool
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
    ssl: false, // 👈 Disables SSL
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
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

const hasQuotationColumn = async (client, columnName) => {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = 'quotations' AND column_name = $1
     LIMIT 1`,
    [columnName]
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



router.post('/quotations/supervisor', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      client_id, 
      username, 
      supervisor_id, 
      delivery_date, 
      delivery_type, 
      products,  
      notes, 
      condition = 'نقدي - كاش', 
      status = 'not Delivered',
      supervisoraccept='accepted',
      warehouse_no,
      medad_salesman_id,
      clerkId,
      clerk_id
    } = req.body;

    // Validate required fields
    if (!client_id || !username || !supervisor_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      throw new Error('Missing required fields');
    }


const nowUtc = moment().tz('UTC').format('YYYY-MM-DD HH:mm:ss');
const supervisoraccept_at =
  supervisoraccept && supervisoraccept.toLowerCase() === 'accepted'
    ? nowUtc
    : null;

 
    // Format delivery date
    const formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
    const customId = await generateCustomId(client); // Generate custom_id without RevX

    const resolvedDefaults = await resolveUserDefaults({
      client,
      role: 'supervisor',
      clerkId: clerkId || clerk_id || null,
      username
    });
    const resolvedWarehouseNo = warehouse_no || resolvedDefaults.warehouse_no || null;
    const resolvedMedadSalesmanId = medad_salesman_id || resolvedDefaults.medad_salesman_id || null;

    const hasWarehouseNoColumn = await hasQuotationColumn(client, 'warehouse_no');
    const hasMedadSalesmanIdColumn = await hasQuotationColumn(client, 'medad_salesman_id');
    const insertColumns = [
      'client_id',
      'username',
      'supervisor_id',
      ...(hasWarehouseNoColumn ? ['warehouse_no'] : []),
      ...(hasMedadSalesmanIdColumn ? ['medad_salesman_id'] : []),
      'delivery_date',
      'delivery_type',
      'notes',
      'status',
      'total_price',
      'total_vat',
      'total_subtotal',
      'custom_id',
      'condition',
      'supervisoraccept',
      'supervisoraccept_at',
    ];
    const insertParams = [
      client_id,
      username,
      supervisor_id,
      ...(hasWarehouseNoColumn ? [resolvedWarehouseNo] : []),
      ...(hasMedadSalesmanIdColumn ? [resolvedMedadSalesmanId] : []),
      formattedDate,
      delivery_type,
      notes || null,
      status,
      0,
      0,
      0,
      customId,
      condition,
      supervisoraccept,
      supervisoraccept_at,
    ];
    const insertPlaceholders = insertParams.map((_, i) => `$${i + 1}`).join(', ');
    const insertQuery = `
      INSERT INTO quotations (${insertColumns.join(', ')})
      VALUES (${insertPlaceholders}) RETURNING id
    `;
    const quotationResult = await client.query(insertQuery, insertParams);
    const quotationId = quotationResult.rows[0].id;

    let totalPrice = 0, totalVat = 0, totalSubtotal = 0;
    
    // Insert products
    for (const product of products) {
      const {description, quantity, price } = product;
      
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
        [quotationId,description, numericQuantity, numericPrice, vat, subtotal]
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



/*
router.post('/quotations/supervisor', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      client_id, 
      username, 
      delivery_date, 
      delivery_type, 
      products,  
      notes, 
      condition = 'نقدي - كاش', 
      status = 'not Delivered' 
    } = req.body;

    // Validate required fields (no supervisor_id)
    if (!client_id || !username || !delivery_date || !delivery_type || !products || products.length === 0) {
      throw new Error('Missing required fields');
    }

    const formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');
    const customId = await generateCustomId(client);

    // INSERT without supervisor_id
    const insertQuery = `
      INSERT INTO quotations (client_id, username, delivery_date, delivery_type, notes, status, total_price, total_vat, total_subtotal, custom_id, condition)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `;
    const insertParams = [client_id, username, formattedDate, delivery_type, notes || null, status, 0, 0, 0, customId, condition];
    const quotationResult = await client.query(insertQuery, insertParams);
    const quotationId = quotationResult.rows[0].id;

    let totalPrice = 0, totalVat = 0, totalSubtotal = 0;

    for (const product of products) {
      const { description, quantity, price } = product;
      if (!description || !quantity || !price) {
        throw new Error(`Missing product details for product: ${description || 'unnamed'}`);
      }

      const numericPrice = parseFloat(price);
      const numericQuantity = parseInt(quantity);
      if (isNaN(numericPrice) || numericPrice <= 0) throw new Error(`Invalid price format for product: ${description}`);
      if (isNaN(numericQuantity) || numericQuantity <= 0) throw new Error(`Invalid quantity for product: ${description}`);

      const vat = numericPrice * 0.15;
      const subtotal = numericPrice + vat;

      totalPrice    += numericPrice * numericQuantity;
      totalVat      += vat * numericQuantity;
      totalSubtotal += subtotal * numericQuantity;

      await client.query(
        `INSERT INTO quotation_products (quotation_id, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quotationId, description, numericQuantity, numericPrice, vat, subtotal]
      );
    }

    await client.query(
      `UPDATE quotations SET total_price = $1, total_vat = $2, total_subtotal = $3 WHERE id = $4`,
      [totalPrice, totalVat, totalSubtotal, quotationId]
    );

    await client.query('COMMIT');

    // Notifications (already to manager only)
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
    return res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

*/

router.get('/supervisor', async (req, res) => {
    const client = await pool.connect();
    try {
      const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const query = `%${req.query.query || ''}%`;
      const status = req.query.status || 'all';
      const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
      const offset = (page - 1) * limit;
  
      const hasStatus = status !== 'all';
      const whereParts = [];
      const params = [];
      let idx = 1;
      params.push(query);
      whereParts.push(`(clients.client_name ILIKE $${idx} OR clients.company_name ILIKE $${idx})`);
      idx += 1;
      if (hasStatus) {
        params.push(status);
        whereParts.push(`(quotations.status = $${idx} OR quotations.supervisoraccept = $${idx})`);
        idx += 1;
      }
      if (username) {
        params.push(username);
        whereParts.push(`(LOWER(TRIM(quotations.username)) = LOWER(TRIM($${idx})) OR LOWER(TRIM(clients.username)) = LOWER(TRIM($${idx})))`);
        idx += 1;
      }
      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
  
      // COUNT query
      const countQuery = `
        SELECT COUNT(*) AS count
        FROM quotations
        JOIN clients ON quotations.client_id = clients.id
        ${whereClause}
      `;
  
      const countResult = await executeWithRetry(() =>
        client.query(countQuery, params)
      );
      const totalCount = parseInt(countResult.rows[0].count, 10);
  
      // Build pagination query
      const dataParams = [...params, limit, offset];
      const limitIndex = params.length + 1;
      const offsetIndex = params.length + 2;
  
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
        ${whereClause}
        ORDER BY quotations.created_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}
      `;
  
      const quotationsResult = await executeWithRetry(() =>
        client.query(baseQuery, dataParams)
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
