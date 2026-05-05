import { useEffect } from 'react';
import { installGlobalFileDropGuards } from '../services/fileDropService.js';

export function useGlobalFileDropGuards() {
    useEffect(() => installGlobalFileDropGuards(), []);
}
