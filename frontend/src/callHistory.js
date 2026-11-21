const key = 'wirachit.demo-calls.v1';

export function tabCalls() {
  try {
    const rows = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(rows) ? rows.filter(row => row?.contactId && row?.token) : [];
  } catch {
    return [];
  }
}

export function rememberCall(contactId, token, contactName) {
  const entry = { contactId, token, contactName, startedAt: new Date().toISOString() };
  try {
    sessionStorage.setItem(key, JSON.stringify([entry, ...tabCalls().filter(row => row.contactId !== contactId)]));
  } catch { /* The live call can continue when tab storage is disabled. */ }
}
