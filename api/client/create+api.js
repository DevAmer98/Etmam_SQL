import express from 'express';
import { Pool } from 'pg';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createMedadCustomer } from '../../utils/medad.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const router = express.Router();

// Util functions...
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

// POST /api/clients
router.post('/clients', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_name, username, client_name, client_type,
      phone_number, tax_number, branch_number, location
    } = req.body;

    if (
      !company_name || !client_name || !client_type ||
      !phone_number || !branch_number ||
      !location || !location.latitude || !location.longitude
    ) {
      res.status(400);
      throw new Error('Missing required fields');
    }



    const checkQuery = `SELECT 1 FROM clients WHERE company_name = $1 LIMIT 1;`;
    const existingClient = await client.query(checkQuery, [company_name]);

    if (existingClient.rows.length > 0) {
      res.status(409);
      throw new Error('العميل موجود بالفعل بنفس رقم الهاتف أو الاسم في الشركة');
    }

    let medadResult;
    try {
      medadResult = await createMedadCustomer({
        accountType: '0',
        companyName: company_name,
        contactName: client_name,
        phoneNumber: phone_number,
        vatNo: tax_number,
        branchName: branch_number,
        address1: location.street || null,
        address2: location.region || null,
        city: location.city || null,
        region: location.region || null,
        warehouseNo: process.env.MEDAD_BRANCH || null,
      });
    } catch (medadError) {
      return res.status(502).json({
        error: 'Failed to sync client to Medad',
        details: medadError?.message || String(medadError),
      });
    }

    const insertQuery = `
      INSERT INTO clients (
        company_name, username, client_name, client_type, phone_number,
        tax_number, branch_number, latitude, longitude, street, city, region
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *;
    `;
    const values = [
      company_name, username, client_name, client_type, phone_number,
      tax_number || null, branch_number, location.latitude, location.longitude,
      location.street || null, location.city || null, location.region || null
    ];

    const response = await executeWithRetry(() =>
      withTimeout(client.query(insertQuery, values), 10000)
    );

    const createdClient = response.rows[0];

    // Keep local ↔ Medad mapping aligned automatically for future invoice sync.
    if (medadResult.medadCustomerId && tax_number) {
      const linkQuery = `
        INSERT INTO client_medad_customers (
          client_id, medad_customer_id, vat_no, branch_name, phone, address1, address2, city, region, is_default
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE
        WHERE NOT EXISTS (
          SELECT 1
          FROM client_medad_customers
          WHERE CAST(client_id AS TEXT) = CAST($1 AS TEXT)
            AND CAST(medad_customer_id AS TEXT) = CAST($2 AS TEXT)
        )
      `;
      const linkValues = [
        createdClient.id,
        medadResult.medadCustomerId,
        tax_number,
        branch_number || null,
        phone_number || null,
        location.street || null,
        location.region || null,
        location.city || null,
        location.region || null,
      ];

      try {
        await executeWithRetry(() => withTimeout(client.query(linkQuery, linkValues), 10000));
      } catch (linkError) {
        console.warn('Client created and synced to Medad, but local Medad link insert failed:', linkError?.message || linkError);
      }
    }

    res.status(201).json({
      data: createdClient,
      medad: {
        synced: true,
        customerId: medadResult.medadCustomerId || null,
      },
    });
  } finally {
    client.release();
  }
}));

// GET /api/clients
router.get('/clients', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const searchQuery = `%${req.query.search || ''}%`;
    const username = req.query.username || '';
    const offset = (page - 1) * limit;

    const clientsQuery = `
      SELECT * FROM clients
      WHERE username = $1 AND (
        client_name ILIKE $2 OR company_name ILIKE $2
      )
      ORDER BY client_name LIMIT $3 OFFSET $4;
    `;
    const clients = await executeWithRetry(() =>
      withTimeout(client.query(clientsQuery, [username, searchQuery, limit, offset]), 10000)
    );

    const countQuery = `
      SELECT COUNT(*) AS count FROM clients
      WHERE username = $1 AND (
        client_name ILIKE $2 OR company_name ILIKE $2
      );
    `;
    const totalClients = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, [username, searchQuery]), 10000)
    );

    const total = parseInt(totalClients.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      clients: clients.rows,
      total,
      page,
      totalPages,
      limit,
    });
  } finally {
    client.release();
  }
}));


// GET /api/myClients
router.get('/myClients', asyncHandler(async (req, res) => {
  const client = await pool.connect();
  try {
    const limit = parseInt(req.query.limit || '10', 10);
    const page = parseInt(req.query.page || '1', 10);
    const searchQuery = `%${req.query.search || ''}%`;
    const username = req.query.username; // must be passed
    const offset = (page - 1) * limit;

    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const clientsQuery = `
      SELECT * FROM clients
      WHERE username = $1
        AND (client_name ILIKE $2 OR company_name ILIKE $2)
      ORDER BY client_name
      LIMIT $3 OFFSET $4;
    `;
    const clients = await executeWithRetry(() =>
      withTimeout(client.query(clientsQuery, [username, searchQuery, limit, offset]), 10000)
    );

    const countQuery = `
      SELECT COUNT(*) AS count FROM clients
      WHERE username = $1
        AND (client_name ILIKE $2 OR company_name ILIKE $2);
    `;
    const totalClients = await executeWithRetry(() =>
      withTimeout(client.query(countQuery, [username, searchQuery]), 10000)
    );

    const total = parseInt(totalClients.rows[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      clients: clients.rows,
      total,
      page,
      totalPages,
      limit,
    });
  } finally {
    client.release();
  }
}));


export default router;
