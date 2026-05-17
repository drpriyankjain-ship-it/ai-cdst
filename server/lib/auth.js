/**
 * CDST — JWT Authentication middleware
 * =====================================
 * Shared auth utilities used by REST routes and WebSocket upgrade.
 */

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_ALGORITHM = 'HS256';

/**
 * Verify and decode a JWT token.
 * @returns {object} Decoded claims
 * @throws {Error} If token is invalid or expired
 */
export function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      const e = new Error('Token expired');
      e.status = 401;
      throw e;
    }
    const e = new Error(`Invalid token: ${err.message}`);
    e.status = 401;
    throw e;
  }
}

/**
 * Sign a new JWT token.
 */
export function signJwt(payload, expiresIn = '24h') {
  return jwt.sign(payload, JWT_SECRET, { algorithm: JWT_ALGORITHM, expiresIn });
}

/**
 * Express middleware — require valid JWT in Authorization header.
 * Sets req.user to the decoded claims.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer header' });
  }
  try {
    req.user = verifyJwt(authHeader.slice(7));
    next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message });
  }
}

/**
 * Express middleware — optional JWT. Sets req.user if token present, null otherwise.
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      req.user = verifyJwt(authHeader.slice(7));
    } catch {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

/**
 * Extract Bearer token from WebSocket upgrade request headers.
 */
export function extractWsToken(ws, req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}
