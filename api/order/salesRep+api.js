import express from 'express';
import moment from 'moment-timezone'; // Ensure moment-timezone is installed
import admin from '../../firebase-init.js';
import pkg from 'pg'; // New
const { Pool } = pkg; // Destructure Pool

const router = express.Router();

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

// Function to generate custom ID
// Alternative function using SQL regex - FIXED VERSION
const generateCustomId = async (client) => {
  const year = new Date().getFullYear();
  
  // Use PostgreSQL regex to extract only numeric part
  const result = await client.query(
    `SELECT MAX(
       CASE 
         WHEN SUBSTRING(custom_id FROM 'NPO-${year}-(\\d+)') ~ '^\\d+$' 
         THEN SUBSTRING(custom_id FROM 'NPO-${year}-(\\d+)')::int
         ELSE 0
       END
     ) AS last_id 
     FROM orders 
     WHERE custom_id ~ $1`,
    [`^NPO-${year}-\\d+`]
  );
  
  const lastId = result.rows[0].last_id || 0;
  const newId = `NPO-${year}-${String(lastId + 1).padStart(5, '0')}`;
  return newId;
};



// Function to send notifications to supervisors
async function sendNotificationToManager(message, title = 'Notification') {
  const client = await pool.connect();
  try {
    // Fetch FCM tokens for supervisors
    const query = 'SELECT fcm_token FROM Managers WHERE role = $1 AND active = TRUE';
    const result = await client.query(query, ['manager']);
    const tokens = result.rows.map((row) => row.fcm_token).filter((token) => token != null);

    console.log(`Sending notifications to manager:`, tokens);

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
/*
// POST endpoint to create an order - FIXED VERSION
router.post('/orders/salesRep', async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;
   
  try {
    const { client_id, username, delivery_date, delivery_type, products, notes, deliveryLocations = [],total_vat, total_subtotal, status = 'not Delivered' } = req.body;
 
    // Validate required fields first
    if (!client_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');

    // Start transaction
    await client.query('BEGIN');
    transactionStarted = true;

    // Generate custom ID
    const customId = await generateCustomId(client);

    const orderResult = await withTimeout(
      client.query(
        `INSERT INTO orders (client_id, username, delivery_date, delivery_type, notes, status, total_vat, total_subtotal, custom_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [client_id, username, formattedDate, delivery_type, notes || null, status,total_vat, total_subtotal, customId]
        
      ),
      10000 // 10-second timeout
      
    );
    const orderId = orderResult.rows[0].id;
    console.log('Inserted order ID:', orderResult.rows[0].id);


    let totalPrice = 0;
    for (const product of products) {
      totalPrice += parseFloat(product.price) * parseFloat(product.quantity || 1);
      await client.query(
        `INSERT INTO order_products (order_id, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, product.description, product.quantity,parseFloat(product.price),parseFloat(product.vat),parseFloat(product.subtotal)]
      );
    }


    for (const location of deliveryLocations) {
  if (location.name && location.url) {
    await client.query(
      `INSERT INTO order_locations (order_id, name, url)
       VALUES ($1, $2, $3)`,
      [orderId, location.name, location.url]
    );
  }
}


    await client.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]);
    
    // Commit transaction
    await client.query('COMMIT');
    transactionStarted = false;

    // Send notifications to supervisors (outside of transaction)
    try {
     await Promise.all([
  sendNotificationToSupervisor(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد'),
  sendNotificationToManager(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد'),
]);

    } catch (notificationError) {
      console.error('Failed to send notification, but order was created successfully:', notificationError);
      // Don't fail the request if notification fails
    }

    return res.status(201).json({ orderId, customId, status: 'success', totalPrice });

  } catch (error) {
    console.error('Error creating order:', error);
    
    // Only attempt rollback if transaction was started and client is still valid
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }
    
    return res.status(500).json({ error: error.message || 'Error creating order' });
  } finally {
    client.release();
  }
});
*/


// POST endpoint to create an order - FIXED VERSION with client_type/tax_number validation
router.post('/orders/salesRep', async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { 
      client_id, 
      username, 
      delivery_date, 
      delivery_type, 
      products, 
      notes, 
      deliveryLocations = [],
      total_vat, 
      total_subtotal, 
      status = 'not Delivered' 
    } = req.body;

    // Validate required fields first
    if (!client_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ✅ Check client_type & tax_number (same rule you added to the other endpoint)
    const clientCheckResult = await client.query(
      'SELECT client_type, tax_number FROM clients WHERE id = $1',
      [client_id]
    );
    if (clientCheckResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const { client_type, tax_number } = clientCheckResult.rows[0];
    if (client_type !== 'One-time cash client' && !tax_number) {
      return res.status(400).json({
        error: 'يرجى إضافة رقم ضريبي لهذا العميل قبل إنشاء الطلب.',
        message: 'يرجى إضافة رقم ضريبي لهذا العميل قبل إنشاء الطلب.'
      });
    }

    // Format date (light validation)
    let formattedDate = moment(delivery_date).tz('UTC').format('YYYY-MM-DD HH:mm:ss');

    // Start transaction
    await client.query('BEGIN');
    transactionStarted = true;

    // Generate custom ID
    const customId = await generateCustomId(client);

    const orderResult = await withTimeout(
      client.query(
        `INSERT INTO orders (client_id, username, delivery_date, delivery_type, notes, status, total_vat, total_subtotal, custom_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [client_id, username, formattedDate, delivery_type, notes || null, status, total_vat, total_subtotal, customId]
      ),
      10000 // 10-second timeout
    );

    const orderId = orderResult.rows[0].id;
    console.log('Inserted order ID:', orderId);

    // Insert products
    let totalPrice = 0;
    for (const product of products) {
      totalPrice += parseFloat(product.price) * parseFloat(product.quantity || 1);
      await client.query(
        `INSERT INTO order_products (order_id, description, quantity, price, vat, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          product.description,
          product.quantity,
          parseFloat(product.price),
          parseFloat(product.vat),
          parseFloat(product.subtotal)
        ]
      );
    }

    // Insert delivery locations
    for (const location of deliveryLocations) {
      if (location.name && location.url) {
        await client.query(
          `INSERT INTO order_locations (order_id, name, url)
           VALUES ($1, $2, $3)`,
          [orderId, location.name, location.url]
        );
      }
    }

    // Update total price
    await client.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]);

    // Commit transaction
    await client.query('COMMIT');
    transactionStarted = false;

    // Send notifications to supervisors/managers (outside of transaction)
    try {
      await Promise.all([
        sendNotificationToSupervisor(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد'),
        sendNotificationToManager(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد'),
      ]);
    } catch (notificationError) {
      console.error('Failed to send notification, but order was created successfully:', notificationError);
      // Do not fail the request if notification fails
    }

    return res.status(201).json({ orderId, customId, status: 'success', totalPrice });

  } catch (error) {
    console.error('Error creating order:', error);

    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error during rollback:', rollbackError);
      }
    }

    // If earlier we returned 400/404, we would not be here. Default to 500.
    return res.status(500).json({ error: error.message || 'Error creating order' });
  } finally {
    client.release();
  }
});


 router.get('/orders/salesRep', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const query = req.query.query || '';
    const username = req.query.username || '';
    const filter = req.query.filter || 'all';
    const offset = (page - 1) * limit;

    // Base query
    let baseQuery = `
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
        clients.username AS client_added_by,
        orders.status,
        orders.storekeeperaccept,
        orders.actual_delivery_date,
        orders.total_price, 
        orders.total_vat, 
        orders.order_number,
        orders.total_subtotal 
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE clients.username = $4 
        AND (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
    `;

    // Count query
    let countQuery = `
      SELECT COUNT(*) AS total
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE clients.username = $2 
        AND (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
    `;

    // Apply filters
    if (filter === 'accepted') {
      baseQuery += ` AND orders.manageraccept = 'accepted' AND orders.supervisoraccept = 'accepted'`;
      countQuery += ` AND orders.manageraccept = 'accepted' AND orders.supervisoraccept = 'accepted'`;
    } else if (filter === 'pending') {
      baseQuery += ` AND (orders.manageraccept = 'pending' OR orders.supervisoraccept = 'pending')`;
      countQuery += ` AND (orders.manageraccept = 'pending' OR orders.supervisoraccept = 'pending')`;
    }

    // Final ordering and pagination
    baseQuery += ` ORDER BY orders.created_at DESC LIMIT $1 OFFSET $2`;

    const baseQueryParams = [limit, offset, `%${query}%`, username];
    const countQueryParams = [`%${query}%`, username];

    const [ordersResult, countResult] = await executeWithRetry(async () => {
      return await Promise.all([
        withTimeout(client.query(baseQuery, baseQueryParams), 10000),
        withTimeout(client.query(countQuery, countQueryParams), 10000),
      ]);
    });

    const orders = ordersResult.rows;
    const totalCount = parseInt(countResult.rows[0]?.total || 0, 10);
    const hasMore = page * limit < totalCount;

    // Attach delivery locations
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
        if (!locationMap[loc.order_id]) {
          locationMap[loc.order_id] = [];
        }
        locationMap[loc.order_id].push({ name: loc.name, url: loc.url });
      });
    }

    orders.forEach(order => {
      order.deliveryLocations = locationMap[order.id] || [];
    });

    return res.status(200).json({
      orders,
      hasMore,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
    });
  } catch (error) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({
      error: error.message || 'Error fetching orders',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    client.release();
  }
});


export default router;
 