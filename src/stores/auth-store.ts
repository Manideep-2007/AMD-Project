/**
 * Auth Store — Zustand store for authentication state.
 * Manages JWT tokens, user info, and login/logout flow.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { apiClient } from '@/lib/api-client';

export interface User {
  id: string;
  email: string;
  name?: string;
  role: string;
  workspaceId: string;
  workspaceName?: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  login: (email: string, password: string) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    name?: string;
    workspaceName: string;
    workspaceSlug: string;
  }) => Promise<void>;
  logout: () => void;
  refreshAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      isLoading: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true });
        try {
          const response = await apiClient.post('/auth/login', { email, password });
          const { user, accessToken } = response.data.data;
          // refreshToken is stored exclusively in the httpOnly cookie set by the server.
          // Never write it to localStorage.

          set({
            user,
            accessToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      register: async (data) => {
        set({ isLoading: true });
        try {
          const response = await apiClient.post('/auth/register', data);
          const { user, accessToken } = response.data.data;
          // refreshToken is stored exclusively in the httpOnly cookie set by the server.

          set({
            user,
            accessToken,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      logout: () => {
        set({
          user: null,
          accessToken: null,
          isAuthenticated: false,
        });
      },

      refreshAuth: async () => {
        try {
          // POST with credentials so the browser sends the httpOnly refresh-token cookie.
          // No token body needed — the server reads the cookie directly.
          const response = await apiClient.postWithCredentials('/auth/refresh', {});
          const data = response.data.data;

          set({ accessToken: data.accessToken });
        } catch {
          get().logout();
        }
      },
    }),
    {
      name: 'nexusops-auth',
      partialize: (state) => ({
        user: state.user,
        // accessToken is NOT persisted to localStorage — it lives only in memory.
        // On page refresh, refreshAuth() re-obtains it via the httpOnly cookie.
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
