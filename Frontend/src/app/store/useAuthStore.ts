import { create } from 'zustand';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';
import { auth } from '../firebase';
import { apiClient } from '../api/client';

export type AppRole = 'SuperAdmin' | 'Admin' | 'Receptionist' | 'LabSpecialist';

interface DbUser {
  id: number;
  email: string;
  display_name: string;
  role: AppRole;
  hospital_id: number | null;
  hospital_name: string | null;
}

interface AuthState {
  token: string | null;
  role: AppRole | null;
  firebaseUser: FirebaseUser | null;
  dbUser: DbUser | null;
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  initAuthListener: () => () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  role: null,
  firebaseUser: null,
  dbUser: null,
  loading: true,
  error: null,

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const idToken = await cred.user.getIdToken();

      const resp = await apiClient.post('/auth/login', { firebase_token: idToken });
      const data = resp.data;

      set({
        token: idToken,
        firebaseUser: cred.user,
        role: data.user.role as AppRole,
        dbUser: {
          id: data.user.id,
          email: data.user.email,
          display_name: data.user.display_name,
          role: data.user.role as AppRole,
          hospital_id: data.user.hospital_id,
          hospital_name: data.hospital?.name ?? null,
        },
        loading: false,
        error: null,
      });
    } catch (err: any) {
      const msg =
        err?.response?.data?.detail ||
        err?.message ||
        'Login failed';
      set({ loading: false, error: msg });
      throw err;
    }
  },

  logout: async () => {
    try {
      await signOut(auth);
    } catch {
      // ignore signout errors
    }
    set({
      token: null,
      role: null,
      firebaseUser: null,
      dbUser: null,
      loading: false,
      error: null,
    });
  },

  initAuthListener: () => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const idToken = await user.getIdToken();
          const resp = await apiClient.post('/auth/login', { firebase_token: idToken });
          const data = resp.data;

          set({
            token: idToken,
            firebaseUser: user,
            role: data.user.role as AppRole,
            dbUser: {
              id: data.user.id,
              email: data.user.email,
              display_name: data.user.display_name,
              role: data.user.role as AppRole,
              hospital_id: data.user.hospital_id,
              hospital_name: data.hospital?.name ?? null,
            },
            loading: false,
          });
        } catch {
          await signOut(auth).catch(() => {});
          set({ token: null, role: null, firebaseUser: null, dbUser: null, loading: false });
        }
      } else {
        set({ token: null, role: null, firebaseUser: null, dbUser: null, loading: false });
      }
    });
    return unsubscribe;
  },
}));
