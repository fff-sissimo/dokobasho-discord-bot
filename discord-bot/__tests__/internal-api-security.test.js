const { assertInternalApiSecurity } = require('../src/internal-api-security');

describe('internal API security', () => {
  it('rejects a non-loopback listener without a token', () => {
    expect(() => assertInternalApiSecurity({ host: '0.0.0.0', token: '' }))
      .toThrow('token is required for non-loopback internal API listeners');
  });

  it('allows tokenless loopback only with explicit development opt-in', () => {
    expect(() => assertInternalApiSecurity({
      host: '127.0.0.1',
      token: '',
      allowInsecureLoopback: false,
    })).toThrow('tokenless loopback internal API requires explicit opt-in');

    expect(() => assertInternalApiSecurity({
      host: '127.0.0.1',
      token: '',
      allowInsecureLoopback: true,
    })).not.toThrow();
  });
});
