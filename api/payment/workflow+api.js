import express from 'express';
import { Pool } from 'pg';

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
  if (!token) throw new Error('Medad token not found in response');

  const expiresIn = Number(data.expiresIn || data.expires_in || 3600);
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
};

const withTimeout = (promise, timeout = 10000) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Database query timed out')), timeout)),
  ]);

const ensureTable = async client => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS payment_workflow_requests (
      id SERIAL PRIMARY KEY,
      beneficiary_id TEXT NOT NULL,
      beneficiary_name TEXT NOT NULL,
      beneficiary_type TEXT NOT NULL,
      beneficiary_vat_no TEXT,
      operation_amount NUMERIC NOT NULL,
      due_date DATE,
      description TEXT,
      is_beneficiary_account_added BOOLEAN,
      stage TEXT NOT NULL DEFAULT 'accountant',
      status TEXT NOT NULL DEFAULT 'pending_accountant',
      accountant_due_amount NUMERIC,
      accountant_note TEXT,
      accountant_name TEXT,
      accountant_id TEXT,
      accountant_updated_at TIMESTAMPTZ,
      statement TEXT,
      priority TEXT,
      manager_approved BOOLEAN,
      manager_name TEXT,
      manager_id TEXT,
      manager_updated_at TIMESTAMPTZ,
      medad_payload JSONB,
      medad_response JSONB,
      medad_sync_status TEXT DEFAULT 'not_sent',
      created_by TEXT,
      created_by_clerk_id TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await withTimeout(client.query(createSql));
  const alterStatements = [
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS manager_pay_amount NUMERIC",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS payment_state TEXT",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS beneficiary_vat_no TEXT",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS statement TEXT",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS priority TEXT",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS medad_synced_at TIMESTAMPTZ",
    "ALTER TABLE payment_workflow_requests ADD COLUMN IF NOT EXISTS medad_error TEXT",
  ];
  for (const sql of alterStatements) {
    await withTimeout(client.query(sql));
  }
};

router.post('/payments/workflow', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const {
      beneficiaryId,
      beneficiaryName,
      beneficiaryType,
      beneficiaryVatNo = null,
      amount,
      dueDate,
      description = null,
      isBeneficiaryAccountAdded = null,
      createdBy = null,
      createdByClerkId = null,
    } = req.body || {};

    const numericAmount = Number(amount);
    if (!beneficiaryId || !beneficiaryName || !beneficiaryType || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'beneficiaryId, beneficiaryName, beneficiaryType, and valid amount are required' });
    }

    const insertSql = `
      INSERT INTO payment_workflow_requests
      (
        beneficiary_id, beneficiary_name, beneficiary_type, beneficiary_vat_no, operation_amount, due_date, description,
        is_beneficiary_account_added, stage, status, created_by, created_by_clerk_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'accountant','pending_accountant',$9,$10)
      RETURNING *
    `;

    const params = [
      String(beneficiaryId),
      String(beneficiaryName),
      String(beneficiaryType),
      isBeneficiaryAccountAdded ? (beneficiaryVatNo ? String(beneficiaryVatNo) : null) : null,
      numericAmount,
      dueDate || null,
      description,
      isBeneficiaryAccountAdded === null ? null : Boolean(isBeneficiaryAccountAdded),
      createdBy,
      createdByClerkId,
    ];

    const result = await withTimeout(client.query(insertSql, params));
    return res.status(201).json({
      success: true,
      message: 'Payment request sent to accountant stage',
      request: result.rows[0],
    });
  } catch (error) {
    console.error('Create payment workflow request failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to create payment request' });
  } finally {
    client.release();
  }
});

router.get('/payments/workflow/accountant', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const status = (req.query.status || 'pending').toString().toLowerCase();
    const accountantId = (req.query.accountantId || '').toString().trim();

    let whereSql = `WHERE stage = 'accountant' AND status = 'pending_accountant'`;
    const params = [];

    if (status === 'sent') {
      whereSql = `WHERE stage = 'manager' AND status = 'pending_manager'`;
      if (accountantId) {
        params.push(accountantId);
        whereSql += ` AND accountant_id = $${params.length}`;
      }
    } else if (status === 'all') {
      whereSql = `WHERE (stage = 'accountant' OR stage = 'manager')`;
      if (accountantId) {
        params.push(accountantId);
        whereSql += ` AND (accountant_id = $${params.length} OR accountant_id IS NULL)`;
      }
    }

    const query = `
      SELECT *
      FROM payment_workflow_requests
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT 300
    `;
    const result = await withTimeout(client.query(query, params));
    return res.status(200).json({ success: true, requests: result.rows });
  } catch (error) {
    console.error('Fetch accountant payment requests failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch payment requests' });
  } finally {
    client.release();
  }
});

router.get('/payments/workflow/operation', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const createdByClerkId = (req.query.createdByClerkId || '').toString().trim();
    const createdBy = (req.query.createdBy || '').toString().trim();
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);

    if (!createdByClerkId && !createdBy) {
      return res.status(400).json({ error: 'createdByClerkId or createdBy is required' });
    }

    const whereParts = [];
    const params = [];
    if (createdByClerkId) {
      params.push(createdByClerkId);
      whereParts.push(`created_by_clerk_id = $${params.length}`);
    }
    if (createdBy) {
      params.push(createdBy);
      whereParts.push(`created_by = $${params.length}`);
    }
    params.push(limit);

    const query = `
      SELECT *
      FROM payment_workflow_requests
      WHERE ${whereParts.join(' OR ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;
    const result = await withTimeout(client.query(query, params));
    return res.status(200).json({ success: true, requests: result.rows });
  } catch (error) {
    console.error('Fetch operation payment requests failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch payment requests' });
  } finally {
    client.release();
  }
});

router.get('/payments/workflow/manager', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const status = (req.query.status || 'pending').toString().toLowerCase();
    const managerId = (req.query.managerId || '').toString().trim();

    let whereSql = `WHERE stage = 'manager' AND status = 'pending_manager'`;
    const params = [];

    if (status === 'sent') {
      whereSql = `WHERE manager_approved = TRUE`;
      if (managerId) {
        params.push(managerId);
        whereSql += ` AND manager_id = $${params.length}`;
      }
    } else if (status === 'all') {
      whereSql = `WHERE stage = 'manager' OR manager_approved = TRUE`;
      if (managerId) {
        params.push(managerId);
        whereSql += ` AND (manager_id = $${params.length} OR manager_id IS NULL)`;
      }
    }

    const query = `
      SELECT *
      FROM payment_workflow_requests
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT 300
    `;
    const result = await withTimeout(client.query(query, params));
    return res.status(200).json({ success: true, requests: result.rows });
  } catch (error) {
    console.error('Fetch manager payment requests failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch payment requests' });
  } finally {
    client.release();
  }
});

router.patch('/payments/workflow/:id/accountant', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const id = Number(req.params.id);
    const {
      dueAmount,
      accountantNote = null,
      accountantName = null,
      accountantId = null,
    } = req.body || {};

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid request id' });
    }

    const numericDueAmount = Number(dueAmount);
    if (!Number.isFinite(numericDueAmount) || numericDueAmount <= 0) {
      return res.status(400).json({ error: 'Valid dueAmount is required' });
    }

    const updateSql = `
      UPDATE payment_workflow_requests
      SET
        accountant_due_amount = $1,
        accountant_note = $2,
        accountant_name = $3,
        accountant_id = $4,
        accountant_updated_at = CURRENT_TIMESTAMP,
        stage = 'manager',
        status = 'pending_manager',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
        AND stage = 'accountant'
      RETURNING *
    `;
    const result = await withTimeout(
      client.query(updateSql, [numericDueAmount, accountantNote, accountantName, accountantId, id]),
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Payment request not found in accountant stage' });
    }

    return res.status(200).json({
      success: true,
      message: 'Payment request moved to manager stage',
      request: result.rows[0],
    });
  } catch (error) {
    console.error('Accountant update payment request failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to update payment request' });
  } finally {
    client.release();
  }
});

router.patch('/payments/workflow/:id/manager', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const id = Number(req.params.id);
    const {
      amountToPay,
      priority,
      managerName = null,
      managerId = null,
    } = req.body || {};

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid request id' });
    }
    const numericAmountToPay = Number(amountToPay);
    const normalizedPriority = String(priority ?? '').trim();
    if (!Number.isFinite(numericAmountToPay) || numericAmountToPay <= 0) {
      return res.status(400).json({ error: 'Valid amountToPay is required' });
    }
    if (!(normalizedPriority === '1' || normalizedPriority === '2')) {
      return res.status(400).json({ error: 'priority must be 1 or 2' });
    }
    const baseQuery = `
      SELECT accountant_due_amount
      FROM payment_workflow_requests
      WHERE id = $1
      LIMIT 1
    `;
    const baseResult = await withTimeout(client.query(baseQuery, [id]));
    if (!baseResult.rows.length) {
      return res.status(404).json({ error: 'Payment request not found' });
    }
    const accountantDue = Number(baseResult.rows[0]?.accountant_due_amount ?? 0);
    if (!Number.isFinite(accountantDue) || accountantDue <= 0) {
      return res.status(400).json({ error: 'accountant due amount is missing or invalid' });
    }
    if (numericAmountToPay > accountantDue) {
      return res.status(400).json({ error: 'amountToPay cannot be greater than accountant due amount' });
    }
    const remainingAmount = Number((accountantDue - numericAmountToPay).toFixed(2));
    const paymentState = remainingAmount > 0 ? 'partial' : 'full';

    const updateSql = `
      UPDATE payment_workflow_requests
      SET
        manager_pay_amount = $1,
        remaining_amount = $2,
        payment_state = $3,
        statement = 'PURCHASES',
        priority = $4,
        manager_approved = TRUE,
        manager_name = $5,
        manager_id = $6,
        manager_updated_at = CURRENT_TIMESTAMP,
        status = $7,
        stage = 'manager_done',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
        AND stage = 'manager'
        AND status = 'pending_manager'
      RETURNING *
    `;
    const finalStatus = paymentState === 'partial' ? 'approved_manager_partial' : 'approved_manager';
    const result = await withTimeout(
      client.query(updateSql, [
        numericAmountToPay,
        remainingAmount,
        paymentState,
        normalizedPriority,
        managerName,
        managerId,
        finalStatus,
        id,
      ]),
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Payment request not found in manager stage' });
    }

    const approvedRequest = result.rows[0];
    const paymentType = Number(process.env.MEDAD_PAYMENT_TYPE || 1);
    const version = Number(process.env.MEDAD_PAYMENT_VERSION || 1);
    const medadPayload = {
      customerId: approvedRequest.beneficiary_id,
      customerName: approvedRequest.beneficiary_name,
      paymentType,
      paymentAmount: Number(approvedRequest.manager_pay_amount),
      version,
    };

    let medadResponseBody = null;
    let medadSyncStatus = 'FAILED';
    let medadError = null;

    try {
      const token = await getMedadToken();
      const medadRes = await fetch(`${process.env.MEDAD_BASE_URL}/payment`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(medadPayload),
      });

      const rawText = await medadRes.text();
      try {
        medadResponseBody = rawText ? JSON.parse(rawText) : {};
      } catch {
        medadResponseBody = { raw: rawText };
      }

      if (!medadRes.ok) {
        medadError = rawText || `Medad payment failed with status ${medadRes.status}`;
        medadSyncStatus = 'FAILED';
      } else {
        medadSyncStatus = 'SENT_TO_MEDAD';
        medadError = null;
      }
    } catch (err) {
      medadSyncStatus = 'FAILED';
      medadError = err?.message || 'Medad payment request failed';
      medadResponseBody = { error: medadError };
    }

    await withTimeout(
      client.query(
        `UPDATE payment_workflow_requests
         SET medad_payload = $1,
             medad_response = $2,
             medad_sync_status = $3,
             medad_error = $4,
             medad_synced_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [medadPayload, medadResponseBody, medadSyncStatus, medadError, id],
      ),
    );

    return res.status(200).json({
      success: true,
      message: medadSyncStatus === 'SENT_TO_MEDAD' ? 'Payment approved and sent to Medad' : 'Payment approved but Medad sync failed',
      medad: {
        status: medadSyncStatus,
        error: medadError,
        response: medadResponseBody,
        payload: medadPayload,
      },
      request: {
        ...approvedRequest,
        medad_sync_status: medadSyncStatus,
        medad_error: medadError,
      },
    });
  } catch (error) {
    console.error('Manager update payment request failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to update payment request' });
  } finally {
    client.release();
  }
});

export default router;
