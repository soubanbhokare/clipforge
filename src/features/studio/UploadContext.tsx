// Global "is a real upload in progress" state for the Studio shell.
// Only set while an actual XMLHttpRequest upload is running — the
// top bar indicator reads this, so it can never show a fake job.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export interface ActiveUpload {
  projectId: string | null;
  filename: string;
  percent: number;
}

interface UploadContextValue {
  activeUpload: ActiveUpload | null;
  setActiveUpload: (upload: ActiveUpload | null) => void;
}

const UploadContext = createContext<UploadContextValue>({ activeUpload: null, setActiveUpload: () => {} });

export function UploadProvider({ children }: { children: ReactNode }) {
  const [activeUpload, setState] = useState<ActiveUpload | null>(null);
  const setActiveUpload = useCallback((upload: ActiveUpload | null) => setState(upload), []);
  const value = useMemo(() => ({ activeUpload, setActiveUpload }), [activeUpload, setActiveUpload]);
  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUpload(): UploadContextValue {
  return useContext(UploadContext);
}
