import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { Building2, Users, Plus, LogOut, RefreshCw, Link2, Key, Copy, Check, Eye, EyeOff, Edit, Trash2, Ban, RotateCcw } from 'lucide-react';
import logo from '../../assets/Nueberg_Logo.png';
import { useAuthStore } from '../store/useAuthStore';
import { apiClient } from '../api/client';
import { frontendApi } from '../api/frontend';
import type { LimsConfigData } from '../types';
import { Modal } from '../components/dashboard/Modal';

interface Hospital {
  id: number;
  name: string;
  code: string;
  is_active: boolean;
}

interface UserRecord {
  id: number;
  email: string;
  display_name: string;
  role: string;
  hospital_id: number | null;
  is_active: boolean;
}

export default function SuperAdminDashboard() {
  const navigate = useNavigate();
  const { dbUser, logout } = useAuthStore();
  const [tab, setTab] = useState<'hospitals' | 'users' | 'lims'>('hospitals');

  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const [limsHospitalId, setLimsHospitalId] = useState<number | ''>('');
  const [limsConfig, setLimsConfig] = useState<LimsConfigData | null>(null);
  const [limsLoading, setLimsLoading] = useState(false);
  const [limsSaving, setLimsSaving] = useState(false);
  const [limsCallbackUrl, setLimsCallbackUrl] = useState('');
  const [limsEnabled, setLimsEnabled] = useState(false);
  const [generatedApiKey, setGeneratedApiKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);

  const [showHospitalForm, setShowHospitalForm] = useState(false);
  const [hospitalName, setHospitalName] = useState('');
  const [hospitalCode, setHospitalCode] = useState('');
  const [showEditHospitalModal, setShowEditHospitalModal] = useState(false);
  const [editingHospital, setEditingHospital] = useState<Hospital | null>(null);
  const [editHospitalName, setEditHospitalName] = useState('');
  const [editHospitalCode, setEditHospitalCode] = useState('');
  const [editHospitalIsActive, setEditHospitalIsActive] = useState(true);

  const [showUserForm, setShowUserForm] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [userDisplayName, setUserDisplayName] = useState('');
  const [userRole, setUserRole] = useState<'Receptionist' | 'LabSpecialist' | 'Admin' | 'SuperAdmin'>('Receptionist');
  const [userHospitalId, setUserHospitalId] = useState<number | ''>('');
  const [specialistGender, setSpecialistGender] = useState('Other');
  const [showEditUserModal, setShowEditUserModal] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
  const [editUserEmail, setEditUserEmail] = useState('');
  const [editUserPassword, setEditUserPassword] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [editUserDisplayName, setEditUserDisplayName] = useState('');
  const [editUserRole, setEditUserRole] = useState<'Receptionist' | 'LabSpecialist' | 'Admin' | 'SuperAdmin'>('Receptionist');
  const [editUserHospitalId, setEditUserHospitalId] = useState<number | ''>('');
  const [editSpecialistGender, setEditSpecialistGender] = useState('Other');
  const [pendingHospitalAction, setPendingHospitalAction] = useState<Hospital | null>(null);
  const [pendingUserAction, setPendingUserAction] = useState<UserRecord | null>(null);

  const [formError, setFormError] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  const fetchData = async () => {
    setLoadingData(true);
    try {
      const [h, u] = await Promise.all([
        apiClient.get('/super-admin/hospitals'),
        apiClient.get('/super-admin/users'),
      ]);
      setHospitals(h.data);
      setUsers(u.data);
    } catch {
      // ignore
    }
    setLoadingData(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleCreateHospital = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);
    try {
      await apiClient.post('/super-admin/hospitals', {
        name: hospitalName,
        code: hospitalCode,
      });
      setHospitalName('');
      setHospitalCode('');
      setShowHospitalForm(false);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to create hospital');
    }
    setFormLoading(false);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.createSuperAdminUser({
        email: userEmail,
        password: userPassword,
        display_name: userDisplayName,
        role: userRole,
        hospital_id: userHospitalId || null,
        ...(userRole === 'LabSpecialist' ? { gender: specialistGender } : {}),
      });
      setUserEmail('');
      setUserPassword('');
      setUserDisplayName('');
      setUserRole('Receptionist');
      setUserHospitalId('');
      setUserPassword('');
      setShowPassword(false);
      setSpecialistGender('Other');
      setShowUserForm(false);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to create user');
    }
    setFormLoading(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  const loadLimsConfig = async (hospitalId: number) => {
    setLimsLoading(true);
    setGeneratedApiKey(null);
    try {
      const cfg = await frontendApi.getLimsConfig(hospitalId);
      setLimsConfig(cfg);
      setLimsCallbackUrl(cfg.callback_url || '');
      setLimsEnabled(cfg.is_enabled);
    } catch {
      setLimsConfig(null);
      setLimsCallbackUrl('');
      setLimsEnabled(false);
    }
    setLimsLoading(false);
  };

  const handleLimsHospitalChange = (id: number | '') => {
    setLimsHospitalId(id);
    if (id) loadLimsConfig(id);
    else {
      setLimsConfig(null);
      setGeneratedApiKey(null);
    }
  };

  const handleSaveLimsConfig = async () => {
    if (!limsHospitalId) return;
    setLimsSaving(true);
    try {
      await frontendApi.saveLimsConfig(limsHospitalId, {
        callback_url: limsCallbackUrl.trim() || null,
        is_enabled: limsEnabled,
      });
      await loadLimsConfig(limsHospitalId);
    } catch (err: any) {
      console.error('Save LIMS config failed', err);
    }
    setLimsSaving(false);
  };

  const openEditUserModal = (record: UserRecord) => {
    setEditingUser(record);
    setEditUserEmail(record.email);
    setEditUserPassword('');
    setShowEditPassword(false);
    setEditUserDisplayName(record.display_name);
    setEditUserRole(record.role as 'Receptionist' | 'LabSpecialist' | 'Admin' | 'SuperAdmin');
    setEditUserHospitalId(record.hospital_id ?? '');
    setEditSpecialistGender('Other');
    setFormError('');
    setShowEditUserModal(true);
  };

  const handleEditUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.updateSuperAdminUser(editingUser.id, {
        email: editUserEmail,
        display_name: editUserDisplayName,
        role: editUserRole,
        hospital_id: editUserHospitalId || null,
        password: editUserPassword.trim() || undefined,
        ...(editUserRole === 'LabSpecialist' ? { gender: editSpecialistGender } : {}),
      });
      setShowEditUserModal(false);
      setEditingUser(null);
      setEditUserPassword('');
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to update user');
    }
    setFormLoading(false);
  };

  const handleDeleteHospital = async () => {
    if (!pendingHospitalAction) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.deleteSuperAdminHospital(pendingHospitalAction.id);
      setPendingHospitalAction(null);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to delete hospital');
    }
    setFormLoading(false);
  };

  const handleDisableHospital = async () => {
    if (!pendingHospitalAction) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.disableSuperAdminHospital(pendingHospitalAction.id);
      setPendingHospitalAction(null);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to disable hospital');
    }
    setFormLoading(false);
  };

  const handleEnableHospital = async (hospitalId: number) => {
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.enableSuperAdminHospital(hospitalId);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to enable hospital');
    }
    setFormLoading(false);
  };

  const handleDeleteUser = async () => {
    if (!pendingUserAction) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.deleteSuperAdminUser(pendingUserAction.id);
      setPendingUserAction(null);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to delete user');
    }
    setFormLoading(false);
  };

  const handleDisableUser = async () => {
    if (!pendingUserAction) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.disableSuperAdminUser(pendingUserAction.id);
      setPendingUserAction(null);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to disable user');
    }
    setFormLoading(false);
  };

  const handleEnableUser = async (userId: number) => {
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.enableSuperAdminUser(userId);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to enable user');
    }
    setFormLoading(false);
  };

  const openEditHospitalModal = (record: Hospital) => {
    setEditingHospital(record);
    setEditHospitalName(record.name);
    setEditHospitalCode(record.code);
    setEditHospitalIsActive(record.is_active);
    setFormError('');
    setShowEditHospitalModal(true);
  };

  const handleEditHospital = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingHospital) return;
    setFormError('');
    setFormLoading(true);
    try {
      await frontendApi.updateSuperAdminHospital(editingHospital.id, {
        name: editHospitalName,
        code: editHospitalCode,
        is_active: editHospitalIsActive,
      });
      setShowEditHospitalModal(false);
      setEditingHospital(null);
      await fetchData();
    } catch (err: any) {
      setFormError(err?.response?.data?.detail || 'Failed to update hospital');
    }
    setFormLoading(false);
  };

  const handleRegenerateKey = async () => {
    if (!limsHospitalId) return;
    setLimsSaving(true);
    try {
      const result = await frontendApi.regenerateLimsKey(limsHospitalId);
      setGeneratedApiKey(result.api_key);
      setKeyCopied(false);
      await loadLimsConfig(limsHospitalId);
    } catch (err: any) {
      console.error('Regenerate key failed', err);
    }
    setLimsSaving(false);
  };

  const copyApiKey = () => {
    if (generatedApiKey) {
      navigator.clipboard.writeText(generatedApiKey);
      setKeyCopied(true);
      setTimeout(() => setKeyCopied(false), 3000);
    }
  };

  const hospitalMap = Object.fromEntries(hospitals.map((h) => [h.id, h.name]));

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#5D2582]">
        <div className="px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="bg-white p-2 rounded-lg">
              <img src={logo} alt="Neuberg Diagnostics" className="h-8" />
            </div>
            <div>
              <h1 className="text-xl text-white">Super Admin Dashboard</h1>
              <p className="text-sm text-[#c8a8d8]">
                {dbUser?.display_name} &middot; {dbUser?.email}
              </p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-white hover:text-[#D4AF37] transition-colors"
          >
            <LogOut className="w-5 h-5" />
            Sign Out
          </button>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8">
        {/* Tabs */}
        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setTab('hospitals')}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              tab === 'hospitals'
                ? 'bg-[#5D2582] text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Building2 className="w-5 h-5" />
            Hospitals
          </button>
          <button
            onClick={() => setTab('users')}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              tab === 'users'
                ? 'bg-[#5D2582] text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Users className="w-5 h-5" />
            Users
          </button>
          <button
            onClick={() => setTab('lims')}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
              tab === 'lims'
                ? 'bg-[#5D2582] text-white'
                : 'bg-white text-gray-700 hover:bg-gray-100'
            }`}
          >
            <Link2 className="w-5 h-5" />
            LIMS
          </button>
          <button
            onClick={fetchData}
            disabled={loadingData}
            className="ml-auto flex items-center gap-2 px-4 py-3 bg-white text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Hospitals Tab */}
        {tab === 'hospitals' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-gray-900">
                Hospitals ({hospitals.length})
              </h2>
              <button
                onClick={() => {
                  setShowHospitalForm(!showHospitalForm);
                  setFormError('');
                }}
                className="flex items-center gap-2 px-4 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Hospital
              </button>
            </div>

            {showHospitalForm && (
              <form
                onSubmit={handleCreateHospital}
                className="bg-white p-6 rounded-xl shadow-sm border space-y-4"
              >
                {formError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
                    {formError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Hospital Name
                    </label>
                    <input
                      required
                      value={hospitalName}
                      onChange={(e) => setHospitalName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Code (unique)
                    </label>
                    <input
                      required
                      value={hospitalCode}
                      onChange={(e) => setHospitalCode(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                      placeholder="e.g. HOSP1"
                    />
                  </div>
                </div>
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="px-6 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
                  >
                    {formLoading ? 'Creating...' : 'Create Hospital'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowHospitalForm(false)}
                    className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      ID
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Name
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Code
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Status
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {hospitals.map((h) => (
                    <tr key={h.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm text-gray-600">{h.id}</td>
                      <td className="px-6 py-4 text-sm font-medium text-gray-900">
                        {h.name}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600 font-mono">
                        {h.code}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${
                            h.is_active
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {h.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => openEditHospitalModal(h)}
                            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                          >
                            <Edit className="w-4 h-4" />
                            Edit
                          </button>
                          {h.is_active ? (
                            <button
                              type="button"
                              onClick={() => setPendingHospitalAction(h)}
                              className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                            >
                              <Trash2 className="w-4 h-4" />
                              Delete / Disable
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleEnableHospital(h.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-green-200 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50"
                            >
                              <RotateCcw className="w-4 h-4" />
                              Enable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {hospitals.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-gray-400">
                        No hospitals yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* LIMS Tab */}
        {tab === 'lims' && (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold text-gray-900">LIMS Integration</h2>

            <div className="bg-white rounded-xl shadow-sm border p-6 space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Hospital
                </label>
                <select
                  value={limsHospitalId}
                  onChange={(e) =>
                    handleLimsHospitalChange(e.target.value ? Number(e.target.value) : '')
                  }
                  className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                >
                  <option value="">-- Choose a hospital --</option>
                  {hospitals.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.code})
                    </option>
                  ))}
                </select>
              </div>

              {limsLoading && (
                <p className="text-sm text-gray-500">Loading configuration...</p>
              )}

              {limsHospitalId && !limsLoading && (
                <>
                  {/* API Key */}
                  <div className="border-t pt-6 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      <Key className="w-4 h-4" /> API Key
                    </h3>
                    {limsConfig?.has_api_key ? (
                      <p className="text-sm text-gray-600">
                        An API key has been generated for this hospital. Regenerate to replace it.
                      </p>
                    ) : (
                      <p className="text-sm text-gray-500">
                        No API key has been generated yet.
                      </p>
                    )}

                    {generatedApiKey && (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-2">
                        <p className="text-xs font-medium text-amber-800">
                          Copy this key now — it will not be shown again.
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 bg-white px-3 py-2 rounded border border-amber-300 text-sm font-mono text-gray-900 break-all select-all">
                            {generatedApiKey}
                          </code>
                          <button
                            onClick={copyApiKey}
                            className="flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
                          >
                            {keyCopied ? (
                              <><Check className="w-4 h-4 text-green-600" /> Copied</>
                            ) : (
                              <><Copy className="w-4 h-4" /> Copy</>
                            )}
                          </button>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleRegenerateKey}
                      disabled={limsSaving}
                      className="flex items-center gap-2 px-4 py-2 text-sm bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
                    >
                      <Key className="w-4 h-4" />
                      {limsConfig?.has_api_key ? 'Regenerate Key' : 'Generate Key'}
                    </button>
                  </div>

                  {/* Callback URL */}
                  <div className="border-t pt-6 space-y-3">
                    <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                      <Link2 className="w-4 h-4" /> Webhook Callback URL
                    </h3>
                    <p className="text-xs text-gray-500">
                      When a test completes, a POST request with completion data will be sent to this URL.
                    </p>
                    <input
                      type="url"
                      value={limsCallbackUrl}
                      onChange={(e) => setLimsCallbackUrl(e.target.value)}
                      placeholder="https://your-lims.example.com/api/webhook"
                      className="w-full max-w-lg px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none text-sm"
                    />
                  </div>

                  {/* Enabled toggle */}
                  <div className="border-t pt-6 flex items-center gap-4">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={limsEnabled}
                        onChange={(e) => setLimsEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:ring-2 peer-focus:ring-[#5D2582] rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#5D2582]" />
                    </label>
                    <span className="text-sm text-gray-700">
                      {limsEnabled ? 'LIMS integration enabled' : 'LIMS integration disabled'}
                    </span>
                  </div>

                  {/* Save */}
                  <div className="border-t pt-6">
                    <button
                      onClick={handleSaveLimsConfig}
                      disabled={limsSaving}
                      className="px-6 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
                    >
                      {limsSaving ? 'Saving...' : 'Save Configuration'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Users Tab */}
        {tab === 'users' && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-semibold text-gray-900">
                Users ({users.length})
              </h2>
              <button
                onClick={() => {
                  setShowUserForm(!showUserForm);
                  setFormError('');
                }}
                className="flex items-center gap-2 px-4 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add User
              </button>
            </div>

            {showUserForm && (
              <form
                onSubmit={handleCreateUser}
                className="bg-white p-6 rounded-xl shadow-sm border space-y-4"
              >
                {formError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
                    {formError}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email
                    </label>
                    <input
                      type="email"
                      required
                      value={userEmail}
                      onChange={(e) => setUserEmail(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={userPassword}
                        onChange={(e) => setUserPassword(e.target.value)}
                        className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((value) => !value)}
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-700"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Display Name
                    </label>
                    <input
                      required
                      value={userDisplayName}
                      onChange={(e) => setUserDisplayName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Role
                    </label>
                    <select
                      value={userRole}
                      onChange={(e) => setUserRole(e.target.value as 'Receptionist' | 'LabSpecialist' | 'Admin' | 'SuperAdmin')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                    >
                      <option value="Receptionist">Receptionist</option>
                      <option value="LabSpecialist">Lab Specialist</option>
                      <option value="Admin">Admin</option>
                      <option value="SuperAdmin">Super Admin</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Hospital
                    </label>
                    <select
                      value={userHospitalId}
                      onChange={(e) =>
                        setUserHospitalId(e.target.value ? Number(e.target.value) : '')
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                    >
                      <option value="">None (SuperAdmin only)</option>
                      {hospitals.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name} ({h.code})
                        </option>
                      ))}
                    </select>
                  </div>
                  {userRole === 'LabSpecialist' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Gender
                      </label>
                      <select
                        value={specialistGender}
                        onChange={(e) => setSpecialistGender(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                      >
                        <option value="Other">Other</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                    </div>
                  )}
                </div>
                {userRole === 'LabSpecialist' && (
                  <p className="text-xs text-gray-500">
                    Shift times are optional here and will use backend defaults when omitted.
                  </p>
                )}
                <div className="flex gap-3">
                  <button
                    type="submit"
                    disabled={formLoading}
                    className="px-6 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
                  >
                    {formLoading ? 'Creating...' : 'Create User'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowUserForm(false)}
                    className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}

            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Name
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Email
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Role
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Hospital
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Status
                    </th>
                    <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm font-medium text-gray-900">
                        {u.display_name}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">{u.email}</td>
                      <td className="px-6 py-4">
                        <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700">
                          {u.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {u.hospital_id ? hospitalMap[u.hospital_id] || `ID ${u.hospital_id}` : '—'}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${
                            u.is_active
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                          }`}
                        >
                          {u.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => openEditUserModal(u)}
                            className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                          >
                            <Edit className="w-4 h-4" />
                            Edit
                          </button>
                          {u.is_active ? (
                            <button
                              type="button"
                              onClick={() => setPendingUserAction(u)}
                              className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                            >
                              <Trash2 className="w-4 h-4" />
                              Delete / Disable
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleEnableUser(u.id)}
                              className="inline-flex items-center gap-1 rounded-lg border border-green-200 px-3 py-1.5 text-sm text-green-700 hover:bg-green-50"
                            >
                              <RotateCcw className="w-4 h-4" />
                              Enable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-gray-400">
                        No users yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showEditUserModal && editingUser && (
        <Modal onClose={() => setShowEditUserModal(false)} title={`Edit ${editingUser.display_name}`} widthClass="max-w-2xl">
          <form onSubmit={handleEditUser} className="space-y-4">
            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
                {formError}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={editUserEmail}
                  onChange={(e) => setEditUserEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
                <div className="relative">
                  <input
                    type={showEditPassword ? 'text' : 'password'}
                    minLength={6}
                    value={editUserPassword}
                    onChange={(e) => setEditUserPassword(e.target.value)}
                    placeholder="Leave blank to keep unchanged"
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowEditPassword((value) => !value)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-700"
                  >
                    {showEditPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="mt-1 text-xs text-gray-500">This sets a new password. The current password cannot be viewed.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
                <input
                  required
                  value={editUserDisplayName}
                  onChange={(e) => setEditUserDisplayName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={editUserRole}
                  onChange={(e) => setEditUserRole(e.target.value as 'Receptionist' | 'LabSpecialist' | 'Admin' | 'SuperAdmin')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                >
                  <option value="Receptionist">Receptionist</option>
                  <option value="LabSpecialist">Lab Specialist</option>
                  <option value="Admin">Admin</option>
                  <option value="SuperAdmin">Super Admin</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Hospital</label>
                <select
                  value={editUserHospitalId}
                  onChange={(e) => setEditUserHospitalId(e.target.value ? Number(e.target.value) : '')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                >
                  <option value="">None (SuperAdmin only)</option>
                  {hospitals.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.code})
                    </option>
                  ))}
                </select>
              </div>
              {editUserRole === 'LabSpecialist' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
                  <select
                    value={editSpecialistGender}
                    onChange={(e) => setEditSpecialistGender(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
                  >
                    <option value="Other">Other</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowEditUserModal(false)}
                className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={formLoading}
                className="px-6 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
              >
                {formLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showEditHospitalModal && editingHospital && (
        <Modal onClose={() => setShowEditHospitalModal(false)} title={`Edit ${editingHospital.name}`} widthClass="max-w-xl">
          <form onSubmit={handleEditHospital} className="space-y-4">
            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
                {formError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Hospital Name</label>
              <input
                required
                value={editHospitalName}
                onChange={(e) => setEditHospitalName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Code</label>
              <input
                required
                value={editHospitalCode}
                onChange={(e) => setEditHospitalCode(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#5D2582] outline-none"
              />
            </div>
            <label className="flex items-center gap-3 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={editHospitalIsActive}
                onChange={(e) => setEditHospitalIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-[#5D2582] focus:ring-[#5D2582]"
              />
              Hospital is active
            </label>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowEditHospitalModal(false)}
                className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={formLoading}
                className="px-6 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1d68] disabled:opacity-50"
              >
                {formLoading ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {pendingHospitalAction && (
        <Modal onClose={() => setPendingHospitalAction(null)} title={`Delete or Disable ${pendingHospitalAction.name}`}>
          {formError && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
              {formError}
            </div>
          )}
          <p className="text-sm text-gray-600 mb-6">
            Choose whether to remove this hospital and all related data, or disable it and keep the data.
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={() => setPendingHospitalAction(null)}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDisableHospital()}
              disabled={formLoading}
              className="inline-flex items-center gap-2 px-4 py-2 border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-50 disabled:opacity-50"
            >
              <Ban className="w-4 h-4" />
              Disable only
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteHospital()}
              disabled={formLoading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Delete whole data
            </button>
          </div>
        </Modal>
      )}

      {pendingUserAction && (
        <Modal onClose={() => setPendingUserAction(null)} title={`Delete or Disable ${pendingUserAction.display_name}`}>
          {formError && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">
              {formError}
            </div>
          )}
          <p className="text-sm text-gray-600 mb-6">
            Choose whether to permanently delete this user or disable the account and block login.
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={() => setPendingUserAction(null)}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDisableUser()}
              disabled={formLoading}
              className="inline-flex items-center gap-2 px-4 py-2 border border-amber-300 text-amber-800 rounded-lg hover:bg-amber-50 disabled:opacity-50"
            >
              <Ban className="w-4 h-4" />
              Disable only
            </button>
            <button
              type="button"
              onClick={() => void handleDeleteUser()}
              disabled={formLoading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
