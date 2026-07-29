import { Dashboard } from './dashboard/Dashboard';
import { Pet } from './pet/Pet';
import styles from './Root.module.scss';

/**
 * Selects the dashboard or transparent desktop-pet surface from the query
 * parameter supplied by the native window.
 */
export function Root() {
  const mode = new URLSearchParams(window.location.search).get('mode');
  return (
    <main className={mode === 'dashboard' ? styles.dashboardRoot : styles.petRoot}>
      {mode === 'dashboard' ? <Dashboard /> : <Pet />}
    </main>
  );
}
