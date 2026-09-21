'use client';

import { attachFoil } from '@hraness/design-kit/browser';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/** The shared footer owns its effects; page and header targets stay separate. */
export function FoilController() {
  const pathname = usePathname();
  useEffect(() => {
    const cleanups = Array.from(document.querySelectorAll<HTMLElement>('header.hraness-marketing-header, main'), attachFoil);
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [pathname]);
  return null;
}
