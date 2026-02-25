import express from 'express';
import { Pool } from 'pg';

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
};

router.post('/payments/workflow', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const {
      beneficiaryId,
      beneficiaryName,
      beneficiaryType,
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
        beneficiary_id, beneficiary_name, beneficiary_type, operation_amount, due_date, description,
        is_beneficiary_account_added, stage, status, created_by, created_by_clerk_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'accountant','pending_accountant',$8,$9)
      RETURNING *
    `;

    const params = [
      String(beneficiaryId),
      String(beneficiaryName),
      String(beneficiaryType),
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
    const onlyPending = (req.query.status || 'pending').toString().toLowerCase() === 'pending';

    const query = `
      SELECT *
      FROM payment_workflow_requests
      WHERE stage = 'accountant'
      ${onlyPending ? "AND status = 'pending_accountant'" : ''}
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const result = await withTimeout(client.query(query));
    return res.status(200).json({ success: true, requests: result.rows });
  } catch (error) {
    console.error('Fetch accountant payment requests failed:', error);
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

export default router;
