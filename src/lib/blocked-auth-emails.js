const DEFAULT_BLOCKED_EMAILS = 'user@example.com';

function getBlockedAuthEmails() {
  return String(process.env.AUTH_BLOCKED_LOGIN_EMAILS || DEFAULT_BLOCKED_EMAILS)
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function isBlockedAuthEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized ? getBlockedAuthEmails().includes(normalized) : false;
}

module.exports = {
  isBlockedAuthEmail,
};
