import { createContext } from 'react';
import type { CardCache } from './engine/queue-controls';

/** ROW-PLAY-001: the app's download cache, so any song list can show which songs are ready to play. */
export const CardCacheContext = createContext<((key: string) => CardCache | null) | null>(null);
