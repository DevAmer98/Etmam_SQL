let cachedToken = null;
let tokenExpiry = 0;

const isNonEmpty = value => value !== undefined && value !== null && String(value).trim() !== '';

const pickFirst = (...values) => values.find(isNonEmpty);

const compact = obj =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => isNonEmpty(value)));

const parseJsonSafe = async response => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const hasMedadConfig = () =>
  isNonEmpty(process.env.MEDAD_BASE_URL) &&
  isNonEmpty(process.env.MEDAD_USERNAME) &&
  isNonEmpty(process.env.MEDAD_PASSWORD) &&
  isNonEmpty(process.env.MEDAD_SUBSCRIPTION_ID);

export const getMedadToken = async () => {
  if (!hasMedadConfig()) {
    throw new Error('Medad integration is not configured on server');
  }

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

  const data = await parseJsonSafe(response);
  if (!response.ok) {
    throw new Error(`Medad token request failed: ${JSON.stringify(data)}`);
  }

  const token = data?.token || data?.access_token || data?.data?.token;
  if (!token) throw new Error('Medad token not found in response');

  const expiresIn = Number(data?.expiresIn || data?.expires_in || 3600);
  cachedToken = token;
  tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  return cachedToken;
};

const normalizeMedadCustomerId = body =>
  pickFirst(
    body?.id,
    body?.customerId,
    body?.customer_id,
    body?.customerNo,
    body?.customer_no,
    body?.accountNo,
    body?.account_no,
    body?.data?.id,
    body?.data?.customerId,
    body?.data?.customer_id,
    body?.result?.id,
    body?.result?.customerId,
  );

export const createMedadCustomer = async ({
  accountType,
  companyName,
  contactName,
  phoneNumber,
  vatNo,
  branchName,
  address1,
  address2,
  city,
  region,
  salesmanId,
  salesmanName,
  warehouseNo,
}) => {
  const token = await getMedadToken();

  const payload = compact({
    accountType: String(accountType),
    customerName: companyName,
    name: companyName,
    branchName: pickFirst(branchName, contactName),
    contactName,
    phone: phoneNumber,
    contact1Phone: phoneNumber,
    vatNo,
    vat_no: vatNo,
    address1,
    address2,
    city,
    region,
    salesmanId,
    salesmanName,
    warehouseNo,
  });

  const response = await fetch(`${process.env.MEDAD_BASE_URL}/customers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await parseJsonSafe(response);
  const logicalFailure =
    body?.success === false ||
    !!body?.error ||
    !!body?.errors ||
    (typeof body?.message === 'string' && /(validation|exception|error|failed|invalid)/i.test(body.message));

  if (!response.ok || logicalFailure) {
    throw new Error(`Medad customer create failed: ${JSON.stringify(body)}`);
  }

  return {
    payload,
    response: body,
    medadCustomerId: normalizeMedadCustomerId(body),
  };
};

