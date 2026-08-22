// This host has no working IPv6 route, but DNS still returns AAAA records for
// external hosts (e.g. api.telegram.org). Node's Happy Eyeballs (autoSelectFamily)
// races the IPv6 attempt in parallel with IPv4, and the doomed IPv6 attempt
// intermittently starves/delays the IPv4 connection, causing fetch to fail
// with ETIMEDOUT roughly half the time. Disabling it process-wide is scoped to
// this app only (unlike a system-wide IPv6 disable, which would also affect
// Tailscale and other services on this host).
require('node:net').setDefaultAutoSelectFamily(false);
