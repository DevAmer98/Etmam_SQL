import express from 'express';
import moment from 'moment-timezone';
import pkg from 'pg';
const { Pool } = pkg;

const router = express.Router();

// Create a connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000, // Increased timeout
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

// Function to generate custom ID
const generateCustomId = async (client) => {
  const year = new Date().getFullYear();
  
  // Get all custom IDs for the current year and extract numeric parts
  const result = await client.query(
    `SELECT custom_id 
     FROM orders 
     WHERE custom_id LIKE $1
     ORDER BY custom_id DESC`,
    [`NPO-${year}-%`]
  );
  
  let maxId = 0;
  
  // Parse each custom_id to find the highest numeric ID
  for (const row of result.rows) {
    const customId = row.custom_id;
    // Extract the part after "NPO-YYYY-"
    const idPart = customId.substring(`NPO-${year}-`.length);
    
    // Extract only the numeric part (ignore any non-numeric suffixes like "Rev1")
    const numericMatch = idPart.match(/^(\d+)/);
    if (numericMatch) {
      const numericId = parseInt(numericMatch[1], 10);
      if (numericId > maxId) {
        maxId = numericId;
      }
    }
  }
  
  const newId = `NPO-${year}-${String(maxId + 1).padStart(5, '0')}`;
  return newId;
};
// POST endpoint to create an order
router.post('/orders', async (req, res) => {
  let client;

  
  
  try {
    // Validate request body first
    const { client_id, username, delivery_date, delivery_type, products, notes, status = 'not Delivered' } = req.body;

    // Input validation
    if (!client_id || !delivery_date || !delivery_type || !products || products.length === 0) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: {
          client_id: !client_id ? 'Required' : 'Valid',
          delivery_date: !delivery_date ? 'Required' : 'Valid',
          delivery_type: !delivery_type ? 'Required' : 'Valid',
          products: !products || products.length === 0 ? 'Required and must not be empty' : 'Valid'
        }
      });
    }

    // Validate products
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      if (!product.section || !product.type || !product.quantity || !product.price) {
        return res.status(400).json({ 
          error: `Product ${i + 1} is missing required fields`,
          details: {
            section: product.section ? 'Valid' : 'Required',
            type: product.type ? 'Valid' : 'Required',
            quantity: product.quantity ? 'Valid' : 'Required',
            price: product.price ? 'Valid' : 'Required'
          }
        });
      }
      
      // Validate numeric fields
      if (isNaN(parseFloat(product.quantity)) || isNaN(parseFloat(product.price))) {
        return res.status(400).json({ 
          error: `Product ${i + 1} has invalid numeric values`,
          details: {
            quantity: isNaN(parseFloat(product.quantity)) ? 'Must be a valid number' : 'Valid',
            price: isNaN(parseFloat(product.price)) ? 'Must be a valid number' : 'Valid'
          }
        });
      }
    }
    await executeWithRetry(async () => {
      client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Format date
        let formattedDate;
try {
  console.log('Received delivery_date:', delivery_date, typeof delivery_date);
  
  let parsedDate;
  
  // Handle different input formats
  if (!delivery_date) {
    throw new Error('Delivery date is required');
  }
  
  if (typeof delivery_date === 'string') {
    // Case 1: ISO string (2024-05-26T14:30:00.000Z)
    if (delivery_date.includes('T') && delivery_date.includes('Z')) {
      parsedDate = moment(delivery_date);
    }
    // Case 2: Custom format (2024-05-26 14:30)
    else if (delivery_date.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)) {
      parsedDate = moment(`${delivery_date}:00`, 'YYYY-MM-DD HH:mm:ss');
    }
    // Case 3: Date only (2024-05-26)
    else if (delivery_date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      parsedDate = moment(delivery_date, 'YYYY-MM-DD');
    }
    // Case 4: Try to parse as-is
    else {
      parsedDate = moment(delivery_date);
    }
  } 
  // Handle Date objects or timestamps
  else {
    parsedDate = moment(delivery_date);
  }
  
  console.log('Parsed date object:', parsedDate);
  console.log('Is valid:', parsedDate.isValid());
  
  if (!parsedDate.isValid()) {
    throw new Error(`Unable to parse date: ${delivery_date}`);
  }
  
  // Convert to UTC and format for database
  formattedDate = parsedDate.utc().format('YYYY-MM-DD HH:mm:ss');
  console.log('Formatted date for database:', formattedDate);
  
} catch (dateError) {
  console.error('Date parsing error:', {
    error: dateError.message,
    receivedDate: delivery_date,
    dateType: typeof delivery_date
  });
  throw new Error(`Invalid delivery date format: ${dateError.message}`);
}

        // Generate custom ID
        const customId = await generateCustomId(client);

        // Insert order
        const orderResult = await withTimeout(
          client.query(
            `INSERT INTO orders (client_id, username, delivery_date, delivery_type, notes, status, custom_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [client_id, username, formattedDate, delivery_type, notes || null, status, customId]
          ),
          10000
        );

        if (!orderResult.rows || orderResult.rows.length === 0) {
          throw new Error('Failed to create order - no ID returned');
        }

        const orderId = orderResult.rows[0].id;
        let totalPrice = 0;

        // Insert products
        for (const product of products) {
          const quantity = parseFloat(product.quantity);
          const price = parseFloat(product.price);
          const productTotal = quantity * price;
          totalPrice += productTotal;

          await withTimeout(
            client.query(
              `INSERT INTO order_products (order_id, section, type, description, quantity, price)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [orderId, product.section, product.type, product.description || '', quantity, price]
            ),
            5000
          );
        }

        // Update total price
        await withTimeout(
          client.query(`UPDATE orders SET total_price = $1 WHERE id = $2`, [totalPrice, orderId]),
          5000
        );

        await client.query('COMMIT');

        // Send notifications (don't let this fail the whole operation)
        try {
          await sendNotificationToManager(`تم إنشاء طلب جديد بالمعرف ${customId} وينتظر موافقتك.`, 'إشعار طلب جديد');
        } catch (notificationError) {
          console.error('Notification failed but order was created successfully:', notificationError);
        }

        return res.status(201).json({ 
          orderId, 
          customId, 
          status: 'success', 
          totalPrice,
          message: 'Order created successfully'
        });

      } catch (transactionError) {
        console.error('Transaction error:', transactionError);
        await client.query('ROLLBACK');
        throw transactionError;
      }
    });
 } catch (error) {
    console.error('Error creating order:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Error creating order';
    let statusCode = 500;
    
    if (error.message.includes('Invalid delivery date')) {
      errorMessage = 'Invalid delivery date format';
      statusCode = 400;
    } else if (error.message.includes('Failed to generate order ID')) {
      errorMessage = 'Failed to generate order ID';
      statusCode = 500;
    } else if (error.message.includes('timeout')) {
      errorMessage = 'Database operation timed out';
      statusCode = 503;
    } else if (error.message.includes('Missing required fields')) {
      errorMessage = error.message;
      statusCode = 400;
    }

    return res.status(statusCode).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


router.get('/orders', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const query = `%${req.query.query || ''}%`;
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    const hasStatus = status !== 'all';

    // Build filters
    let filterCondition = 'TRUE';
    if (hasStatus) {
      filterCondition = `(orders.status = $2 OR orders.manageraccept = $2)`;
    }

    // COUNT query
    const countParams = hasStatus ? [query, status] : [query];
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND ${filterCondition}
    `;

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Paginated query
    const baseParams = hasStatus
      ? [limit, offset, query, status]
      : [limit, offset, query];

    const statusIndex = hasStatus ? 4 : null;

    const paginatedFilterCondition = hasStatus
      ? `(orders.status = $4 OR orders.manageraccept = $4)`
      : 'TRUE';

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
        clients.region AS client_region
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${paginatedFilterCondition}
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const ordersResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = ordersResult.rows;

    res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit), 
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


router.get('/orders/supervisor', async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const query = `%${req.query.query || ''}%`;
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    const hasStatus = status !== 'all';

    // Build filters
    let filterCondition = 'TRUE';
    if (hasStatus) {
      filterCondition = `(orders.status = $2 OR orders.supervisoraccept = $2)`;
    }
 
    // COUNT query
    const countParams = hasStatus ? [query, status] : [query];
    const countQuery = `
      SELECT COUNT(*) AS count
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $1 OR clients.company_name ILIKE $1)
      AND ${filterCondition}
    `;

    const countResult = await executeWithRetry(() =>
      client.query(countQuery, countParams)
    );
    const totalCount = parseInt(countResult.rows[0].count, 10);

    // Paginated query
    const baseParams = hasStatus
      ? [limit, offset, query, status]
      : [limit, offset, query];

    const statusIndex = hasStatus ? 4 : null;

    const paginatedFilterCondition = hasStatus
      ? `(orders.status = $4 OR orders.supervisoraccept = $4)`
      : 'TRUE';

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
        clients.region AS client_region
      FROM orders
      JOIN clients ON orders.client_id = clients.id
      WHERE (clients.client_name ILIKE $3 OR clients.company_name ILIKE $3)
      AND ${paginatedFilterCondition}
      ORDER BY orders.created_at DESC
      LIMIT $1 OFFSET $2
    `;

    const ordersResult = await executeWithRetry(() =>
      client.query(baseQuery, baseParams)
    );

    const orders = ordersResult.rows;

    res.status(200).json({
      orders,
      totalCount,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
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