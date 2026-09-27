import { WS_BASE } from '../config';

// Live alert channel with automatic reconnect (1s, 2s, 4s ... up to 30s).
export function connectAlerts({ onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let retry = 1000;
  let ping = null;
  let timer = null;

  const open = () => {
    ws = new WebSocket(`${WS_BASE}/ws/alerts`);
    ws.onopen = () => {
      retry = 1000;
      onStatus?.(true);
      ping = setInterval(() => {
        try {
          ws.send('ping');
        } catch {}
      }, 25000);
    };
    ws.onmessage = (e) => {
      try {
        onMessage?.(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      onStatus?.(false);
      clearInterval(ping);
      if (!closed) {
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 30000);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  };

  open();
  return {
    close: () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {}
    },
  };
}
