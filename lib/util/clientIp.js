// Resolve the real client IP for a request that arrives through our reverse
// proxy (Caddy), for use as a rate-limiting key.
//
// `request.info.remoteAddress` is the address of whoever opened the TCP socket
// to the app. Behind Caddy that is always the proxy/loopback address, identical
// for every visitor — so keying a per-IP limit on it makes the limit GLOBAL and
// can lock out all users at once. We instead read the client IP from
// `X-Forwarded-For`, which Caddy sets.
//
// Security note: X-Forwarded-For is a comma-separated chain "client, proxy1,
// proxy2, ...". The earlier (left) entries are supplied by the caller and are
// therefore spoofable — trusting them would let an attacker forge a fresh
// rate-limit bucket on every request. With exactly one trusted proxy (Caddy),
// the trustworthy client address is the RIGHTMOST entry: the one Caddy itself
// appended for the connection it actually accepted, which the client cannot
// forge. If additional trusted proxies/CDNs are ever placed in front, this must
// step further left (one entry per trusted hop).
//
// Falls back to the socket address when there is no proxy header (direct or
// local access, e.g. tests or hitting the app port directly).
module.exports = function clientIp(request) {
  var xff = request && request.headers && request.headers['x-forwarded-for'];
  if (xff) {
    var parts = xff.split(',');
    var last = parts[parts.length - 1].trim();
    if (last) return last;
  }
  return request && request.info && request.info.remoteAddress;
};
