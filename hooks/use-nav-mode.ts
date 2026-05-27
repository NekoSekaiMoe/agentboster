import { useEffect, useState } from 'react';

export type NavMode = 'bottom-tabs' | 'sidebar-drawer';

const NAV_MODE_KEY = 'nav-mode';

export function useNavMode() {
  const [navMode, setNavModeState] = useState<NavMode>('bottom-tabs');

  useEffect(() => {
    const stored = localStorage.getItem(NAV_MODE_KEY) as NavMode | null;
    if (stored === 'bottom-tabs' || stored === 'sidebar-drawer') {
      setNavModeState(stored);
    }
  }, []);

  const setNavMode = (mode: NavMode) => {
    setNavModeState(mode);
    localStorage.setItem(NAV_MODE_KEY, mode);
  };

  return { navMode, setNavMode };
}
