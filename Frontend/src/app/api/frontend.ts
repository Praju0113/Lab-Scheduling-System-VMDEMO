import { apiClient } from './client';
import { HospitalCatalogEntry, LimsConfigData, ServiceManagementData, TestCatalogItem, TestPriorityFlag, WaitingCandidate } from '../types';

export interface FrontendBootstrapResponse {
  visits: any[];
  labs: any[];
  groups: any[];
  specialists: any[];
}

export interface FrontendDeltaResponse {
  since?: Date | null;
  now: Date;
  visits: any[];
  labs: any[];
  groups: any[];
  specialists: any[];
  metrics: any;
}

const stripPrefixedId = (value?: string | null) => {
  if (!value) return null;
  return value.replace(/^[a-z]/i, '');
};

export interface CreateUserRequest {
  email: string;
  password: string;
  display_name: string;
  role: 'SuperAdmin' | 'Admin' | 'Receptionist' | 'LabSpecialist';
  hospital_id?: number | null;
  gender?: string;
  shift_start?: string;
  shift_end?: string;
}

export interface UpdateUserRequest {
  email: string;
  display_name: string;
  role: 'SuperAdmin' | 'Admin' | 'Receptionist' | 'LabSpecialist';
  hospital_id?: number | null;
  password?: string;
  gender?: string;
  shift_start?: string;
  shift_end?: string;
}

export interface UpdateHospitalRequest {
  name: string;
  code: string;
  is_active: boolean;
}

export const frontendApi = {
  bootstrap: async () => {
    const response = await apiClient.get<FrontendBootstrapResponse>('/frontend/bootstrap');
    return response.data;
  },
  delta: async (since?: Date | null) => {
    const response = await apiClient.get<FrontendDeltaResponse>('/frontend/delta', {
      params: since ? { since: since.toISOString() } : undefined,
    });
    return response.data;
  },
  adminDashboard: async () => {
    const response = await apiClient.get('/frontend/admin-dashboard');
    return response.data;
  },
  getTestCatalog: async () => {
    const response = await apiClient.get<{ items: TestCatalogItem[] }>('/frontend/test-catalog');
    return response.data.items;
  },
  getServiceManagement: async () => {
    const response = await apiClient.get<ServiceManagementData>('/frontend/service-management');
    return response.data;
  },
  createPatient: async (payload: {
    patient_name: string;
    patient_age: number;
    patient_gender: string;
    priority_type: string;
    phone: string;
    test_names: string[];
    test_details?: Array<{ test_name: string; priority_flag: TestPriorityFlag }>;
  }) => {
    const response = await apiClient.post('/frontend/patients', payload);
    return response.data;
  },
  updatePatient: async (visitId: string, payload: {
    patient_name: string;
    patient_age: number;
    patient_gender: string;
    priority_type: string;
    phone: string;
    test_names: string[];
    test_details?: Array<{ test_name: string; priority_flag: TestPriorityFlag }>;
  }) => {
    const response = await apiClient.patch(`/frontend/patients/${visitId}`, payload);
    return response.data;
  },
  createSpecialist: async (payload: {
    name: string;
    email: string;
    password: string;
    gender: string;
    shift_start: string;
    shift_end: string;
  }) => {
    const response = await apiClient.post('/receptionist/lab-specialists', {
      email: payload.email,
      password: payload.password,
      display_name: payload.name,
      role: 'LabSpecialist',
      gender: payload.gender,
      shift_start: `${payload.shift_start}:00`,
      shift_end: `${payload.shift_end}:00`,
    });
    return response.data;
  },
  updateSpecialist: async (specialistId: string, payload: {
    name: string;
    gender: string;
    shift_start: string;
    shift_end: string;
  }) => {
    const response = await apiClient.patch(`/specialists/${stripPrefixedId(specialistId)}`, {
      name: payload.name,
      gender: payload.gender,
      shift_start: `${payload.shift_start}:00`,
      shift_end: `${payload.shift_end}:00`,
      is_active: true,
    });
    return response.data;
  },
  deleteSpecialist: async (specialistId: string) => {
    const response = await apiClient.delete(`/specialists/${stripPrefixedId(specialistId)}`);
    return response.data;
  },
  listAdminUsers: async () => {
    const response = await apiClient.get('/admin/users');
    return response.data;
  },
  createAdminUser: async (payload: CreateUserRequest) => {
    const response = await apiClient.post('/admin/users', payload);
    return response.data;
  },
  createSuperAdminUser: async (payload: CreateUserRequest) => {
    const response = await apiClient.post('/super-admin/users', payload);
    return response.data;
  },
  updateSuperAdminUser: async (userId: number, payload: UpdateUserRequest) => {
    const response = await apiClient.patch(`/super-admin/users/${userId}`, payload);
    return response.data;
  },
  updateSuperAdminHospital: async (hospitalId: number, payload: UpdateHospitalRequest) => {
    const response = await apiClient.patch(`/super-admin/hospitals/${hospitalId}`, payload);
    return response.data;
  },
  deleteSuperAdminHospital: async (hospitalId: number) => {
    const response = await apiClient.delete(`/super-admin/hospitals/${hospitalId}`);
    return response.data;
  },
  disableSuperAdminHospital: async (hospitalId: number) => {
    const response = await apiClient.post(`/super-admin/hospitals/${hospitalId}/disable`);
    return response.data;
  },
  enableSuperAdminHospital: async (hospitalId: number) => {
    const response = await apiClient.post(`/super-admin/hospitals/${hospitalId}/enable`);
    return response.data;
  },
  deleteSuperAdminUser: async (userId: number) => {
    const response = await apiClient.delete(`/super-admin/users/${userId}`);
    return response.data;
  },
  disableSuperAdminUser: async (userId: number) => {
    const response = await apiClient.post(`/super-admin/users/${userId}/disable`);
    return response.data;
  },
  enableSuperAdminUser: async (userId: number) => {
    const response = await apiClient.post(`/super-admin/users/${userId}/enable`);
    return response.data;
  },
  createLab: async (payload: {
    name: string;
    category: string;
    floor: string;
    opening_time: string;
    closing_time: string;
    specialist_id?: string | null;
    is_active: boolean;
  }) => {
    const response = await apiClient.post('/labs', {
      name: payload.name,
      category: payload.category,
      floor: payload.floor,
      room_number: payload.name.replace(/\s+/g, '-').slice(0, 32) || 'AUTO',
      opening_time: `${payload.opening_time}:00`,
      closing_time: `${payload.closing_time}:00`,
      cleanup_duration_minutes: 0,
      is_active: payload.is_active,
      specialist_id: stripPrefixedId(payload.specialist_id) ? Number(stripPrefixedId(payload.specialist_id)) : null,
    });
    return response.data;
  },
  updateLab: async (
    labId: string,
    payload: {
      name: string;
      category: string;
      floor: string;
      opening_time: string;
      closing_time: string;
      specialist_id?: string | null;
      is_active: boolean;
    }
  ) => {
    const response = await apiClient.patch(`/labs/${stripPrefixedId(labId)}`, {
      name: payload.name,
      category: payload.category,
      floor: payload.floor,
      opening_time: `${payload.opening_time}:00`,
      closing_time: `${payload.closing_time}:00`,
      is_active: payload.is_active,
      specialist_id: stripPrefixedId(payload.specialist_id) ? Number(stripPrefixedId(payload.specialist_id)) : null,
    });
    return response.data;
  },
  deleteLab: async (labId: string) => {
    const response = await apiClient.delete(`/labs/${stripPrefixedId(labId)}`);
    return response.data;
  },
  createLabGroup: async (payload: {
    name: string;
    category: string;
    lab_ids: string[];
  }) => {
    const response = await apiClient.post('/lab-groups', {
      name: payload.name,
      category: payload.category,
      lab_ids: payload.lab_ids.map((labId) => Number(stripPrefixedId(labId))),
    });
    return response.data as { group: any; labs: any[] };
  },
  getWaitingCandidates: async (labId: string) => {
    const response = await apiClient.get<{ lab_id: string; items: WaitingCandidate[] }>(`/labs/${stripPrefixedId(labId)}/waiting-candidates`);
    return response.data;
  },
  getQueueSnapshot: async (labId: string) => {
    const response = await apiClient.get(`/queues/${stripPrefixedId(labId)}`);
    return response.data;
  },
  acceptCurrent: async (labId: string) => {
    const response = await apiClient.post(`/queues/${stripPrefixedId(labId)}/accept-current`);
    return response.data;
  },
  moveCurrentToPending: async (labId: string) => {
    const response = await apiClient.post(`/queues/${stripPrefixedId(labId)}/move-current-to-pending`);
    return response.data;
  },
  moveNextToPending: async (labId: string) => {
    const response = await apiClient.post(`/queues/${stripPrefixedId(labId)}/move-next-to-pending`);
    return response.data;
  },
  acceptFromPending: async (labId: string, visit_test_id?: number) => {
    const response = await apiClient.post(
      `/queues/${stripPrefixedId(labId)}/accept-from-pending`,
      typeof visit_test_id === 'number' ? { visit_test_id } : {}
    );
    return response.data;
  },
  completeCurrent: async (labId: string) => {
    const response = await apiClient.post(`/queues/${stripPrefixedId(labId)}/complete-current`);
    return response.data;
  },
  seedLimsPatients: async () => {
    const response = await apiClient.post('/seed/lims-patients', {});
    return response.data;
  },
  seedMockSpecialists: async () => {
    const response = await apiClient.post('/seed/specialists', {});
    return response.data;
  },
  seedMockLabs: async () => {
    const response = await apiClient.post('/seed/labs', {});
    return response.data;
  },

  // Hospital Catalog CRUD
  getHospitalCatalog: async () => {
    const response = await apiClient.get<HospitalCatalogEntry[]>('/hospital-catalog');
    return response.data;
  },
  getGlobalCatalog: async () => {
    const response = await apiClient.get<TestCatalogItem[]>('/hospital-catalog/global');
    return response.data;
  },
  bulkImportCatalog: async (test_codes: string[]) => {
    const response = await apiClient.post('/hospital-catalog/bulk-import', { test_codes });
    return response.data;
  },
  importAllCatalog: async () => {
    const response = await apiClient.post('/hospital-catalog/import-all');
    return response.data;
  },
  updateCatalogEntry: async (test_code: string, payload: { duration_minutes?: number; is_active?: boolean }) => {
    const response = await apiClient.patch(`/hospital-catalog/${test_code}`, payload);
    return response.data;
  },
  deleteCatalogEntry: async (test_code: string) => {
    const response = await apiClient.delete(`/hospital-catalog/${test_code}`);
    return response.data;
  },

  // Dependency CRUD
  getDependencies: async () => {
    const response = await apiClient.get('/dependencies');
    return response.data;
  },
  createDependency: async (payload: { test_code: string; depends_on_test_code: string; dependency_type?: string; is_strict?: boolean }) => {
    const response = await apiClient.post('/dependencies', payload);
    return response.data;
  },
  deleteDependency: async (depId: number) => {
    const response = await apiClient.delete(`/dependencies/${depId}`);
    return response.data;
  },

  // LIMS Config (SuperAdmin)
  getLimsConfig: async (hospitalId: number) => {
    const response = await apiClient.get<LimsConfigData>(`/super-admin/hospitals/${hospitalId}/lims-config`);
    return response.data;
  },
  saveLimsConfig: async (hospitalId: number, payload: { callback_url: string | null; is_enabled: boolean }) => {
    const response = await apiClient.post(`/super-admin/hospitals/${hospitalId}/lims-config`, payload);
    return response.data;
  },
  regenerateLimsKey: async (hospitalId: number) => {
    const response = await apiClient.post<{ api_key: string }>(`/super-admin/hospitals/${hospitalId}/lims-config/regenerate-key`);
    return response.data;
  },
};
