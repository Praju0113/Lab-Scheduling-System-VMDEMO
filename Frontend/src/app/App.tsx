import { useEffect } from 'react';
import { RouterProvider } from 'react-router';
import { useRealTimeUpdates } from './hooks/useRealTimeUpdates';
import { router } from './routes';
import { useAppStore } from './store/useAppStore';
import { useAuthStore } from './store/useAuthStore';

export default function App() {
  const initializeData = useAppStore((state) => state.initializeData);
  const { initAuthListener, token, loading } = useAuthStore();
  useRealTimeUpdates();

  useEffect(() => {
    const unsubscribe = initAuthListener();
    return unsubscribe;
  }, [initAuthListener]);

  useEffect(() => {
    if (token) {
      initializeData().catch((error) => console.error('Failed to load initial data', error));
    }
  }, [token, initializeData]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-10 h-10 border-4 border-[#5D2582] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return <RouterProvider router={router} />;
}
