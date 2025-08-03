export const errorHandler = (err, req, res, next) => {
  console.error('Unhandled Error:', err); // Extend to use Winston/Datadog etc.

  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
  res.status(statusCode).json({
    error: 'Internal Server Error',
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? '🛑' : err.stack,
  });
};
