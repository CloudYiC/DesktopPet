import { Dashboard } from './dashboard/Dashboard';
import { Pet } from './pet/Pet';
import styles from './Root.module.scss';

export function Root() {
  const mode = new URLSearchParams(window.location.search).get('mode');
  return (
    <main className={mode === 'dashboard' ? styles.dashboardRoot : styles.petRoot}>
      {mode === 'dashboard' ? <Dashboard /> : <Pet />}
    </main>
  );
}

