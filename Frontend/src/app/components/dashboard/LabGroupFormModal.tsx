import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Lab } from '../../types';

export function LabGroupFormModal({
  isOpen,
  onClose,
  labs,
  onSave,
}: {
  isOpen: boolean;
  onClose: () => void;
  labs: Lab[];
  onSave: (data: { name: string; category: string; lab_ids: string[] }) => void | Promise<void>;
}) {
  const availableLabs = useMemo(
    () => labs.filter((lab) => !lab.group_id).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })),
    [labs],
  );
  const categories = useMemo(
    () => [...new Set(availableLabs.map((lab) => lab.category))].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })),
    [availableLabs],
  );

  const [groupName, setGroupName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedLabIds, setSelectedLabIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setGroupName('');
    setSelectedCategory('');
    setSelectedLabIds([]);
    setError('');
  }, [isOpen]);

  const categoryLabs = useMemo(
    () => availableLabs.filter((lab) => !selectedCategory || lab.category === selectedCategory),
    [availableLabs, selectedCategory],
  );

  if (!isOpen) return null;

  const toggleLab = (labId: string) => {
    setSelectedLabIds((current) =>
      current.includes(labId) ? current.filter((id) => id !== labId) : [...current, labId],
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = groupName.trim();
    if (!trimmedName) {
      setError('Group name is required');
      return;
    }
    if (!selectedCategory) {
      setError('Category is required');
      return;
    }
    if (selectedLabIds.length < 2) {
      setError('Select at least two labs to create a group');
      return;
    }
    setError('');
    await onSave({
      name: trimmedName,
      category: selectedCategory,
      lab_ids: selectedLabIds,
    });
  };

  return (
    <Modal onClose={onClose} title="Create Lab Groups" widthClass="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-gray-600">Group Name</label>
          <input
            type="text"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
            placeholder="Blood Lab Group"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm text-gray-600">Lab Category</label>
          <select
            value={selectedCategory}
            onChange={(event) => {
              setSelectedCategory(event.target.value);
              setSelectedLabIds([]);
            }}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#5D2582]"
          >
            <option value="">Select category</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-2 block text-sm text-gray-600">Select Labs</label>
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-3">
            {selectedCategory ? (
              categoryLabs.length > 0 ? (
                categoryLabs.map((lab) => (
                  <label key={lab.id} className="flex cursor-pointer items-center justify-between rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50">
                    <div>
                      <p className="text-sm text-gray-900">{lab.name}</p>
                      <p className="text-xs text-gray-500">{lab.floor}</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={selectedLabIds.includes(lab.id)}
                      onChange={() => toggleLab(lab.id)}
                    />
                  </label>
                ))
              ) : (
                <div className="py-6 text-center text-sm text-gray-500">No ungrouped labs available in this category</div>
              )
            ) : (
              <div className="py-6 text-center text-sm text-gray-500">Choose a category to select labs</div>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-[#5D2582] px-4 py-2 text-white transition-colors hover:bg-[#4a1e68]"
          >
            Create Group
          </button>
        </div>
      </form>
    </Modal>
  );
}
