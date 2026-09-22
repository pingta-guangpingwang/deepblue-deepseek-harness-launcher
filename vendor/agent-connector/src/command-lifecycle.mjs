export function commandExpired(command, now = Date.now()) {
  const raw = String(command?.expires_at || command?.expiresAt || '');
  if (!raw) return false; // Older protocols without a deadline retain server execution gating.
  const timestamp = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? raw.replace(' ', 'T') + '+08:00' : raw);
  return !Number.isFinite(timestamp) || timestamp <= now;
}
export function isMaintenance(command) {
  return ['refresh_snapshot', 'refresh_session_history'].includes(command?.command_type);
}
export function syncFailurePolicy(command, error) {
  const status = Number(error?.status) || 0;
  const code = String(error?.code || '');
  if (status === 401 || status === 403) return 'wait_auth';
  if (isMaintenance(command) && (status === 404 || status === 410)) return 'archive';
  if (isMaintenance(command) && status === 409 && code === 'history_session_not_synced') {
    return Number(command._catalogRepairAttempts || 0) < 2 ? 'repair_catalog' : 'archive';
  }
  if (command?._localFinal && ['task_not_found','task_expired','task_terminal','invalid_task_transition'].includes(code)) return 'archive';
  return 'retry';
}
