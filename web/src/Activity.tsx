import { useEffect, useState } from 'react';
import { subscribeActivity } from './api';

/** Barra de progreso global + aviso «Procesando…» mientras hay peticiones en curso (con retardo para no parpadear). */
export function Activity() {
  const [n, setN] = useState(0);
  const [visible, setVisible] = useState(false);
  const [secs, setSecs] = useState(0);

  useEffect(() => subscribeActivity(setN), []);
  useEffect(() => {
    if (n === 0) { setVisible(false); setSecs(0); return undefined; }
    const show = setTimeout(() => setVisible(true), 250);
    const tick = setInterval(() => setSecs((x) => x + 1), 1000);
    return () => { clearTimeout(show); clearInterval(tick); };
  }, [n > 0]);

  if (!visible) return null;
  return (
    <div className="activity" role="status" aria-live="polite" data-testid="activity">
      <div className="activity-bar" aria-hidden="true"><span /></div>
      <div className="activity-pill">
        <span className="spinner" aria-hidden="true" />
        Procesando… {secs >= 5 ? `(${secs} s) Sigue en curso, no cierre la página.` : 'un momento.'}
      </div>
    </div>
  );
}
