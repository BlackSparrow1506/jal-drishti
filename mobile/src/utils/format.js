export function formatDuration(totalMin, t) {
  if (totalMin == null) return '';
  const m = Math.max(0, Math.round(totalMin));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} ${t('unitMin')}`;
  return `${h} ${t('unitH')} ${r} ${t('unitMin')}`;
}

export function formatClock(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function minutesUntil(iso, now = Date.now()) {
  if (!iso) return null;
  return (new Date(iso).getTime() - now) / 60000;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return 'now';
  if (diff < 60) return `${Math.round(diff)} min ago`;
  if (diff < 1440) return `${Math.round(diff / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
}
