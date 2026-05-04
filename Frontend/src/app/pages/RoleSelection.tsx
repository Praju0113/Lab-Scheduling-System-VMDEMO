import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { LogIn, Eye, EyeOff } from 'lucide-react';
import logo from '../../assets/Nueberg_Logo.png';
import { useAuthStore } from '../store/useAuthStore';

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, loading, error, role } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (role) {
      const routes: Record<string, string> = {
        SuperAdmin: '/super-admin',
        Admin: '/admin',
        Receptionist: '/receptionist',
        LabSpecialist: '/lab-specialist',
      };
      navigate(routes[role] || '/');
    }
  }, [role, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
    } catch {
      // error is already set in the store
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f3ebf7] via-white to-red-50">
      {/* Header */}
      <div className="bg-[#5D2582]">
        <div className="px-12 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="bg-white p-3 rounded-lg">
                <img src={logo} alt="Neuberg Diagnostics" className="h-12" />
              </div>
              <h1 className="text-3xl text-white">Lab Scheduling System</h1>
            </div>
            <div className="text-right text-white">
              <p className="text-2xl">
                {currentTime.toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </p>
              <p className="text-sm text-[#c8a8d8]">
                {currentTime.toLocaleDateString('en-US', {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Login Form */}
      <div className="flex items-center justify-center p-12">
        <div className="w-full max-w-md">
          <div className="bg-white rounded-2xl shadow-xl overflow-hidden">
            <div className="bg-gradient-to-r from-[#5D2582] via-[#7D3BA2] to-[#D4AF37] p-6">
              <h2 className="text-2xl text-white text-center">Sign In</h2>
              <p className="text-[#c8a8d8] text-center mt-1">
                Enter your credentials to continue
              </p>
            </div>

            <form onSubmit={handleSubmit} className="p-8 space-y-6">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] focus:border-transparent outline-none transition-all"
                  placeholder="you@hospital.com"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] focus:border-transparent outline-none transition-all pr-12"
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? (
                      <EyeOff className="w-5 h-5" />
                    ) : (
                      <Eye className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#5D2582] hover:bg-[#4a1d68] text-white py-3 px-4 rounded-lg font-medium transition-colors duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <>
                    <LogIn className="w-5 h-5" />
                    Sign In
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
