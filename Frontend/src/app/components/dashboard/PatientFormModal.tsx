import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { X } from 'lucide-react';
import { Modal } from './Modal';
import { TestPriorityFlag, Visit, TestCatalogItem } from '../../types';

const TEST_PRIORITY_OPTIONS: Array<{ value: TestPriorityFlag; label: string }> = [
  { value: 'NONE', label: 'No Priority' },
  { value: 'PRIORITY', label: 'Priority' },
  { value: 'HIGH_PRIORITY', label: 'High Priority' },
];

const patientSchema = z.object({
  patientName: z.string().min(2, 'Name is required'),
  patientAge: z.coerce.number().int().min(0, 'Age is required'),
  patientGender: z.enum(['Male', 'Female', 'Other']),
  priorityType: z.enum(['NORMAL', 'EMERGENCY']),
  phone: z.string().optional(),
  selectedTests: z.array(z.object({
    test_name: z.string().min(1),
    priority_flag: z.enum(['NONE', 'PRIORITY', 'HIGH_PRIORITY']),
  })).min(1, 'Select at least one test'),
});

export type PatientFormData = z.infer<typeof patientSchema>;

const defaultValues: PatientFormData = {
  patientName: '',
  patientAge: 0,
  patientGender: 'Male',
  priorityType: 'NORMAL',
  phone: '',
  selectedTests: [],
};

export function PatientFormModal({
  isOpen,
  onClose,
  editingPatient,
  testCatalog,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  editingPatient: Visit | null;
  testCatalog: TestCatalogItem[];
  onSave: (data: PatientFormData) => void | Promise<void>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PatientFormData>({
    resolver: zodResolver(patientSchema),
    defaultValues,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setIsPickerOpen(false);
    if (editingPatient) {
      reset({
        patientName: editingPatient.patient_name,
        patientAge: editingPatient.patient_age,
        patientGender: editingPatient.patient_gender,
        priorityType: editingPatient.priority_type === 'EMERGENCY' ? 'EMERGENCY' : 'NORMAL',
        phone: editingPatient.phone ?? '',
        selectedTests:
          editingPatient.test_details && editingPatient.test_details.length > 0
            ? editingPatient.test_details
            : editingPatient.tests.map((test_name) => ({ test_name, priority_flag: 'NONE' as const })),
      });
      return;
    }
    reset(defaultValues);
  }, [editingPatient, isOpen, reset]);

  const selectedTests = watch('selectedTests') ?? [];

  const filteredCatalog = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return testCatalog.filter((item) => {
      if (selectedTests.some((selected) => selected.test_name === item.test_name)) return false;
      if (!normalizedQuery) return true;
      return item.test_name.toLowerCase().includes(normalizedQuery);
    });
  }, [query, selectedTests, testCatalog]);

  if (!isOpen) return null;

  const addTest = (testName: string) => {
    if (selectedTests.some((selected) => selected.test_name === testName)) return;
    setValue('selectedTests', [...selectedTests, { test_name: testName, priority_flag: 'NONE' }], { shouldValidate: true, shouldDirty: true });
    setQuery('');
    setIsPickerOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const removeTest = (testName: string) => {
    setValue('selectedTests', selectedTests.filter((item) => item.test_name !== testName), { shouldValidate: true, shouldDirty: true });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const updateTestPriority = (testName: string, priorityFlag: TestPriorityFlag) => {
    setValue(
      'selectedTests',
      selectedTests.map((item) => (item.test_name === testName ? { ...item, priority_flag: priorityFlag } : item)),
      { shouldValidate: true, shouldDirty: true },
    );
  };

  const onSubmit = async (data: PatientFormData) => {
    await onSave(data);
  };

  return (
    <Modal onClose={onClose} title={editingPatient ? 'Edit Patient' : 'Add Patient'} widthClass="max-w-4xl">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-600 mb-1">Name</label>
            <input
              {...register('patientName')}
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
            />
            {errors.patientName && <p className="text-red-500 text-xs mt-1">{errors.patientName.message}</p>}
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Phone</label>
            <input
              {...register('phone')}
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Age</label>
            <input
              {...register('patientAge')}
              type="number"
              min="0"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
            />
            {errors.patientAge && <p className="text-red-500 text-xs mt-1">{errors.patientAge.message}</p>}
          </div>
          <div>
            <label className="block text-sm text-gray-600 mb-1">Gender</label>
            <select
              {...register('patientGender')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
            >
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm text-gray-600 mb-2">Priority</label>
          <div className="grid grid-cols-2 gap-3">
            <label className="border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-2 cursor-pointer">
              <input {...register('priorityType')} type="radio" value="NORMAL" />
              <span>Normal</span>
            </label>
            <label className="border border-gray-200 rounded-lg px-4 py-3 flex items-center gap-2 cursor-pointer">
              <input {...register('priorityType')} type="radio" value="EMERGENCY" />
              <span>Emergency</span>
            </label>
          </div>
        </div>

        <div className="relative">
          <label className="block text-sm text-gray-600 mb-2">Tests</label>
          <div
            className="min-h-[3.5rem] w-full rounded-xl border border-gray-200 px-3 py-2 focus-within:border-[#5D2582] focus-within:ring-2 focus-within:ring-[#5D2582]/20"
            onClick={() => inputRef.current?.focus()}
          >
            <div className="flex flex-wrap items-center gap-2">
              {selectedTests.map((test) => (
                <span key={test.test_name} className="inline-flex items-center gap-1 rounded-full bg-[#f3ebf7] px-3 py-1 text-sm text-[#5D2582]">
                  {test.test_name}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeTest(test.test_name);
                    }}
                    className="rounded-full p-0.5 hover:bg-[#e0d0ea]"
                    aria-label={`Remove ${test.test_name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIsPickerOpen(true);
                }}
                onFocus={() => setIsPickerOpen(true)}
                onBlur={() => window.setTimeout(() => setIsPickerOpen(false), 120)}
                onKeyDown={(event) => {
                  if (event.key === 'Backspace' && !query && selectedTests.length) {
                    removeTest(selectedTests[selectedTests.length - 1].test_name);
                  }
                }}
                placeholder={selectedTests.length ? 'Type to add another test' : 'Search tests'}
                className="min-w-[14rem] flex-1 border-0 bg-transparent px-1 py-1.5 text-sm text-gray-900 outline-none placeholder:text-gray-400"
              />
            </div>
          </div>
          {isPickerOpen && (
            <div className="absolute z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
              {filteredCatalog.length > 0 ? (
                filteredCatalog.slice(0, 150).map((item) => (
                  <button
                    key={item.test_code}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => addTest(item.test_name)}
                    className="block w-full border-b border-gray-100 px-4 py-3 text-left text-sm text-gray-700 transition-colors last:border-b-0 hover:bg-gray-50"
                  >
                    {item.test_name}
                  </button>
                ))
              ) : (
                <div className="px-4 py-3 text-sm text-gray-500">No tests found</div>
              )}
            </div>
          )}
          {errors.selectedTests && <p className="text-red-500 text-xs mt-1">{errors.selectedTests.message}</p>}
        </div>

        {selectedTests.length > 0 && (
          <div>
            <label className="block text-sm text-gray-600 mb-2">Test Priority Flags</label>
            <div className="space-y-3">
              {selectedTests.map((test) => (
                <div key={`priority-${test.test_name}`} className="grid grid-cols-[1.4fr_1fr] gap-3 rounded-lg border border-gray-200 p-3">
                  <div className="flex items-center text-sm text-gray-900">{test.test_name}</div>
                  <select
                    value={test.priority_flag}
                    onChange={(event) => updateTestPriority(test.test_name, event.target.value as TestPriorityFlag)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
                  >
                    {TEST_PRIORITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 bg-[#5D2582] text-white rounded-lg hover:bg-[#4a1e68] transition-colors disabled:opacity-60"
          >
            {editingPatient ? 'Save Changes' : 'Add Patient'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

