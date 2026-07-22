const net = require('node:net');

function isLoopbackHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  if (net.isIP(normalized) === 4) return normalized.startsWith('127.');
  return false;
}

function assertInternalApiSecurity({ host, token, allowInsecureLoopback = false }) {
  if (String(token || '').trim()) return true;
  if (!isLoopbackHost(host)) {
    throw new Error('token is required for non-loopback internal API listeners');
  }
  if (!allowInsecureLoopback) {
    throw new Error('tokenless loopback internal API requires explicit opt-in');
  }
  return true;
}

module.exports = { assertInternalApiSecurity, isLoopbackHost };
