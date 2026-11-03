// Central authenticated-user state for CLIPFORGE (Phase 2).
//
// Truth lives on the server: the session is an HttpOnly cookie, and
// this provider simply mirrors GET /api/auth/me. The frontend never
// stores passwords, session tokens or verification tokens in web
// storage, and never treats its own state as authorization — the
// backend enforces everything.
//
// Guest mode is a UI mode only. It is marked with a sessionStorage
// flag ("cf_guest") purely so a page refresh keeps the demo open.
// The flag carries no credentials and grants nothing: the server
// never sees it, and anything that needs a real account still
// requires signing in.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authApi, clearCsrfCache, type AuthUser, type LoginResult } from "../../services/auth";

export type AuthStatus = "loading" | "anonymous" | "authenticated" | "guest";

export interface RegisterResult {
  user: AuthUser;
  emailVerificationRequired: boolean;
  emailConfigured: boolean;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  isGuest: boolean;
  login: (email: string, password: string, rememberMe: boolean) => Promise<LoginResult>;
  /** Adopt a user object after the MFA second step completes. */
  completeLogin: (user: AuthUser) => void;
  register: (input: {
    displayName: string;
    email: string;
    password: string;
    confirmPassword: string;
    termsAccepted: boolean;
  }) => Promise<RegisterResult>;
  logout: () => Promise<void>;
  enterGuest: () => void;
  exitGuest: () => void;
  refresh: () => Promise<void>;
  resendVerification: () => Promise<{ emailConfigured: boolean }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const GUEST_FLAG = "cf_guest";

function guestFlagSet(): boolean {
  try {
    return sessionStorage.getItem(GUEST_FLAG) === "1";
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await authApi.getMe();
      if (me) {
        setUser(me);
        setStatus("authenticated");
        return;
      }
    } catch {
      // Server unreachable or session invalid — fall through to a
      // non-authenticated state rather than pretending a session.
    }
    setUser(null);
    setStatus(guestFlagSet() ? "guest" : "anonymous");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const completeLogin = useCallback((signedIn: AuthUser) => {
    try {
      sessionStorage.removeItem(GUEST_FLAG);
    } catch {
      /* storage may be unavailable; guest flag is non-critical */
    }
    setUser(signedIn);
    setStatus("authenticated");
  }, []);

  const login = useCallback(
    async (email: string, password: string, rememberMe: boolean): Promise<LoginResult> => {
      const result = await authApi.login(email, password, rememberMe);
      // An MFA challenge is NOT a session yet — the login page runs
      // the second step and then calls completeLogin.
      if (result.kind === "user") completeLogin(result.user);
      return result;
    },
    [completeLogin],
  );

  const register = useCallback(
    async (input: {
      displayName: string;
      email: string;
      password: string;
      confirmPassword: string;
      termsAccepted: boolean;
    }): Promise<RegisterResult> => {
      const result = await authApi.register(input);
      // The server opens a session on registration; the account starts
      // UNVERIFIED (emailVerified=false) and the shell shows that
      // state honestly, with a working resend option.
      try {
        sessionStorage.removeItem(GUEST_FLAG);
      } catch {
        /* ignore */
      }
      setUser(result.user);
      setStatus("authenticated");
      return result;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // Even if the server is unreachable, drop local state; the
      // server session also expires on its own.
    }
    // Belt and braces with authApi.logout(): the in-memory CSRF
    // token must not survive into the next session.
    clearCsrfCache();
    try {
      sessionStorage.removeItem(GUEST_FLAG);
    } catch {
      /* ignore */
    }
    setUser(null);
    setStatus("anonymous");
  }, []);

  const enterGuest = useCallback(() => {
    try {
      sessionStorage.setItem(GUEST_FLAG, "1");
    } catch {
      /* ignore */
    }
    setUser(null);
    setStatus("guest");
  }, []);

  const exitGuest = useCallback(() => {
    try {
      sessionStorage.removeItem(GUEST_FLAG);
    } catch {
      /* ignore */
    }
    setUser(null);
    setStatus("anonymous");
  }, []);

  const resendVerification = useCallback(async () => {
    const result = await authApi.resendVerification();
    return result;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isGuest: status === "guest",
      login,
      completeLogin,
      register,
      logout,
      enterGuest,
      exitGuest,
      refresh,
      resendVerification,
    }),
    [status, user, login, completeLogin, register, logout, enterGuest, exitGuest, refresh, resendVerification],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
